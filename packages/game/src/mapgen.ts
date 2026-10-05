import {
  GEM_DEFS,
  GEM_KINDS,
  LAYER0_SECTOR_GEMS,
  LAYER_DEFS,
  LAYER_GEM_WEIGHTS,
  PARAMS,
  type GemKind,
  type LayerIndex,
} from "./data.js";
import {
  cellKey,
  hexDistance,
  layerCells,
  neighbors,
  parseCell,
  sectorOf,
  wellCells,
  type CellKey,
  type Hex,
} from "./hex.js";
import { createRng, type Rng } from "./rng.js";
import type { Gem, Link } from "./types.js";

/**
 * v1 地图：三层全是通道（"平整"），只有嵌着宝石的格子是岩壁，挖空后变通道。
 * 宝石位置随机，但满足：
 * - 中心电梯格及一圈、井口及其相邻格、梯子和洞口所在格都不放宝石；
 * - 宝石之间互不相邻（不会围出死路），价值 10 以上的宝石至少隔 3 格；
 * - 第一层每个扇区都是 2 颗青砂玉 + 1 颗赤铁晶，且从每个井口出发 8 格内可挖的
 *   宝石总价值相差不超过 20%。
 */
export interface GeneratedMap {
  readonly gems: Gem[];
  readonly links: Link[];
  readonly enabledKinds: GemKind[];
}

const MAX_ATTEMPTS = 500;
const FAIRNESS_RADIUS = 8;
const FAIRNESS_TOLERANCE = 0.2;
const HIGH_VALUE = 10;

export function generateMap(seed: number): GeneratedMap {
  const rng = createRng(seed);
  const specials = GEM_KINDS.filter((kind) => !GEM_DEFS[kind].basic);
  const enabledKinds = [
    ...GEM_KINDS.filter((kind) => GEM_DEFS[kind].basic),
    ...rng.shuffle(specials).slice(0, PARAMS.specialGemsEnabled),
  ];

  const links = placeLinks(rng);
  const gems: Gem[] = [];
  let nextId = 1;
  const makeGem = (kind: GemKind, layer: LayerIndex, cell: CellKey): Gem => {
    const def = GEM_DEFS[kind];
    return {
      id: `g${nextId++}`,
      kind,
      color: def.color,
      layer,
      value: def.value,
      hardness: def.hardness,
      heavy: def.trait === "heavy",
      cut: false,
      location: { type: "wall", cell },
      progress: 0,
      contributions: {},
      decaySkipped: false,
    };
  };

  for (const layer of [0, 1, 2] as const) {
    const placed = placeLayer(rng, layer, links, enabledKinds);
    for (const { kind, cell } of placed) gems.push(makeGem(kind, layer, cell));
  }
  return { gems, links, enabledKinds };
}

function placeLinks(rng: Rng): Link[] {
  const links: Link[] = [];
  const used: Hex[] = [];
  for (const upper of [0, 1] as const) {
    const lower = (upper + 1) as LayerIndex;
    const candidates = rng.shuffle(
      layerCells(lower)
        .map(parseCell)
        .filter((hex) => hexDistance(hex, { q: 0, r: 0 }) >= 2),
    );
    const kinds = ["ladder", "ladder", "hole"] as const;
    const sectors = new Set<number>();
    for (const kind of kinds) {
      // 尽量分散到不同扇区，且彼此不相邻。
      const pick = candidates.find((hex) =>
        !sectors.has(sectorOf(hex)) && used.every((other) => hexDistance(hex, other) >= 2),
      ) ?? candidates.find((hex) => used.every((other) => hexDistance(hex, other) >= 2));
      if (!pick) throw new Error("无法放置跨层通路");
      sectors.add(sectorOf(pick));
      used.push(pick);
      links.push({ kind, upper, q: pick.q, r: pick.r });
    }
  }
  return links;
}

function reservedCells(layer: LayerIndex, links: Link[]): Set<CellKey> {
  const reserved = new Set<CellKey>();
  const center = cellKey(layer, 0, 0);
  reserved.add(center);
  for (const cell of neighbors(center)) reserved.add(cell);
  for (const link of links) {
    if (link.upper === layer || link.upper + 1 === layer) reserved.add(cellKey(layer, link.q, link.r));
  }
  if (layer === 0) {
    for (const well of wellCells()) {
      reserved.add(well);
      for (const cell of neighbors(well)) reserved.add(cell);
    }
  }
  return reserved;
}

interface Placement {
  readonly kind: GemKind;
  readonly cell: CellKey;
}

function placeLayer(rng: Rng, layer: LayerIndex, links: Link[], enabledKinds: GemKind[]): Placement[] {
  const reserved = reservedCells(layer, links);
  const candidates = layerCells(layer).filter((cell) => !reserved.has(cell));
  let best: { placements: Placement[]; spread: number } | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const kinds = layer === 0 ? [] : drawKinds(rng, layer, enabledKinds);
    const placements = layer === 0
      ? placeBySector(rng, candidates)
      : placeFreely(rng, candidates, kinds);
    if (!placements || !isConnected(layer, placements)) continue;
    if (layer !== 0) return placements;
    const spread = wellFairnessSpread(placements);
    if (!best || spread < best.spread) best = { placements, spread };
    if (spread <= FAIRNESS_TOLERANCE) return placements;
  }
  if (best) return best.placements;
  throw new Error(`第 ${layer + 1} 层无法生成宝石布局`);
}

function drawKinds(rng: Rng, layer: 1 | 2, enabledKinds: GemKind[]): GemKind[] {
  const weights = Object.entries(LAYER_GEM_WEIGHTS[layer])
    .filter(([kind]) => enabledKinds.includes(kind as GemKind)) as [GemKind, number][];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  return Array.from({ length: LAYER_DEFS[layer].gemCount }, () => {
    let roll = rng.next() * total;
    for (const [kind, weight] of weights) {
      roll -= weight;
      if (roll < 0) return kind;
    }
    return weights[weights.length - 1]![0];
  });
}

function canPlace(cell: CellKey, kind: GemKind, placed: Placement[]): boolean {
  const hex = parseCell(cell);
  const high = GEM_DEFS[kind].value >= HIGH_VALUE;
  return placed.every((other) => {
    const distance = hexDistance(hex, parseCell(other.cell));
    const minDistance = high && GEM_DEFS[other.kind].value >= HIGH_VALUE && hex.layer !== 2 ? 3 : 2;
    return distance >= minDistance;
  });
}

function placeFreely(rng: Rng, candidates: CellKey[], kinds: GemKind[]): Placement[] | null {
  const placed: Placement[] = [];
  // 先放高价值的，间距要求更严。
  const ordered = [...kinds].sort((a, b) => GEM_DEFS[b].value - GEM_DEFS[a].value);
  const pool = rng.shuffle(candidates);
  for (const kind of ordered) {
    const cell = pool.find((candidate) => canPlace(candidate, kind, placed));
    if (!cell) return null;
    placed.push({ kind, cell });
    pool.splice(pool.indexOf(cell), 1);
  }
  return placed;
}

function placeBySector(rng: Rng, candidates: CellKey[]): Placement[] | null {
  const placed: Placement[] = [];
  for (let sector = 0; sector < 6; sector += 1) {
    const pool = rng.shuffle(candidates.filter((cell) => sectorOf(parseCell(cell)) === sector));
    for (const kind of LAYER0_SECTOR_GEMS) {
      const cell = pool.find((candidate) => canPlace(candidate, kind, placed));
      if (!cell) return null;
      placed.push({ kind, cell });
      pool.splice(pool.indexOf(cell), 1);
    }
  }
  return placed;
}

function isConnected(layer: LayerIndex, placements: Placement[]): boolean {
  const walls = new Set(placements.map((placement) => placement.cell));
  const open = layerCells(layer).filter((cell) => !walls.has(cell));
  const start = cellKey(layer, 0, 0);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cell = queue.shift()!;
    for (const next of neighbors(cell)) {
      if (walls.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size === open.length;
}

/** 各井口 8 格路程内可挖宝石总价值的 (最大 − 最小) / 最大。 */
export function wellFairnessSpread(placements: Placement[]): number {
  const walls = new Set(placements.map((placement) => placement.cell));
  const totals = wellCells().map((well) => {
    const distance = new Map([[well, 0]]);
    const queue = [well];
    while (queue.length > 0) {
      const cell = queue.shift()!;
      const d = distance.get(cell)!;
      if (d >= FAIRNESS_RADIUS) continue;
      for (const next of neighbors(cell)) {
        if (walls.has(next) || distance.has(next)) continue;
        distance.set(next, d + 1);
        queue.push(next);
      }
    }
    return placements
      .filter((placement) => neighbors(placement.cell).some((cell) => distance.has(cell)))
      .reduce((sum, placement) => sum + GEM_DEFS[placement.kind].value, 0);
  });
  const max = Math.max(...totals);
  return max === 0 ? 0 : (max - Math.min(...totals)) / max;
}
