// 机器人用的寻路。规则和引擎 movement.ts 的 stepsFrom 一致，但一次算出整张图的距离，
// 不受本回合移动力限制，用来估算"几回合能到"。

import { cellKey, neighbors, wellCells, type CellKey, type GameState, type LayerIndex } from "@jingmai/game";

/** 同层相邻格：地图几何固定，只算一次。 */
const NEIGHBOR_CACHE = new Map<CellKey, CellKey[]>();
export function adjacent(cell: CellKey): CellKey[] {
  let list = NEIGHBOR_CACHE.get(cell);
  if (!list) {
    list = neighbors(cell);
    NEIGHBOR_CACHE.set(cell, list);
  }
  return list;
}

export const WELLS: readonly CellKey[] = wellCells();
export const layerOf = (cell: CellKey): LayerIndex => (cell.charCodeAt(0) - 48) as LayerIndex;

export interface Terrain {
  readonly walls: Set<CellKey>;
  readonly collapsed: Set<number>;
  /** 上层格 → 往下的通路（梯子或洞口都能下）。 */
  readonly down: Map<CellKey, { readonly to: CellKey; readonly hole: boolean }>;
  /** 下层格 → 往上的梯子（洞口不能往上）。 */
  readonly up: Map<CellKey, CellKey>;
  /** 反向：下层格 → 能下到这里的上层格。 */
  readonly downFrom: Map<CellKey, CellKey>;
  /** 反向：上层格 → 能爬上来的下层格。 */
  readonly upFrom: Map<CellKey, CellKey>;
}

export function terrainOf(state: GameState): Terrain {
  const walls = new Set<CellKey>();
  for (const gem of Object.values(state.gems)) {
    if (gem.location.type === "wall") walls.add(gem.location.cell);
  }
  const down = new Map<CellKey, { to: CellKey; hole: boolean }>();
  const up = new Map<CellKey, CellKey>();
  const downFrom = new Map<CellKey, CellKey>();
  const upFrom = new Map<CellKey, CellKey>();
  for (const link of state.links) {
    const upper = cellKey(link.upper, link.q, link.r);
    const lower = cellKey((link.upper + 1) as LayerIndex, link.q, link.r);
    down.set(upper, { to: lower, hole: link.kind === "hole" });
    downFrom.set(lower, upper);
    if (link.kind === "ladder") {
      up.set(lower, upper);
      upFrom.set(upper, lower);
    }
  }
  return { walls, collapsed: new Set(state.collapsedLayers), down, up, downFrom, upFrom };
}

export function passable(terrain: Terrain, cell: CellKey): boolean {
  return !terrain.collapsed.has(layerOf(cell)) && !terrain.walls.has(cell);
}

/** 影响走法的两点：带没带绳索（上梯 1 格）、背包满没满（满载没绳索爬不了梯子）。 */
export interface Mover {
  readonly rope: boolean;
  readonly full: boolean;
}

const UP_COST = 3;

/** 从 from 一步能到哪些格，代价多少。 */
export function forEachStep(terrain: Terrain, mover: Mover, from: CellKey, visit: (to: CellKey, cost: number) => void): void {
  for (const next of adjacent(from)) if (passable(terrain, next)) visit(next, 1);
  const down = terrain.down.get(from);
  if (down && passable(terrain, down.to)) visit(down.to, 1);
  const up = terrain.up.get(from);
  if (up && passable(terrain, up) && (mover.rope || !mover.full)) visit(up, mover.rope ? 1 : UP_COST);
}

/** 最小堆，按距离出队。 */
class Heap {
  private readonly items: { cell: CellKey; cost: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(cell: CellKey, cost: number): void {
    const items = this.items;
    items.push({ cell, cost });
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent]!.cost <= cost) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = { cell, cost };
  }
  pop(): { cell: CellKey; cost: number } {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child = right < items.length && items[right]!.cost < items[left]!.cost ? right : left;
        if (items[child]!.cost >= last.cost) break;
        items[index] = items[child]!;
        index = child;
      }
      items[index] = last;
    }
    return top;
  }
}

export interface Field {
  readonly dist: Map<CellKey, number>;
  readonly prev: Map<CellKey, CellKey>;
}

/** 从 start 出发到每一格的最小代价（Dijkstra）。 */
export function forwardField(terrain: Terrain, mover: Mover, start: CellKey): Field {
  const dist = new Map<CellKey, number>([[start, 0]]);
  const prev = new Map<CellKey, CellKey>();
  const heap = new Heap();
  heap.push(start, 0);
  while (heap.size > 0) {
    const { cell, cost } = heap.pop();
    if (cost > dist.get(cell)!) continue;
    forEachStep(terrain, mover, cell, (to, step) => {
      const next = cost + step;
      const known = dist.get(to);
      if (known !== undefined && known <= next) return;
      dist.set(to, next);
      prev.set(to, cell);
      heap.push(to, next);
    });
  }
  return { dist, prev };
}

/** 每一格回到最近井口的最小代价（从井口反向搜索）。 */
export function homeField(terrain: Terrain, mover: Mover): Map<CellKey, number> {
  const dist = new Map<CellKey, number>();
  const heap = new Heap();
  for (const well of WELLS) {
    if (!passable(terrain, well)) continue;
    dist.set(well, 0);
    heap.push(well, 0);
  }
  const relax = (from: CellKey, cost: number) => {
    const known = dist.get(from);
    if (known !== undefined && known <= cost) return;
    dist.set(from, cost);
    heap.push(from, cost);
  };
  while (heap.size > 0) {
    const { cell, cost } = heap.pop();
    if (cost > dist.get(cell)!) continue;
    // 谁能一步走到 cell：同层邻格、正上方（下梯/跳洞）、正下方（爬梯）。
    for (const from of adjacent(cell)) if (passable(terrain, from)) relax(from, cost + 1);
    const above = terrain.downFrom.get(cell);
    if (above && passable(terrain, above)) relax(above, cost + 1);
    const below = terrain.upFrom.get(cell);
    if (below && passable(terrain, below) && (mover.rope || !mover.full)) relax(below, cost + (mover.rope ? 1 : UP_COST));
  }
  return dist;
}

/** 由 forwardField 还原到 target 的路径（不含起点）。 */
export function pathTo(field: Field, target: CellKey): CellKey[] {
  const path: CellKey[] = [];
  let cell: CellKey | undefined = target;
  while (cell !== undefined && field.prev.has(cell)) {
    path.unshift(cell);
    cell = field.prev.get(cell);
  }
  return path;
}

/** 沿着回井口代价下降的方向走出一条路（不含起点）。 */
export function pathHome(terrain: Terrain, mover: Mover, home: Map<CellKey, number>, start: CellKey): CellKey[] {
  const path: CellKey[] = [];
  let cell = start;
  for (let guard = 0; guard < 400 && (home.get(cell) ?? Infinity) > 0; guard += 1) {
    let best: CellKey | undefined;
    let bestScore = Infinity;
    forEachStep(terrain, mover, cell, (to, cost) => {
      const score = cost + (home.get(to) ?? Infinity);
      if (score < bestScore) {
        bestScore = score;
        best = to;
      }
    });
    if (best === undefined || bestScore === Infinity) break;
    path.push(best);
    cell = best;
  }
  return path;
}

/** 路径代价（逐步累加）。 */
export function stepCosts(terrain: Terrain, mover: Mover, start: CellKey, path: readonly CellKey[]): number[] {
  const costs: number[] = [];
  let cell = start;
  for (const next of path) {
    let found = Infinity;
    forEachStep(terrain, mover, cell, (to, cost) => {
      if (to === next && cost < found) found = cost;
    });
    costs.push(found);
    cell = next;
  }
  return costs;
}
