import { GEM_DEFS, PARAMS, TOOL_DEFS, type LayerIndex } from "./data.js";
import { cellKey, centerCell, inLayer, neighbors, parseCell, wellCells, type CellKey } from "./hex.js";
import type { GameState, Gem, Link, PlayerState } from "./types.js";

// ---------- 背包 ----------

export function gemSlots(gem: Gem): number {
  return gem.heavy ? 2 : 1;
}

export function usedSlots(state: GameState, player: PlayerState): number {
  return player.tools.length + player.bag.reduce((sum, id) => sum + gemSlots(state.gems[id]!), 0);
}

export function freeSlots(state: GameState, player: PlayerState): number {
  return PARAMS.bagSlots - usedSlots(state, player);
}

export function hasTool(player: PlayerState, kind: keyof typeof TOOL_DEFS): boolean {
  return player.tools.some((tool) => tool.kind === kind);
}

/** 没被封印盒压住的诅咒宝石数量。 */
export function activeCurses(state: GameState, player: PlayerState): number {
  const cursed = player.bag.filter((id) => GEM_DEFS[state.gems[id]!.kind].trait === "curse" && !state.gems[id]!.cut).length;
  const seals = player.tools.filter((tool) => tool.kind === "seal").length;
  return Math.max(0, cursed - seals);
}

/** 移动力 = 空余格数 + 2，限定 2–8；每颗生效的诅咒宝石 −2，最低 1。 */
export function movePoints(state: GameState, player: PlayerState): number {
  const base = Math.min(PARAMS.maxMove, Math.max(PARAMS.minMove, freeSlots(state, player) + PARAMS.moveBonus));
  return Math.max(1, base - 2 * activeCurses(state, player));
}

// ---------- 地形 ----------

export function isCollapsed(state: GameState, layer: LayerIndex): boolean {
  return state.collapsedLayers.includes(layer);
}

/** 岩壁里还嵌着宝石的格子。 */
export function wallGemAt(state: GameState, cell: CellKey): Gem | undefined {
  return Object.values(state.gems).find((gem) => gem.location.type === "wall" && gem.location.cell === cell);
}

export function groundGemsAt(state: GameState, cell: CellKey): Gem[] {
  return Object.values(state.gems).filter((gem) => gem.location.type === "ground" && gem.location.cell === cell);
}

export function isPassable(state: GameState, cell: CellKey): boolean {
  const pos = parseCell(cell);
  return inLayer(pos.layer, pos) && !isCollapsed(state, pos.layer) && !wallGemAt(state, cell);
}

export function linkAt(state: GameState, upper: number, q: number, r: number): Link | undefined {
  return state.links.find((link) => link.upper === upper && link.q === q && link.r === r);
}

export function isWell(cell: CellKey): number {
  return wellCells().indexOf(cell);
}

export function isElevatorCell(cell: CellKey): boolean {
  const pos = parseCell(cell);
  return cell === centerCell(pos.layer);
}

// ---------- 移动 ----------

export interface Step {
  readonly to: CellKey;
  readonly cost: number;
  /** 从洞口跳下（没带绳索会随机损坏一件工具）。 */
  readonly hole: boolean;
}

/** 从某格出发、一步能到的格子及代价。 */
export function stepsFrom(state: GameState, player: PlayerState, from: CellKey): Step[] {
  const steps: Step[] = [];
  for (const next of neighbors(from)) {
    if (isPassable(state, next)) steps.push({ to: next, cost: 1, hole: false });
  }
  const { layer, q, r } = parseCell(from);
  const rope = hasTool(player, "rope");
  // 往下：梯子或洞口
  if (layer < 2) {
    const link = linkAt(state, layer, q, r);
    const below = cellKey((layer + 1) as LayerIndex, q, r);
    if (link && isPassable(state, below)) steps.push({ to: below, cost: 1, hole: link.kind === "hole" });
  }
  // 往上：只有梯子
  if (layer > 0) {
    const link = linkAt(state, layer - 1, q, r);
    const above = cellKey((layer - 1) as LayerIndex, q, r);
    const full = freeSlots(state, player) <= 0;
    if (link?.kind === "ladder" && isPassable(state, above) && (rope || !full)) {
      steps.push({ to: above, cost: rope ? PARAMS.ladderUpCostWithRope : PARAMS.ladderUpCost, hole: false });
    }
  }
  return steps;
}

export interface Reach {
  readonly cost: number;
  readonly prev?: CellKey;
}

/** 本回合能走到的所有格子（Dijkstra），含起点。 */
export function reachableCells(state: GameState, player: PlayerState): Map<CellKey, Reach> {
  const reach = new Map<CellKey, Reach>();
  if (player.status !== "mine" || !player.cell) return reach;
  const budget = movePoints(state, player);
  reach.set(player.cell, { cost: 0 });
  const frontier: CellKey[] = [player.cell];
  while (frontier.length > 0) {
    frontier.sort((a, b) => reach.get(a)!.cost - reach.get(b)!.cost);
    const cell = frontier.shift()!;
    const base = reach.get(cell)!.cost;
    for (const step of stepsFrom(state, player, cell)) {
      const cost = base + step.cost;
      if (cost > budget) continue;
      const known = reach.get(step.to);
      if (known && known.cost <= cost) continue;
      reach.set(step.to, { cost, prev: cell });
      frontier.push(step.to);
    }
  }
  return reach;
}

/** 由 reachableCells 的结果还原出到 target 的路径（不含起点）。 */
export function pathTo(reach: Map<CellKey, Reach>, target: CellKey): CellKey[] | null {
  if (!reach.has(target)) return null;
  const path: CellKey[] = [];
  let cell: CellKey | undefined = target;
  while (cell && reach.get(cell)?.prev !== undefined) {
    path.unshift(cell);
    cell = reach.get(cell)!.prev;
  }
  return path;
}

/** 校验一条路径；合法时返回总代价和途经的洞口数，否则返回错误说明。 */
export function checkPath(
  state: GameState,
  player: PlayerState,
  path: readonly CellKey[],
): { ok: true; cost: number; holes: number } | { ok: false; error: string } {
  if (player.status !== "mine" || !player.cell) return { ok: false, error: "你不在矿洞里。" };
  if (path.length === 0) return { ok: false, error: "请选择要去的格子。" };
  // 每一步至少花 1 点，步数超过移动力就不用逐步检查了。
  if (path.length > movePoints(state, player)) return { ok: false, error: "移动力不够。" };
  let cell = player.cell;
  let cost = 0;
  let holes = 0;
  for (const next of path) {
    const step = stepsFrom(state, player, cell).find((candidate) => candidate.to === next);
    if (!step) return { ok: false, error: "路径走不通。" };
    cost += step.cost;
    if (step.hole) holes += 1;
    cell = next;
  }
  if (cost > movePoints(state, player)) return { ok: false, error: "移动力不够。" };
  return { ok: true, cost, holes };
}

/** 站在 cell 上能挖到的岩壁宝石（同层相邻）。 */
export function diggableGems(state: GameState, cell: CellKey): Gem[] {
  return neighbors(cell)
    .map((next) => wallGemAt(state, next))
    .filter((gem): gem is Gem => gem !== undefined);
}

/** 这件工具能不能挖这颗宝石。 */
export function toolCanDig(gem: Gem, toolKind: keyof typeof TOOL_DEFS): boolean {
  const def = GEM_DEFS[gem.kind];
  if (toolKind === "dynamite") return def.trait !== "resonance";
  return def.tools.includes(toolKind);
}
