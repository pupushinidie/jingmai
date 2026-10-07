// 不同策略的陪玩机器人。只看自己能看到的视图（redactGameForViewer），每回合返回要执行的指令：
// 营地里的存入 / 卖出 / 购买，最后一条是本回合的计划。

import {
  GEM_DEFS,
  GROWTH_CAP,
  LAYER_DEFS,
  PARAMS,
  TOOL_DEFS,
  TOOL_KINDS,
  centerCell,
  diggableGems,
  freeSlots,
  groundGemsAt,
  isWell,
  meetsRequirement,
  nextElevator,
  pathTo as enginePathTo,
  reachableCells,
  toolCanDig,
  vaultGems,
  type CellKey,
  type GameCommand,
  type GameState,
  type Gem,
  type LayerIndex,
  type OrderCard,
  type OrderRequirement,
  type Plan,
  type PlayerState,
  type Tool,
  type ToolKind,
} from "@jingmai/game";
import {
  WELLS,
  forwardField,
  homeField,
  layerOf,
  passable,
  pathHome,
  pathTo,
  stepCosts,
  terrainOf,
  adjacent,
  type Field,
  type Mover,
  type Terrain,
} from "./pathing.js";

// ---------- 随机数 ----------

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number) => Math.floor(next() * maxExclusive);
  return { next, int, pick: (items) => items[int(items.length)]! };
}

// ---------- 公开的规则设定 ----------

/** 规则实验里的公开规则：红区（塌方到这个值以后可能大震）。现行规则没有红区。 */
export const rules = { redZone: Infinity };

// ---------- 统计：机器人为什么收工 ----------

/** 收工原因计数（"策略:原因"），模拟器汇总进报告。 */
export const retireReasons = new Map<string, number>();
const noteRetire = (profile: { id: string }, reason: string) => retireReasons.set(`${profile.id}:${reason}`, (retireReasons.get(`${profile.id}:${reason}`) ?? 0) + 1);

// ---------- 接口 ----------

export type StrategyId = "prospector" | "diver" | "collector" | "blaster" | "leech" | "gambler" | "partner" | "traitor" | "random";

export interface Bot {
  setup(view: GameState, me: PlayerState): GameCommand[];
  turn(view: GameState, me: PlayerState): GameCommand[];
}

/**
 * 合伙挖共鸣晶的两人一队（只在规则实验里用）。两个机器人共用这个对象：
 * 一起选目标、等对方到位、同一回合一起用共鸣叉挖；members[0] 是持宝人。
 */
export interface Team {
  readonly members: readonly [string, string];
  readonly carrier: string;
  /** 持宝人存入时背约独吞。 */
  readonly betray: boolean;
  targetGemId?: string;
  /** 这一局不再合伙（没有共鸣晶、已经挖出、来不及或叉子坏了）。 */
  done: boolean;
}

export function createTeam(members: readonly [string, string], betray: boolean): Team {
  return { members, carrier: members[0], betray, done: false };
}

export interface BotContext {
  readonly team?: Team;
}

export interface Strategy {
  readonly id: StrategyId;
  readonly name: string;
  readonly english: string;
  readonly summary: string;
  create(rng: Rng, context?: BotContext): Bot;
}

// ---------- 参数化的"聪明"机器人 ----------

interface Profile {
  readonly id: StrategyId;
  readonly name: string;
  readonly english: string;
  readonly summary: string;
  /** 开局按顺序买的工具；null 表示按订单决定（订单猎人）。 */
  readonly kit: readonly ToolKind[] | null;
  /** 最深去哪一层。 */
  readonly maxLayer: LayerIndex;
  /** 每层宝石的偏好倍数。 */
  readonly layerWeight: readonly [number, number, number];
  /** 订单的权重：宝石能推进订单时，按订单奖励折算加分。 */
  readonly orderWeight: number;
  /** 离塌方还剩几回合时就提前往回走（安全余量）。 */
  readonly margin: number;
  /** 进了红区（可能大震）以后额外加的安全余量；冒险家不加。 */
  readonly redZoneMargin: number;
  /** 炸药：不用 / 只炸硬的（剩余硬度 ≥ 3）。 */
  readonly dynamite: "never" | "hard";
  /** 抢别人正在挖的宝石的积极程度；0 = 从不碰别人出过力的宝石。 */
  readonly leech: number;
  /** 补货钱不够时卖掉便宜宝石（价值 ≤ 4）。 */
  readonly sellForRestock: boolean;
  /** 背包剩几格空就回营地。 */
  readonly homeAt: number;
  /** 预计剩余回合少于这个就收工。 */
  readonly retireBelow: number;
}

const PROFILES: readonly Profile[] = [
  {
    id: "prospector",
    name: "稳健矿工",
    english: "Prospector",
    summary: "只挖浅脉，镐 + 钻，装满就回，留足余量。",
    kit: ["drill", "pick"],
    maxLayer: 0,
    layerWeight: [1, 0, 0],
    orderWeight: 0.6,
    margin: 2,
    redZoneMargin: 2,
    dynamite: "never",
    leech: 0,
    sellForRestock: false,
    homeAt: 0,
    retireBelow: 4,
  },
  {
    id: "diver",
    name: "深潜者",
    english: "Diver",
    summary: "钻 + 凿 + 绳索直奔深层的高价宝石，塌方前撤回。",
    kit: ["drill", "chisel", "rope"],
    maxLayer: 2,
    layerWeight: [0.45, 1, 1.35],
    orderWeight: 0.6,
    margin: 3,
    redZoneMargin: 2,
    dynamite: "never",
    leech: 0,
    sellForRestock: true,
    homeAt: 0,
    retireBelow: 7,
  },
  {
    id: "collector",
    name: "订单猎人",
    english: "Collector",
    summary: "按自己的私人订单和公共订单配工具、挑宝石，尽快存入抢公共订单。",
    kit: null,
    maxLayer: 2,
    layerWeight: [1, 1, 1],
    orderWeight: 2.5,
    margin: 3,
    redZoneMargin: 2,
    dynamite: "never",
    leech: 0,
    sellForRestock: false,
    homeAt: 1,
    retireBelow: 6,
  },
  {
    id: "blaster",
    name: "爆破手",
    english: "Blaster",
    summary: "带两管炸药和绳索，硬宝石直接炸（价值 −30%、震动 +6），卖便宜宝石补炸药。",
    kit: ["dynamite", "dynamite", "rope", "pick"],
    maxLayer: 1,
    layerWeight: [0.8, 1.2, 0],
    orderWeight: 0.6,
    margin: 3,
    redZoneMargin: 2,
    dynamite: "hard",
    leech: 0,
    sellForRestock: true,
    homeAt: 0,
    retireBelow: 6,
  },
  {
    id: "gambler",
    name: "冒险家",
    english: "Gambler",
    summary: "和深潜者同样的装备，但安全余量为 0、留到最后两回合才收工，赌塌方前能撤回。",
    kit: ["drill", "chisel", "rope"],
    maxLayer: 2,
    layerWeight: [0.5, 1, 1.5],
    orderWeight: 0.6,
    margin: 0,
    redZoneMargin: 0,
    dynamite: "never",
    leech: 0,
    sellForRestock: true,
    homeAt: 0,
    retireBelow: 2,
  },
  {
    id: "partner",
    name: "合伙人",
    english: "Partner",
    summary: "两人一队：开局都带共鸣叉，一起下去同回合合挖共鸣晶，由持宝人带回营地按约分成；没有共鸣晶时按深潜者的打法。",
    kit: ["fork", "drill", "rope"],
    maxLayer: 2,
    layerWeight: [0.45, 1, 1.35],
    orderWeight: 0.6,
    margin: 3,
    redZoneMargin: 2,
    dynamite: "never",
    leech: 0,
    sellForRestock: true,
    homeAt: 0,
    retireBelow: 7,
  },
  {
    id: "traitor",
    name: "背约者",
    english: "Traitor",
    summary: "和合伙人一样组队合挖共鸣晶，自己当持宝人，存入时背约独吞。",
    kit: ["fork", "drill", "rope"],
    maxLayer: 2,
    layerWeight: [0.45, 1, 1.35],
    orderWeight: 0.6,
    margin: 3,
    redZoneMargin: 2,
    dynamite: "never",
    leech: 0,
    sellForRestock: true,
    homeAt: 0,
    retireBelow: 7,
  },
  {
    id: "leech",
    name: "搭便车",
    english: "Leech",
    summary: "专挑别人挖到一半的宝石补一下，让它碎裂分成；没得抢时正常挖。",
    kit: ["drill", "chisel", "rope"],
    maxLayer: 2,
    layerWeight: [0.7, 1, 1.2],
    orderWeight: 0.4,
    margin: 3,
    redZoneMargin: 2,
    dynamite: "never",
    leech: 1,
    sellForRestock: false,
    homeAt: 0,
    retireBelow: 6,
  },
];

/** 工具的稀缺程度：同样快时优先用不稀缺的，把凿留给只能用凿的宝石。 */
const TOOL_SCARCITY: Partial<Record<ToolKind, number>> = { pick: 0, drill: 1, chisel: 2, fork: 3, dynamite: 4 };

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

/** 能完整拿到的宝石（共鸣晶要两人合挖，必定碎裂）。 */
const obtainable = (gem: Gem) => GEM_DEFS[gem.kind].trait !== "resonance";

// ---------- 候选目标 ----------

/** 某个位置、某套装备下的"我"：用于在营地里假设从各井口出发。 */
interface Probe {
  readonly cell: CellKey;
  readonly tools: readonly Tool[];
  readonly free: number;
  readonly mp: number;
  readonly mover: Mover;
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
}

function digTool(profile: Profile, tools: readonly Tool[], gem: Gem, remaining: number): Tool | undefined {
  const usable = tools.filter((tool) => {
    const def = TOOL_DEFS[tool.kind];
    if (def.progress === 0 || !toolCanDig(gem, tool.kind)) return false;
    if (tool.kind === "dynamite") return profile.dynamite === "hard" && remaining >= 3;
    return true;
  });
  if (usable.length === 0) return undefined;
  // 回合数最少的工具里，选最不稀缺的。
  const turns = (tool: Tool) => Math.ceil(remaining / TOOL_DEFS[tool.kind].progress);
  return usable.sort((a, b) => turns(a) - turns(b) || (TOOL_SCARCITY[a.kind] ?? 5) - (TOOL_SCARCITY[b.kind] ?? 5))[0];
}

function digCapacity(tools: readonly Tool[], gem: Gem, profile: Profile): number {
  return tools
    .filter((tool) => TOOL_DEFS[tool.kind].progress > 0 && toolCanDig(gem, tool.kind) && (tool.kind !== "dynamite" || profile.dynamite === "hard"))
    .reduce((sum, tool) => sum + (tool.durability ?? 99) * TOOL_DEFS[tool.kind].progress, 0);
}

function bestCandidate(view: GameState, me: PlayerState, profile: Profile, terrain: Terrain, probe: Probe, have: readonly Gem[]): Candidate | null {
  const kEnd = turnsLeft(view, 0) - probe.delay;
  const players = view.players.filter((player) => player.id !== me.id && player.status === "mine" && player.cell);
  const hasShade = probe.tools.some((tool) => tool.kind === "shade");
  const hasSeal = probe.tools.some((tool) => tool.kind === "seal");
  let best: Candidate | null = null;

  /** shatters：出土时会碎裂（多人出力），进不了营地，不算订单。 */
  const consider = (gem: Gem, access: CellKey, work: number, action: Plan, extraValue: number, valueFactor: number, shatters = false) => {
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
    value = value * valueFactor + extraValue + (shatters ? 0 : orderBonus(view, me, have, gem) * profile.orderWeight);
    if (gem.heavy) value *= 0.9;
    // 有别人站在旁边：可能撞车碎裂。
    if (profile.leech === 0 && players.some((player) => adjacent(player.cell!).includes(access) || player.cell === access)) value *= 0.75;
    const utility = (value * profile.layerWeight[gem.layer]) / (finish + 1 + probe.delay);
    if (utility > 0 && (!best || utility > best.utility)) best = { gem, access, travel, action, utility };
  };

  for (const gem of Object.values(view.gems)) {
    const location = gem.location;
    if (gem.layer > profile.maxLayer || !obtainable(gem)) continue;
    if (location.type === "ground") {
      if (probe.free < (gem.heavy ? 2 : 1)) continue;
      if (players.some((player) => player.cell === location.cell)) continue;
      consider(gem, location.cell, 1, { kind: "pickup", gemId: gem.id }, 0, 1);
      continue;
    }
    if (location.type !== "wall" || terrain.collapsed.has(layerOf(location.cell))) continue;
    if (probe.free < (gem.heavy ? 2 : 1)) continue;
    const remaining = gem.hardness - gem.progress;
    const tool = digTool(profile, probe.tools, gem, remaining);
    if (!tool || digCapacity(probe.tools, gem, profile) < remaining) continue;
    const theirs = Object.entries(gem.contributions).filter(([id]) => id !== me.id).reduce((sum, [, amount]) => sum + amount, 0);
    const mine = gem.contributions[me.id] ?? 0;
    const progress = TOOL_DEFS[tool.kind].progress;
    let work = Math.ceil(remaining / progress);
    let extra = 0;
    let factor = tool.kind === "dynamite" ? 0.7 : 1;
    if (theirs > 0) {
      if (profile.leech > 0) {
        // 搭便车：补一下就"污染"了这颗宝石，谁挖出来都会碎裂，按贡献分 60%；外加"别人少拿"的好处。
        work = 1;
        factor = 0;
        extra = gem.value * PARAMS.shatterShare * ((mine + progress) / (theirs + mine + progress))
          + profile.leech * gem.value * 0.4 * Math.min(1, gem.progress / gem.hardness + 0.3);
      } else {
        // 别人出过力：自己挖完也会碎裂，只能按贡献分到 60%。
        factor *= PARAMS.shatterShare * ((mine + remaining) / (theirs + mine + remaining));
      }
    }
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
    consider(gem, access, work, { kind: "dig", gemId: gem.id, toolId: tool.id }, extra, factor, theirs > 0);
  }
  return best;
}

// ---------- 机器人 ----------

function createSmartBot(profile: Profile, team?: Team): Bot {
  let kit: readonly ToolKind[] = profile.kit ?? [];
  let maxLayer = profile.maxLayer;
  const effective = (): Profile => ({ ...profile, maxLayer });
  // 地图上没有共鸣晶就不合伙，换成深潜者的装备。
  const noGold = (view: GameState) => !Object.values(view.gems).some((gem) => GEM_DEFS[gem.kind].trait === "resonance" && gem.location.type === "wall");

  return {
    setup(view, me) {
      const commands: GameCommand[] = [];
      // 订单：放弃最难完成的一张。
      const choices = [...me.orderChoices];
      const scored = choices.map((order) => ({ order, score: orderScore(view, order, profile) }));
      scored.sort((a, b) => a.score - b.score);
      const kept = choices.filter((order) => order.id !== scored[0]?.order.id);
      if (scored[0]) commands.push({ type: "keepOrders", discardId: scored[0].order.id });
      if (!profile.kit) {
        const planned = collectorKit(view, kept);
        kit = planned.kit;
        maxLayer = planned.maxLayer;
      }
      if (kit.includes("fork") && (!team || noGold(view))) {
        if (team) team.done = true;
        kit = ["drill", "chisel", "rope"];
      }
      let gold = me.gold;
      let free = freeSlots(view, me);
      for (const kind of kit) {
        const price = TOOL_DEFS[kind].price;
        if (gold < price || free < 3) continue;
        commands.push({ type: "buy", tool: kind });
        gold -= price;
        free -= 1;
      }
      commands.push({ type: "confirm" });
      return commands;
    },

    turn(view, me) {
      // 红区里可能随时大震：除了冒险家，都把安全余量和收工线往前提。
      const red = view.collapse >= rules.redZone ? profile.redZoneMargin : 0;
      const current = { ...effective(), margin: profile.margin + red, retireBelow: profile.retireBelow + red };
      return me.status === "camp" ? campTurn(view, me, current, kit, team) : mineTurn(view, me, current, team);
    },
  };
}

/**
 * 每颗宝石"拿得到"的概率，按所在层估：一局大约只有 1–2 趟、每人 3–5 颗宝石，越深越难。
 * 只算自己会去的层；同色的有好几颗时取最容易的那几颗。
 */
const LAYER_EASE = [0.85, 0.55, 0.35] as const;

function orderScore(view: GameState, order: OrderCard, profile: Profile): number {
  const reach = profile.kit === null ? 2 : profile.maxLayer;
  const pool = Object.values(view.gems).filter((gem) => gem.location.type === "wall" && obtainable(gem) && gem.layer <= reach);
  const easiest = (gems: readonly Gem[], count: number) => {
    const eases = gems.map((gem) => LAYER_EASE[gem.layer]).sort((a, b) => b - a);
    if (eases.length < count) return 0;
    // 别人也在抢：可选的宝石不到需要的两倍时打折。
    const scarcity = Math.min(1, eases.length / (count * 2));
    return eases.slice(0, count).reduce((product, ease) => product * ease, 1) * (0.5 + 0.5 * scarcity);
  };
  const req = order.requirement;
  let chance = 1;
  if (req.kind === "colors") {
    for (const [color, count] of Object.entries(req.colors)) chance *= easiest(pool.filter((gem) => gem.color === color), count ?? 0);
  } else if (req.kind === "layer") {
    chance = easiest(pool.filter((gem) => gem.layer === req.layer), req.count);
  } else if (req.kind === "distinctColors") {
    const perColor = [...new Set(pool.map((gem) => gem.color))].map((color) => easiest(pool.filter((gem) => gem.color === color), 1)).sort((a, b) => b - a);
    chance = perColor.length < req.count ? 0 : perColor.slice(0, req.count).reduce((product, value) => product * value, 1);
  }
  return order.reward * chance;
}

/** 订单猎人的配装：先买能覆盖最多"订单宝石"的工具，需要下层就带绳索。 */
function collectorKit(view: GameState, orders: readonly OrderCard[]): { kit: ToolKind[]; maxLayer: LayerIndex } {
  const relevant = Object.values(view.gems).filter((gem) => gem.location.type === "wall" && obtainable(gem) && orders.some((order) => orderGain(order.requirement, [], gem) > 0));
  const kit: ToolKind[] = [];
  let gold = PARAMS.startingGold;
  let uncovered = [...relevant];
  while (uncovered.length > 0 && kit.length < 3) {
    const options = (["pick", "chisel", "drill"] as const)
      .filter((kind) => !kit.includes(kind) && TOOL_DEFS[kind].price <= gold - 2)
      .map((kind) => ({ kind, covers: uncovered.filter((gem) => toolCanDig(gem, kind)).reduce((sum, gem) => sum + gem.value, 0) }))
      .filter((option) => option.covers > 0)
      .sort((a, b) => b.covers - a.covers);
    const pick = options[0];
    if (!pick) break;
    kit.push(pick.kind);
    gold -= TOOL_DEFS[pick.kind].price;
    uncovered = uncovered.filter((gem) => !toolCanDig(gem, pick.kind));
  }
  if (kit.length === 0) kit.push("pick");
  const covered = relevant.filter((gem) => kit.some((kind) => toolCanDig(gem, kind)));
  const deepest = covered.reduce((layer: number, gem) => Math.max(layer, gem.layer), 0) as LayerIndex;
  if (deepest > 0 && gold >= TOOL_DEFS.rope.price) kit.push("rope");
  return { kit, maxLayer: deepest > 0 && kit.includes("rope") ? deepest : 0 };
}

function campTurn(view: GameState, me: PlayerState, profile: Profile, kit: readonly ToolKind[], team?: Team): GameCommand[] {
  const commands: GameCommand[] = [];
  let gold = me.gold;
  const bag = me.bag.map((id) => view.gems[id]!);
  // 补货清单：kit 里缺的（按数量算）。
  const wanted: ToolKind[] = [];
  const owned = me.tools.map((tool) => tool.kind);
  for (const kind of kit) {
    const index = owned.indexOf(kind);
    if (index >= 0) owned.splice(index, 1);
    else wanted.push(kind);
  }
  // 卖宝石换工具：工具很快回本（镐 2 金能挖 6 次），所以没有挖掘工具、时间又够时，
  // 卖掉便宜宝石（≤ 6，不卖订单要用的）去买；爆破手、深潜者还会为补齐整套装备而卖。
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

  const tools = [...me.tools];
  for (const kind of wanted) {
    const price = TOOL_DEFS[kind].price;
    if (gold < price || PARAMS.bagSlots - tools.length < 3) continue;
    commands.push({ type: "buy", tool: kind });
    gold -= price;
    tools.push({ id: `planned-${kind}-${tools.length}`, kind, durability: TOOL_DEFS[kind].durability });
  }

  const kEnd = turnsLeft(view, 0);
  if (kEnd < profile.retireBelow || !tools.some((tool) => TOOL_DEFS[tool.kind].progress > 0)) {
    noteRetire(profile, kEnd < profile.retireBelow ? "时间不够" : "没有挖掘工具");
    commands.push({ type: "plan", plan: { kind: "retire" } });
    return commands;
  }
  // 从哪个井口下去最划算。
  const terrain = terrainOf(view);
  const mover: Mover = { rope: tools.some((tool) => tool.kind === "rope"), full: false };
  const free = PARAMS.bagSlots - tools.length;
  const home = homeField(terrain, mover);
  const have = [...vaultGems(view, me.id), ...bag.filter((gem) => !sell.has(gem.id))];
  let bestWell = -1;
  let bestUtility = 0;
  // 合伙中：从离共鸣晶最近的井口下去。
  const teamGem = team && !team.done && team.targetGemId ? view.gems[team.targetGemId] : undefined;
  if (teamGem && teamGem.location.type === "wall") {
    const gemCell = teamGem.location.cell;
    let bestCost = Infinity;
    WELLS.forEach((well, index) => {
      if (!passable(terrain, well)) return;
      const field = forwardField(terrain, mover, well);
      for (const cell of adjacent(gemCell)) {
        const cost = field.dist.get(cell);
        if (cost !== undefined && cost < bestCost) {
          bestCost = cost;
          bestWell = index;
        }
      }
    });
    if (bestWell >= 0) {
      commands.push({ type: "plan", plan: { kind: "descend", well: bestWell } });
      return commands;
    }
  }
  WELLS.forEach((well, index) => {
    if (!passable(terrain, well)) return;
    const probe: Probe = { cell: well, tools, free, mp: moveBudget(free, 0), mover, fwd: forwardField(terrain, mover, well), home, delay: 1 };
    const candidate = bestCandidate(view, me, profile, terrain, probe, have);
    if (candidate && candidate.utility > bestUtility) {
      bestUtility = candidate.utility;
      bestWell = index;
    }
  });
  if (bestWell < 0) noteRetire(profile, "没有安全又值得的目标");
  commands.push({ type: "plan", plan: bestWell >= 0 ? { kind: "descend", well: bestWell } : { kind: "retire" } });
  return commands;
}

function mineTurn(view: GameState, me: PlayerState, profile: Profile, team?: Team): GameCommand[] {
  const cell = me.cell!;
  const terrain = terrainOf(view);
  const free = freeSlots(view, me);
  const mover: Mover = { rope: me.tools.some((tool) => tool.kind === "rope"), full: free <= 0 };
  const mp = moveBudget(free, cursesOf(view, me.bag, me.tools));
  const fwd = forwardField(terrain, mover, cell);
  const home = homeField(terrain, mover);
  const plan = (next: Plan): GameCommand[] => [{ type: "plan", plan: next }];

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
  const elevatorFor = (remainingFrom: (cell: CellKey) => number): Plan | null => {
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

  const goHome = (): GameCommand[] => {
    if (isWell(cell) >= 0) return plan({ kind: "evacuate" });
    const ride = elevatorFor((from) => home.get(from) ?? Infinity);
    if (ride) return plan(ride);
    const step = walk(pathHome(terrain, mover, home, cell));
    return plan(step ?? { kind: "wait" });
  };

  const homeCost = home.get(cell) ?? Infinity;
  const homeTurns = (homeCost === 0 ? 0 : Math.ceil(homeCost / mp)) + 1;
  const myLayer = layerOf(cell);
  const deadline = Math.min(turnsLeft(view, 0), myLayer > 0 ? turnsLeft(view, myLayer) : Infinity);
  if (homeTurns + profile.margin >= deadline) return goHome();

  const have = [...vaultGems(view, me.id), ...me.bag.map((id) => view.gems[id]!)];
  // 脚下有宝石就捡。
  const here = groundGemsAt(view, cell).filter((gem) => free >= (gem.heavy ? 2 : 1) && obtainable(gem));
  if (here.length > 0) {
    const gem = here.sort((a, b) => b.value - a.value)[0]!;
    return plan({ kind: "pickup", gemId: gem.id });
  }
  if (free <= profile.homeAt && me.bag.length > 0) return goHome();

  if (team) {
    // 持宝人拿到共鸣晶就直接回营地存入。
    if (me.id === team.carrier && me.bag.some((id) => GEM_DEFS[view.gems[id]!.kind].trait === "resonance")) return goHome();
    const step = teamStep(view, me, profile, team, terrain, fwd, home, mp, walk);
    if (step) return plan(step);
  }

  const probe: Probe = { cell, tools: me.tools, free, mp, mover, fwd, home, delay: 0 };
  const target = bestCandidate(view, me, profile, terrain, probe, have);
  if (!target) return goHome();
  if (target.travel === 0) return plan(target.action);
  // 目标在别的层：看看坐电梯是否更快。
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
    if (ride) return plan(ride);
  }
  const step = walk(pathTo(fwd, target.access));
  return plan(step ?? { kind: "wait" });
}

/** 合伙挖共鸣晶的一步：选目标 → 走过去 → 等搭档到位 → 两人同回合用共鸣叉挖。不合伙时返回 null。 */
function teamStep(
  view: GameState,
  me: PlayerState,
  profile: Profile,
  team: Team,
  terrain: Terrain,
  fwd: Field,
  home: Map<CellKey, number>,
  mp: number,
  walk: (path: readonly CellKey[]) => Plan | null,
): Plan | null {
  if (team.done) return null;
  const fork = me.tools.find((tool) => tool.kind === "fork");
  if (!fork) {
    team.done = true;
    return null;
  }
  let gem = team.targetGemId ? view.gems[team.targetGemId] : undefined;
  if (gem && gem.location.type !== "wall") {
    team.done = true;
    return null;
  }
  const accessOf = (target: Gem): { cell: CellKey; cost: number } | null => {
    if (target.location.type !== "wall") return null;
    let best: { cell: CellKey; cost: number } | null = null;
    for (const cell of adjacent(target.location.cell)) {
      if (!passable(terrain, cell)) continue;
      const cost = fwd.dist.get(cell);
      if (cost !== undefined && (!best || cost < best.cost)) best = { cell, cost };
    }
    return best;
  };
  if (!gem) {
    let bestCost = Infinity;
    for (const candidate of Object.values(view.gems)) {
      if (GEM_DEFS[candidate.kind].trait !== "resonance" || candidate.location.type !== "wall" || terrain.collapsed.has(candidate.layer)) continue;
      const access = accessOf(candidate);
      if (access && access.cost < bestCost) {
        bestCost = access.cost;
        gem = candidate;
      }
    }
    if (!gem) {
      team.done = true;
      return null;
    }
    team.targetGemId = gem.id;
  }
  const access = accessOf(gem);
  if (!access || gem.location.type !== "wall") {
    team.done = true;
    return null;
  }
  // 来得及吗：走过去 + 两人合挖（每回合 +2）+ 回营地，留出安全余量和等搭档的一回合。
  const work = Math.ceil((gem.hardness - gem.progress) / 2);
  const travel = access.cost === 0 ? 0 : Math.ceil(access.cost / mp);
  const homeAfter = Math.ceil((home.get(access.cell) ?? Infinity) / Math.max(1, mp - 1)) + 1;
  if (travel + work + homeAfter + profile.margin + 1 > Math.min(turnsLeft(view, 0), turnsLeft(view, gem.layer))) {
    team.done = true;
    return null;
  }
  const gemCell = gem.location.cell;
  const besideGem = (cell: CellKey | undefined) => cell !== undefined && adjacent(gemCell).includes(cell);
  const partner = view.players.find((player) => player.id !== me.id && team.members.includes(player.id));
  if (besideGem(me.cell)) {
    const ready = partner?.status === "mine" && besideGem(partner.cell);
    return ready ? { kind: "dig", gemId: gem.id, toolId: fork.id } : { kind: "wait" };
  }
  return walk(pathTo(fwd, access.cell)) ?? { kind: "wait" };
}

// ---------- 随机机器人（基准线） ----------

function createRandomBot(rng: Rng): Bot {
  return {
    setup(_view, me) {
      const commands: GameCommand[] = [];
      const discard = rng.pick(me.orderChoices);
      commands.push({ type: "keepOrders", discardId: discard.id });
      let gold = me.gold;
      for (let index = 0; index < 4; index += 1) {
        const affordable = TOOL_KINDS.filter((kind) => TOOL_DEFS[kind].price <= gold);
        if (affordable.length === 0) break;
        const kind = rng.pick(affordable);
        commands.push({ type: "buy", tool: kind });
        gold -= TOOL_DEFS[kind].price;
      }
      commands.push({ type: "confirm" });
      return commands;
    },
    turn(view, me) {
      if (me.status === "camp") {
        const commands: GameCommand[] = me.bag.map((id) => ({ type: "deposit" as const, gemId: id }));
        if (rng.next() < 0.3) commands.push({ type: "buy", tool: rng.pick(TOOL_KINDS) });
        const roll = rng.next();
        const plan: Plan = turnsLeft(view, 0) < 3 || roll < 0.05 ? { kind: "retire" } : roll < 0.85 ? { kind: "descend", well: rng.int(6) } : { kind: "stay" };
        commands.push({ type: "plan", plan });
        return commands;
      }
      const cell = me.cell!;
      const options: Plan[][] = [];
      const reach = reachableCells(view, me);
      const moves = [...reach.keys()].filter((target) => target !== cell);
      if (moves.length > 0) {
        const target = rng.pick(moves);
        const path = enginePathTo(reach, target);
        if (path && path.length > 0) options.push([{ kind: "move", path }]);
      }
      const digs = diggableGems(view, cell).flatMap((gem) =>
        me.tools.filter((tool) => TOOL_DEFS[tool.kind].progress > 0 && toolCanDig(gem, tool.kind)).map((tool): Plan => ({ kind: "dig", gemId: gem.id, toolId: tool.id })),
      );
      if (digs.length > 0) options.push(digs);
      const pickups = groundGemsAt(view, cell).filter((gem) => freeSlots(view, me) >= (gem.heavy ? 2 : 1)).map((gem): Plan => ({ kind: "pickup", gemId: gem.id }));
      if (pickups.length > 0) options.push(pickups);
      if (isWell(cell) >= 0) {
        const evacuate: Plan[] = [{ kind: "evacuate" }];
        options.push(evacuate);
        if (me.bag.length >= 2) options.push(evacuate, evacuate);
      }
      options.push([{ kind: "wait" }]);
      return [{ type: "plan", plan: rng.pick(rng.pick(options)) }];
    },
  };
}

// ---------- 策略表 ----------

export const STRATEGIES: Record<StrategyId, Strategy> = {
  ...Object.fromEntries(PROFILES.map((profile) => [profile.id, {
    id: profile.id,
    name: profile.name,
    english: profile.english,
    summary: profile.summary,
    create: (_rng: Rng, context?: BotContext) => createSmartBot(profile, context?.team),
  } satisfies Strategy])) as unknown as Record<Exclude<StrategyId, "random">, Strategy>,
  random: {
    id: "random",
    name: "随机",
    english: "Random",
    summary: "基准线：随机配装、随机走、随机挖，在井口时有一定概率撤离。",
    create: (rng) => createRandomBot(rng),
  },
};

export const SMART_STRATEGIES: readonly StrategyId[] = ["prospector", "diver", "collector", "blaster", "leech", "gambler"];
/** 规则实验里成对入座的合伙人。 */
export const PACT_STRATEGIES: readonly StrategyId[] = ["partner", "traitor"];
export const ALL_STRATEGIES: readonly StrategyId[] = [...SMART_STRATEGIES, "random"];
