import { LAYER_DEFS, type LayerIndex } from "./data.js";

/** 轴向坐标 (q, r)。三层中心对齐，同一 (q, r) 上下对应。 */
export interface Hex {
  readonly q: number;
  readonly r: number;
}

/** 格子的字符串键："层:q:r"。 */
export type CellKey = string;

export interface CellPos extends Hex {
  readonly layer: LayerIndex;
}

export const HEX_DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function cellKey(layer: LayerIndex, q: number, r: number): CellKey {
  // 避免出现 "-0"
  return `${layer}:${q + 0}:${r + 0}`;
}

export function parseCell(key: CellKey): CellPos {
  const [layer, q, r] = key.split(":").map(Number) as [number, number, number];
  return { layer: layer as LayerIndex, q, r };
}

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function inLayer(layer: LayerIndex, hex: Hex): boolean {
  return hexDistance(hex, { q: 0, r: 0 }) <= LAYER_DEFS[layer].radius;
}

/** 同层相邻的格子。 */
export function neighbors(key: CellKey): CellKey[] {
  const { layer, q, r } = parseCell(key);
  return HEX_DIRECTIONS
    .map((d) => ({ q: q + d.q, r: r + d.r }))
    .filter((hex) => inLayer(layer, hex))
    .map((hex) => cellKey(layer, hex.q, hex.r));
}

export function layerCells(layer: LayerIndex): CellKey[] {
  const radius = LAYER_DEFS[layer].radius;
  const cells: CellKey[] = [];
  for (let q = -radius; q <= radius; q += 1) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r += 1) {
      cells.push(cellKey(layer, q, r));
    }
  }
  return cells;
}

export function centerCell(layer: LayerIndex): CellKey {
  return cellKey(layer, 0, 0);
}

/** 第一层 6 条边的中点，即 6 个井口；顶层半径必须是偶数。 */
export function wellCells(): CellKey[] {
  const radius = LAYER_DEFS[0].radius;
  const corners = HEX_DIRECTIONS.map((d) => ({ q: d.q * radius, r: d.r * radius }));
  return corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length]!;
    return cellKey(0, (corner.q + next.q) / 2, (corner.r + next.r) / 2);
  });
}

/** 尖顶六边形的像素坐标（单位边长）。 */
export function hexToPixel(hex: Hex): { x: number; y: number } {
  return { x: Math.sqrt(3) * (hex.q + hex.r / 2), y: 1.5 * hex.r };
}

/** 格子属于哪个井口的扇区（0–5）：按方向角离哪个井口最近划分。 */
export function sectorOf(hex: Hex): number {
  const wells = wellCells().map(parseCell);
  const { x, y } = hexToPixel(hex);
  const angle = Math.atan2(y, x);
  let best = 0;
  let bestDiff = Infinity;
  wells.forEach((well, index) => {
    const p = hexToPixel(well);
    let diff = Math.abs(Math.atan2(p.y, p.x) - angle);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff < bestDiff - 1e-9) {
      bestDiff = diff;
      best = index;
    }
  });
  return best;
}
