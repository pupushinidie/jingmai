// 人机「普通」：像一个认真玩、会算账的普通玩家。只看自己座位的视图（redactGameForViewer 之后的状态）。
//
// 打法：开局留下好凑的两张私人订单，带钻 + 凿 + 绳索下井；每回合在能安全挖完、来得及撤回营地的宝石里，
// 挑「（价值 + 订单加成）÷ 花的回合数」最高的一颗去挖；塌方快到、背包满了就回营地存入，时间不够就收工。
// 思路来自 sim/bots.ts 里的深潜者和订单猎人（模拟里最强的两种），合成一个无状态的版本：
// 每次都从当前视图重新算，服务器、托管、教程的「提示」都能直接调用。
//
// botPlan 返回这一回合要下的全部指令（营地里的存入 / 卖出 / 购买，最后一条是计划；不含「确认」）和一句理由。

import {
  GEM_DEFS,
  GROWTH_CAP,
  LAYER_DEFS,
  PARAMS,
  TOOL_DEFS,
  type GemColor,
  type LayerIndex,
  type OrderRequirement,
  type ToolKind,
} from "./data.js";
import { centerCell, type CellKey } from "./hex.js";
import { freeSlots, groundGemsAt, isWell, toolCanDig } from "./movement.js";
import { meetsRequirement, nextElevator, vaultGems } from "./engine.js";
import {
  WELLS,
  adjacent,
  forwardField,
  homeField,
  layerOf,
  passable,
  pathHome,
  pathTo,
  stepCosts,
  terrainOf,
  type Field,
  type Mover,
  type Terrain,
} from "./botPathing.js";
import type { GameCommand, GameState, Gem, OrderCard, Plan, PlayerState, Tool } from "./types.js";

export interface BotPlan {
  /** 依次下的指令；不含「确认」。 */
  readonly commands: GameCommand[];
  /** 一句玩家听得懂的理由（教程「提示」用）。 */
  readonly reason: string;
}

/** 打法参数。模拟脚本可以换一套来比较，服务器只用 NORMAL。 */
export interface BotProfile {
  /** 开局和补货买的工具（按顺序）。 */
  readonly kit: readonly ToolKind[];
  readonly maxLayer: LayerIndex;
  /** 每层宝石的偏好倍数。 */
  readonly layerWeight: readonly [number, number, number];
  /** 宝石能推进订单时，订单奖励折算成加分的权重。 */
  readonly orderWeight: number;
  /** 离塌方还剩几回合就往回走。 */
  readonly margin: number;
  /** 补货钱不够时卖掉便宜宝石。 */
  readonly sellForRestock: boolean;
  /** 背包剩几格空就回营地。 */
  readonly homeAt: number;
  /** 预计剩余回合少于这个就收工。 */
  readonly retireBelow: number;
}

export const NORMAL_PROFILE: BotProfile = {
  kit: ["drill", "chisel", "rope"],
  maxLayer: 2,
  layerWeight: [0.5, 1, 1.3],
  orderWeight: 1.2,
  margin: 3,
  sellForRestock: true,
  homeAt: 0,
  retireBelow: 6,
};

/** 工具的稀缺程度：同样快时优先用不稀缺的，把凿留给只能用凿的宝石。 */
const TOOL_SCARCITY: Partial<Record<ToolKind, number>> = { pick: 0, drill: 1, chisel: 2, fork: 3, dynamite: 4 };
/** 每颗宝石"拿得到"的概率，按所在层估。 */
const LAYER_EASE = [0.85, 0.55, 0.35] as const;

const gemName = (gem: Gem) => `${LAYER_DEFS[gem.layer].name}的${GEM_DEFS[gem.kind].name}`;
const toolNames = (kinds: readonly ToolKind[]) => kinds.map((kind) => TOOL_DEFS[kind].name).join("、");

// ---------- 估算 ----------

function collapseRate(view: GameState): number {
  if (view.turn <= 3) return 1.25;
  return Math.min(2.5, Math.max(1, view.collapse / (view.turn - 1)));
}

/** 还能行动几回合，这一层就会塌（含本回合）。 */
function turnsLeft(view: GameState, layer: LayerIndex): number {
  if (view.collapsedLayers.includes(layer)) return 0;
  return Math.floor((LAYER_DEFS[layer].collapseAt - view.collapse) / collapseRate(view));
}

function moveBudget(free: number, curses: number): number {
  const base = Math.min(PARAMS.maxMove, Math.max(PARAMS.minMove, free + PARAMS.moveBonus));
  return Math.max(1, base - 2 * curses);
}

function cursesOf(view: GameState, bag: readonly string[], tools: readonly Tool[]): number {
  const cursed = bag.filter((id) => GEM_DEFS[view.gems[id]!.kind].trait === "curse" && !view.gems[id]!.cut).length;
  return Math.max(0, cursed - tools.filter((tool) => tool.kind === "seal").length);
}

/** 这颗宝石能推进订单多少（占订单要求的比例）。 */
function orderGain(requirement: OrderRequirement, have: readonly Gem[], gem: Gem): number {
  switch (requirement.kind) {
    case "colors": {
      const need = requirement.colors[gem.color] ?? 0;
      if (need === 0 || have.filter((owned) => owned.color === gem.color).length >= need) return 0;
      const total = Object.values(requirement.colors).reduce((sum: number, count) => sum + (count ?? 0), 0);
      return 1 / total;
    }
    case "layer":
      return gem.layer === requirement.layer && have.filter((owned) => owned.layer === requirement.layer).length < requirement.count ? 1 / requirement.count : 0;
    case "distinctColors": {
      const colors = new Set(have.map((owned) => owned.color));
      return !colors.has(gem.color) && colors.size < requirement.count ? 1 / requirement.count : 0;
    }
    case "gemCount":
      return have.length < requirement.count ? 1 / requirement.count : 0;
    case "totalValue": {
      const total = have.reduce((sum, owned) => sum + owned.value, 0);
      return total < requirement.value ? Math.min(1, gem.value / requirement.value) : 0;
    }
  }
}

function orderBonus(view: GameState, me: PlayerState, have: readonly Gem[], gem: Gem): number {
  let bonus = 0;
  for (const order of me.privateOrders) {
    if (order.hidden || meetsRequirement(order.requirement, [...have])) continue;
    bonus += order.reward * orderGain(order.requirement, have, gem);
  }
  for (const order of view.publicOrders) {
    if (order.claimedBy.length > 0 || meetsRequirement(order.requirement, [...have])) continue;
    bonus += order.reward * 0.6 * orderGain(order.requirement, have, gem);
  }
  return bonus;
}

/** 能完整拿到的宝石（共鸣晶要两人同回合合挖，出土必定碎裂）。 */
const obtainable = (gem: Gem) => GEM_DEFS[gem.kind].trait !== "resonance";

/** 订单好不好凑：奖励 × 估计凑齐的概率。 */
function orderScore(view: GameState, order: OrderCard, profile: BotProfile): number {
  const pool = Object.values(view.gems).filter((gem) => gem.location.type === "wall" && obtainable(gem) && gem.layer <= profile.maxLayer);
  const easiest = (gems: readonly Gem[], count: number) => {
    const eases = gems.map((gem) => LAYER_EASE[gem.layer]).sort((a, b) => b - a);
    if (eases.length < count) return 0;
    const scarcity = Math.min(1, eases.length / (count * 2));
    return eases.slice(0, count).reduce((product, ease) => product * ease, 1) * (0.5 + 0.5 * scarcity);
  };
  const req = order.requirement;
  let chance = 1;
  if (req.kind === "colors") {
    for (const [color, count] of Object.entries(req.colors) as [GemColor, number | undefined][]) chance *= easiest(pool.filter((gem) => gem.color === color), count ?? 0);
  } else if (req.kind === "layer") {
    chance = easiest(pool.filter((gem) => gem.layer === req.layer), req.count);
  } else if (req.kind === "distinctColors") {
    const perColor = [...new Set(pool.map((gem) => gem.color))].map((color) => easiest(pool.filter((gem) => gem.color === color), 1)).sort((a, b) => b - a);
    chance = perColor.length < req.count ? 0 : perColor.slice(0, req.count).reduce((product, value) => product * value, 1);
  }
  return order.reward * chance;
}

// ---------- 候选目标 ----------

/** 某个位置、某套装备下的"我"：在营地里用来假设从各井口出发。 */
interface Probe {
  readonly cell: CellKey;
  readonly tools: readonly Tool[];
  readonly free: number;
  readonly mp: number;
  readonly fwd: Field;
  readonly home: Map<CellKey, number>;
  /** 出发前还要花几回合（营地下井：1）。 */
  readonly delay: number;
}

interface Candidate {
  readonly gem: Gem;
  readonly access: CellKey;
  readonly travel: number;
  readonly action: Plan;
  readonly utility: number;
  /** 估算的价值（含订单加成），用来写理由。 */
  readonly value: number;
  readonly orderBoost: boolean;
  readonly shatters: boolean;
}

function digTool(tools: readonly Tool[], gem: Gem, remaining: number): Tool | undefined {
  const usable = tools.filter((tool) => TOOL_DEFS[tool.kind].progress > 0 && toolCanDig(gem, tool.kind) && tool.kind !== "dynamite" && tool.kind !== "fork");
  if (usable.length === 0) return undefined;
  const turns = (tool: Tool) => Math.ceil(remaining / TOOL_DEFS[tool.kind].progress);
  return usable.sort((a, b) => turns(a) - turns(b) || (TOOL_SCARCITY[a.kind] ?? 5) - (TOOL_SCARCITY[b.kind] ?? 5))[0];
}

function digCapacity(tools: readonly Tool[], gem: Gem): number {
  return tools
    .filter((tool) => TOOL_DEFS[tool.kind].progress > 0 && toolCanDig(gem, tool.kind) && tool.kind !== "dynamite" && tool.kind !== "fork")
    .reduce((sum, tool) => sum + (tool.durability ?? 99) * TOOL_DEFS[tool.kind].progress, 0);
}

function bestCandidate(view: GameState, me: PlayerState, profile: BotProfile, terrain: Terrain, probe: Probe, have: readonly Gem[]): Candidate | null {
  const kEnd = turnsLeft(view, 0) - probe.delay;
  const players = view.players.filter((player) => player.id !== me.id && player.status === "mine" && player.cell);
  const hasShade = probe.tools.some((tool) => tool.kind === "shade");
  const hasSeal = probe.tools.some((tool) => tool.kind === "seal");
  let best: Candidate | null = null;

  const consider = (gem: Gem, access: CellKey, work: number, action: Plan, valueFactor: number, shatters: boolean) => {
    const distance = probe.fwd.dist.get(access);
    if (distance === undefined) return;
    const travel = distance === 0 ? 0 : Math.ceil(distance / probe.mp);
    const slots = gem.heavy ? 2 : 1;
    const mpAfter = moveBudget(probe.free - slots, 0);
    const homeCost = probe.home.get(access) ?? Infinity;
    if (homeCost === Infinity) return;
    const homeAfter = (homeCost === 0 ? 0 : Math.ceil(homeCost / mpAfter)) + 1;
    const finish = travel + work;
    // 安全：挖完还来得及回营地，也来得及离开这一层。
    if (finish + homeAfter + profile.margin > kEnd) return;
    if (gem.layer > 0 && finish + homeAfter + profile.margin > turnsLeft(view, gem.layer) - probe.delay) return;

    const def = GEM_DEFS[gem.kind];
    let value = gem.value;
    if (def.trait === "growth" && action.kind === "dig") value = Math.min(GROWTH_CAP, value + finish);
    if (def.trait === "decay") value = Math.max(0, value - Math.ceil(homeAfter * (hasShade ? 0.5 : 1)));
    if (def.trait === "curse" && !hasSeal) value -= 2 + homeAfter * 0.5;
    const bonus = shatters ? 0 : orderBonus(view, me, have, gem) * profile.orderWeight;
    value = value * valueFactor + bonus;
    if (gem.heavy) value *= 0.9;
    // 有别人站在旁边：可能撞车碎裂。
    if (players.some((player) => adjacent(player.cell!).includes(access) || player.cell === access)) value *= 0.75;
    const utility = (value * profile.layerWeight[gem.layer]) / (finish + 1 + probe.delay);
    if (utility > 0 && (!best || utility > best.utility)) best = { gem, access, travel, action, utility, value, orderBoost: bonus > 0, shatters };
  };

  for (const gem of Object.values(view.gems)) {
    const location = gem.location;
    if (gem.layer > profile.maxLayer || !obtainable(gem)) continue;
    if (location.type === "ground") {
      if (probe.free < (gem.heavy ? 2 : 1)) continue;
      if (players.some((player) => player.cell === location.cell)) continue;
      consider(gem, location.cell, 1, { kind: "pickup", gemId: gem.id }, 1, false);
      continue;
    }
    if (location.type !== "wall" || terrain.collapsed.has(layerOf(location.cell))) continue;
    if (probe.free < (gem.heavy ? 2 : 1)) continue;
    const remaining = gem.hardness - gem.progress;
    const tool = digTool(probe.tools, gem, remaining);
    if (!tool || digCapacity(probe.tools, gem) < remaining) continue;
    const theirs = Object.entries(gem.contributions).filter(([id]) => id !== me.id).reduce((sum, [, amount]) => sum + amount, 0);
    const mine = gem.contributions[me.id] ?? 0;
    const work = Math.ceil(remaining / TOOL_DEFS[tool.kind].progress);
    // 别人出过力：自己挖完也会碎裂，只能按贡献分到 60%。
    const factor = theirs > 0 ? PARAMS.shatterShare * ((mine + remaining) / (theirs + mine + remaining)) : 1;
    let access: CellKey | undefined;
    let bestDistance = Infinity;
    for (const cell of adjacent(location.cell)) {
      if (!passable(terrain, cell)) continue;
      const distance = probe.fwd.dist.get(cell);
      if (distance !== undefined && distance < bestDistance) {
        bestDistance = distance;
        access = cell;
      }
    }
    if (!access) continue;
    consider(gem, access, work, { kind: "dig", gemId: gem.id, toolId: tool.id }, factor, theirs > 0);
  }
  return best;
}

// ---------- 准备阶段 ----------

function setupPlan(view: GameState, me: PlayerState, profile: BotProfile): BotPlan {
  const commands: GameCommand[] = [];
  let reason = "";
  if (me.privateOrders.length === 0 && me.orderChoices.length > 0) {
    const scored = me.orderChoices.map((order) => ({ order, score: orderScore(view, order, profile) })).sort((a, b) => a.score - b.score);
    const drop = scored[0]!.order;
    const kept = me.orderChoices.filter((order) => order.id !== drop.id);
    commands.push({ type: "keepOrders", discardId: drop.id });
    reason = `留下「${kept.map((order) => order.name).join("」「")}」，放弃最难凑齐的「${drop.name}」。`;
  }
  const bought = buyMissing(me, profile, me.gold, commands);
  reason += bought.length > 0 ? `买${toolNames(bought)}：钻和凿能挖大多数宝石，绳索让爬梯子只算 1 格。` : "工具已经够用了。";
  return { commands, reason };
}

/** 按 kit 补齐缺的工具（按数量算），钱不够或背包只剩 3 格就停。返回买了什么。 */
function buyMissing(me: PlayerState, profile: BotProfile, gold: number, commands: GameCommand[]): ToolKind[] {
  const owned = me.tools.map((tool) => tool.kind);
  const bought: ToolKind[] = [];
  let toolCount = me.tools.length;
  const bagUsed = me.bag.length;
  for (const kind of profile.kit) {
    const index = owned.indexOf(kind);
    if (index >= 0) {
      owned.splice(index, 1);
      continue;
    }
    const price = TOOL_DEFS[kind].price;
    if (gold < price || PARAMS.bagSlots - toolCount - bagUsed < 3) continue;
    commands.push({ type: "buy", tool: kind });
    bought.push(kind);
    gold -= price;
    toolCount += 1;
  }
  return bought;
}

// ---------- 营地 ----------

function campPlan(view: GameState, me: PlayerState, profile: BotProfile): BotPlan {
  const commands: GameCommand[] = [];
  const notes: string[] = [];
  let gold = me.gold;
  const bag = me.bag.map((id) => view.gems[id]!);
  const owned = me.tools.map((tool) => tool.kind);
  const wanted: ToolKind[] = [];
  for (const kind of profile.kit) {
    const index = owned.indexOf(kind);
    if (index >= 0) owned.splice(index, 1);
    else wanted.push(kind);
  }
  // 卖宝石换工具：工具很快回本，时间够时卖掉便宜宝石（≤ 6，不卖订单要用的）补齐装备。
  const kEndNow = turnsLeft(view, 0);
  const diggers = me.tools.filter((tool) => TOOL_DEFS[tool.kind].progress > 0);
  const firstDigger = wanted.find((kind) => TOOL_DEFS[kind].progress > 0);
  const target = profile.sellForRestock
    ? wanted.reduce((sum, kind) => sum + TOOL_DEFS[kind].price, 0)
    : diggers.length === 0 && firstDigger ? TOOL_DEFS[firstDigger].price : 0;
  const sell = new Set<string>();
  if (gold < target && kEndNow >= 8) {
    const have = [...vaultGems(view, me.id)];
    for (const gem of [...bag].sort((a, b) => a.value - b.value)) {
      if (gold >= target || gem.value > 6) break;
      if (orderBonus(view, me, have, gem) > 0) continue;
      sell.add(gem.id);
      gold += gem.value;
    }
  }
  for (const gem of bag) commands.push({ type: sell.has(gem.id) ? "sell" : "deposit", gemId: gem.id });
  const deposited = bag.length - sell.size;
  if (deposited > 0) notes.push(`存入 ${deposited} 颗宝石`);
  if (sell.size > 0) notes.push(`卖掉 ${sell.size} 颗便宜的换工具`);

  // 背包清空之后再算还能买什么。
  const afterBag: PlayerState = { ...me, bag: [] };
  const bought = buyMissing(afterBag, profile, gold, commands);
  if (bought.length > 0) notes.push(`补买${toolNames(bought)}`);
  const tools: Tool[] = [...me.tools, ...bought.map((kind, index) => ({ id: `planned-${index}`, kind, durability: TOOL_DEFS[kind].durability }))];
  const prefix = notes.length > 0 ? `${notes.join("，")}；` : "";

  const kEnd = turnsLeft(view, 0);
  if (kEnd < profile.retireBelow) {
    commands.push({ type: "plan", plan: { kind: "retire" } });
    return { commands, reason: `${prefix}离矿洞塌毁只剩几回合，再下去来不及回来，收工保住分数。` };
  }
  if (!tools.some((tool) => TOOL_DEFS[tool.kind].progress > 0)) {
    commands.push({ type: "plan", plan: { kind: "retire" } });
    return { commands, reason: `${prefix}没有挖掘工具也买不起了，收工。` };
  }
  // 从哪个井口下去最划算。
  const terrain = terrainOf(view);
  const mover: Mover = { rope: tools.some((tool) => tool.kind === "rope"), full: false };
  const free = PARAMS.bagSlots - tools.length;
  const home = homeField(terrain, mover);
  const have = [...vaultGems(view, me.id), ...bag.filter((gem) => !sell.has(gem.id))];
  let bestWell = -1;
  let best: Candidate | null = null;
  WELLS.forEach((well, index) => {
    if (!passable(terrain, well)) return;
    const probe: Probe = { cell: well, tools, free, mp: moveBudget(free, 0), fwd: forwardField(terrain, mover, well), home, delay: 1 };
    const candidate = bestCandidate(view, me, profile, terrain, probe, have);
    if (candidate && (!best || candidate.utility > best.utility)) {
      best = candidate;
      bestWell = index;
    }
  });
  if (bestWell < 0 || !best) {
    commands.push({ type: "plan", plan: { kind: "retire" } });
    return { commands, reason: `${prefix}剩下的宝石要么挖不完、要么来不及带回来，收工。` };
  }
  const chosen = best as Candidate;
  commands.push({ type: "plan", plan: { kind: "descend", well: bestWell } });
  return { commands, reason: `${prefix}从 ${bestWell + 1} 号井口下井，离${gemName(chosen.gem)}最近${chosen.orderBoost ? "（订单用得上）" : ""}。` };
}

// ---------- 矿洞里 ----------

function minePlan(view: GameState, me: PlayerState, profile: BotProfile): BotPlan {
  const cell = me.cell!;
  const terrain = terrainOf(view);
  const free = freeSlots(view, me);
  const mover: Mover = { rope: me.tools.some((tool) => tool.kind === "rope"), full: free <= 0 };
  const mp = moveBudget(free, cursesOf(view, me.bag, me.tools));
  const fwd = forwardField(terrain, mover, cell);
  const home = homeField(terrain, mover);
  const plan = (next: Plan, reason: string): BotPlan => ({ commands: [{ type: "plan", plan: next }], reason });

  /** 沿路走，花不超过移动力；不在电梯格上停（除非想坐电梯）。 */
  const walk = (path: readonly CellKey[], ride = false): Plan | null => {
    const costs = stepCosts(terrain, mover, cell, path);
    const stop = centerCell(view.elevator.layer);
    let spent = 0;
    let end = 0;
    for (let index = 0; index < path.length; index += 1) {
      if (spent + costs[index]! > mp) break;
      spent += costs[index]!;
      end = index + 1;
    }
    const prefix = path.slice(0, end);
    while (!ride && prefix.length > 0 && prefix[prefix.length - 1] === stop) prefix.pop();
    return prefix.length > 0 ? { kind: "move", path: prefix } : null;
  };

  /** 坐电梯能不能更快到：比较走路和"本回合上电梯、下回合从下一站出发"。 */
  const elevatorFor = (remainingFrom: (from: CellKey) => number): Plan | null => {
    const next = nextElevator(view);
    if (!next || layerOf(cell) !== view.elevator.layer) return null;
    const stop = centerCell(view.elevator.layer);
    const toStop = fwd.dist.get(stop);
    if (toStop === undefined || toStop > mp) return null;
    const walkTurns = Math.ceil(remainingFrom(cell) / mp);
    const rideTurns = 1 + Math.ceil(remainingFrom(centerCell(next.layer)) / mp);
    if (!(rideTurns < walkTurns)) return null;
    if (cell === stop) return { kind: "wait" };
    return walk(pathTo(fwd, stop), true);
  };

  const goHome = (why: string): BotPlan => {
    if (isWell(cell) >= 0) return plan({ kind: "evacuate" }, `${why}，站在井口，撤离回营地。`);
    const ride = elevatorFor((from) => home.get(from) ?? Infinity);
    if (ride) return plan(ride, `${why}，坐电梯回上层更快。`);
    const step = walk(pathHome(terrain, mover, home, cell));
    return plan(step ?? { kind: "wait" }, `${why}，往最近的井口走。`);
  };

  const homeCost = home.get(cell) ?? Infinity;
  const homeTurns = (homeCost === 0 ? 0 : Math.ceil(homeCost / mp)) + 1;
  const myLayer = layerOf(cell);
  const deadline = Math.min(turnsLeft(view, 0), myLayer > 0 ? turnsLeft(view, myLayer) : Infinity);
  if (homeTurns + profile.margin >= deadline) {
    return goHome(myLayer > 0 && turnsLeft(view, myLayer) < turnsLeft(view, 0) ? `${LAYER_DEFS[myLayer].name}快塌方了` : "矿洞快塌毁了");
  }

  const have = [...vaultGems(view, me.id), ...me.bag.map((id) => view.gems[id]!)];
  const here = groundGemsAt(view, cell).filter((gem) => free >= (gem.heavy ? 2 : 1) && obtainable(gem));
  if (here.length > 0) {
    const gem = here.sort((a, b) => b.value - a.value)[0]!;
    return plan({ kind: "pickup", gemId: gem.id }, `${GEM_DEFS[gem.kind].name}已经挖出来了，就在脚下，捡起来。`);
  }
  if (free <= profile.homeAt && me.bag.length > 0) return goHome("背包满了");

  const probe: Probe = { cell, tools: me.tools, free, mp, fwd, home, delay: 0 };
  const target = bestCandidate(view, me, profile, terrain, probe, have);
  if (!target) return goHome(me.bag.length > 0 ? "附近没有来得及挖完的宝石了" : "附近没有能挖的宝石了");
  const name = gemName(target.gem);
  if (target.travel === 0) {
    const action = target.action;
    if (action.kind === "dig") {
      const tool = me.tools.find((candidate) => candidate.id === action.toolId)!;
      const remaining = target.gem.hardness - target.gem.progress;
      const left = Math.max(0, remaining - TOOL_DEFS[tool.kind].progress);
      const tail = left === 0 ? "这一下就能挖出来" : `还差 ${left} 点进度`;
      return plan(action, `用${TOOL_DEFS[tool.kind].name}挖${name}（价值 ${target.gem.value}），${tail}${target.shatters ? "；别人也挖过，出土会碎，只能分一部分" : ""}。`);
    }
    return plan(action, `捡起${name}。`);
  }
  const why = `去挖${name}（价值 ${target.gem.value}${target.orderBoost ? "，订单用得上" : ""}）`;
  if (layerOf(target.access) !== myLayer) {
    const fromLanding = new Map<CellKey, number>();
    const ride = elevatorFor((from) => {
      if (from === cell) return fwd.dist.get(target.access) ?? Infinity;
      let cached = fromLanding.get(from);
      if (cached === undefined) {
        cached = forwardField(terrain, mover, from).dist.get(target.access) ?? Infinity;
        fromLanding.set(from, cached);
      }
      return cached;
    });
    if (ride) return plan(ride, `${why}，坐电梯过去更快。`);
  }
  const step = walk(pathTo(fwd, target.access));
  return plan(step ?? { kind: "wait" }, `${why}，大约 ${target.travel} 回合走到。`);
}

// ---------- 入口 ----------

/**
 * 人机这一回合的全部指令和理由。view 必须是 redactGameForViewer(game, playerId) 之后的状态。
 * 已经确认、已经收工或对局结束时返回空指令。
 */
export function botPlan(view: GameState, playerId: string, profile: BotProfile = NORMAL_PROFILE): BotPlan {
  const me = view.players.find((player) => player.id === playerId);
  if (!me || view.phase === "finished" || me.confirmed) return { commands: [], reason: "" };
  if (view.phase === "setup") return setupPlan(view, me, profile);
  if (me.status === "retired") return { commands: [], reason: "" };
  return me.status === "camp" ? campPlan(view, me, profile) : minePlan(view, me, profile);
}

/**
 * 人机下一条指令（一次一条的接口）：营地里的存入 / 卖出 / 购买逐条下，选好计划以后就「确认」。
 * 反复调用会收敛：每条指令都让背包变空或工具补齐，计划选过就只剩确认。
 */
export function botCommand(view: GameState, playerId: string): GameCommand {
  const me = view.players.find((player) => player.id === playerId);
  if (me?.plan) return { type: "confirm" };
  return botPlan(view, playerId).commands[0] ?? { type: "confirm" };
}
