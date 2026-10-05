import {
  GEM_DEFS,
  GROWTH_CAP,
  LAYER_DEFS,
  PARAMS,
  PRIVATE_ORDERS,
  PUBLIC_ORDERS,
  TOOL_DEFS,
  type GemColor,
  type LayerIndex,
  type OrderDefinition,
  type OrderRequirement,
} from "./data.js";
import { centerCell, neighbors, parseCell, wellCells, type CellKey } from "./hex.js";
import { generateMap } from "./mapgen.js";
import {
  checkPath,
  freeSlots,
  gemSlots,
  hasTool,
  isCollapsed,
  isWell,
  toolCanDig,
} from "./movement.js";
import { createRng } from "./rng.js";
import {
  RuleViolation,
  type CampPlan,
  type ElevatorState,
  type GameCommand,
  type GameState,
  type Gem,
  type MinePlan,
  type OrderCard,
  type Plan,
  type PlayerDefinition,
  type PlayerState,
  type PublicOrderState,
} from "./types.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
type Draft = Mutable<GameState>;
type DraftPlayer = Mutable<PlayerState>;

const LOG_TURNS_KEPT = 30;

// ---------- 开局 ----------

export function createGame(players: PlayerDefinition[], seed: number = Math.floor(Math.random() * 2 ** 31)): GameState {
  if (players.length < 2 || players.length > 4) throw new RuleViolation("晶脉需要 2–4 名玩家。");
  const map = generateMap(seed);
  const rng = createRng(seed ^ 0x9e3779b9);
  const wells = rng.shuffle([0, 1, 2, 3, 4, 5]);

  const gems: Record<string, Gem> = {};
  for (const gem of map.gems) gems[gem.id] = gem;
  const mapGems = map.gems;

  const privatePool = rng.shuffle(PRIVATE_ORDERS.filter((order) => isOrderPossible(order.requirement, mapGems)));
  let dealt = 0;
  const dealOrder = (): OrderCard => {
    const def = privatePool[dealt % privatePool.length]!;
    dealt += 1;
    return { ...def, id: `${def.id}#${dealt}` };
  };

  const publicOrders: PublicOrderState[] = rng
    .shuffle(PUBLIC_ORDERS.filter((order) => isOrderPossible(order.requirement, mapGems)))
    .slice(0, PARAMS.publicOrders)
    .map((order) => ({ ...order, claimedBy: [] }));

  return {
    seed,
    rngState: rng.state,
    phase: "setup",
    turn: 0,
    players: players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      seat,
      status: "mine",
      cell: wellCells()[wells[seat]!]!,
      gold: PARAMS.startingGold,
      tools: [],
      bag: [],
      startWell: wells[seat]!,
      orderChoices: Array.from({ length: PARAMS.privateOrdersDrawn }, dealOrder),
      privateOrders: [],
      shatterPoints: 0,
      publicOrderPoints: 0,
      confirmed: false,
    })),
    gems,
    links: map.links,
    enabledKinds: map.enabledKinds,
    collapsedLayers: [],
    elevator: { layer: 0, direction: 1 },
    collapse: 0,
    vibration: 0,
    publicOrders,
    log: [],
    winnerIds: [],
    nextId: 1,
  };
}

function isOrderPossible(requirement: OrderRequirement, gems: Gem[]): boolean {
  const colors = new Map<GemColor, number>();
  for (const gem of gems) colors.set(gem.color, (colors.get(gem.color) ?? 0) + 1);
  switch (requirement.kind) {
    case "colors":
      return Object.entries(requirement.colors).every(([color, count]) => (colors.get(color as GemColor) ?? 0) >= count!);
    case "layer":
      return gems.filter((gem) => gem.layer === requirement.layer).length >= requirement.count;
    case "distinctColors":
      return colors.size >= requirement.count;
    default:
      return true;
  }
}

// ---------- 订单与计分 ----------

export function meetsRequirement(requirement: OrderRequirement, gems: Gem[]): boolean {
  switch (requirement.kind) {
    case "colors":
      return Object.entries(requirement.colors).every(
        ([color, count]) => gems.filter((gem) => gem.color === color).length >= count!,
      );
    case "layer":
      return gems.filter((gem) => gem.layer === requirement.layer).length >= requirement.count;
    case "distinctColors":
      return new Set(gems.map((gem) => gem.color)).size >= requirement.count;
    case "gemCount":
      return gems.length >= requirement.count;
    case "totalValue":
      return gems.reduce((sum, gem) => sum + gem.value, 0) >= requirement.value;
  }
}

export function vaultGems(state: GameState, playerId: string): Gem[] {
  return Object.values(state.gems).filter((gem) => gem.location.type === "vault" && gem.location.playerId === playerId);
}

export interface ScoreBreakdown {
  readonly vault: number;
  readonly shatter: number;
  readonly publicOrders: number;
  /** 别人的私人订单在对局中不公开，此时为 null。 */
  readonly privateOrders: number | null;
  readonly completedPrivate: number | null;
  readonly total: number;
}

export function scoreBreakdown(state: GameState, player: PlayerState): ScoreBreakdown {
  const gems = vaultGems(state, player.id);
  const vault = gems.reduce((sum, gem) => sum + gem.value, 0);
  const known = player.privateOrders.every((order) => !order.hidden);
  const completed = known ? player.privateOrders.filter((order) => meetsRequirement(order.requirement, gems)) : null;
  const privateOrders = completed ? completed.reduce((sum, order) => sum + order.reward, 0) : null;
  return {
    vault,
    shatter: player.shatterPoints,
    publicOrders: player.publicOrderPoints,
    privateOrders,
    completedPrivate: completed?.length ?? null,
    total: vault + player.shatterPoints + player.publicOrderPoints + (privateOrders ?? 0),
  };
}

export function describeRequirement(requirement: OrderRequirement): string {
  const names: Record<GemColor, string> = { cyan: "青", red: "赤", green: "翠", purple: "紫", gold: "金" };
  switch (requirement.kind) {
    case "colors":
      return Object.entries(requirement.colors).map(([color, count]) => `${count} 颗${names[color as GemColor]}色`).join(" + ");
    case "layer":
      return `${requirement.count} 颗${LAYER_DEFS[requirement.layer].name}（第${requirement.layer + 1}层）宝石`;
    case "distinctColors":
      return `${requirement.count} 种不同颜色`;
    case "gemCount":
      return `共 ${requirement.count} 颗宝石`;
    case "totalValue":
      return `总价值 ${requirement.value} 以上`;
  }
}

// ---------- 规划阶段的指令 ----------

function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((player) => state.phase === "setup" || player.status !== "retired");
}

function findPlayer(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new RuleViolation("你不在这局游戏里。");
  return player;
}

function canShop(state: GameState, player: PlayerState): boolean {
  return state.phase === "setup" || (state.phase === "play" && player.status === "camp");
}

export function applyCommand(state: GameState, playerId: string, command: GameCommand): GameState {
  if (state.phase === "finished") throw new RuleViolation("对局已经结束。");
  const player = findPlayer(state, playerId);
  if (player.status === "retired" && state.phase === "play") throw new RuleViolation("你已经收工了。");
  const draft = structuredClone(state) as Draft;
  const me = draft.players.find((candidate) => candidate.id === playerId)!;

  switch (command.type) {
    case "plan": {
      if (state.phase !== "play") throw new RuleViolation("对局还没开始。");
      if (player.confirmed) throw new RuleViolation("你已经确认了，先撤回再改。");
      const error = planError(state, player, command.plan);
      if (error) throw new RuleViolation(error);
      me.plan = structuredClone(command.plan) as Mutable<Plan>;
      break;
    }
    case "confirm": {
      if (state.phase === "setup" && player.privateOrders.length === 0) {
        throw new RuleViolation(`先从 ${PARAMS.privateOrdersDrawn} 张私人订单里选 ${PARAMS.privateOrdersKept} 张留下。`);
      }
      if (state.phase === "play" && !me.plan) me.plan = defaultPlan(player);
      me.confirmed = true;
      break;
    }
    case "unconfirm":
      me.confirmed = false;
      break;
    case "accept": {
      if (state.phase !== "play") throw new RuleViolation("对局还没开始。");
      if (command.from === null) {
        delete me.acceptFrom;
      } else {
        if (command.from === playerId || !state.players.some((other) => other.id === command.from)) {
          throw new RuleViolation("找不到这位玩家。");
        }
        me.acceptFrom = command.from;
      }
      break;
    }
    case "keepOrders": {
      if (state.phase !== "setup" || player.orderChoices.length === 0) throw new RuleViolation("现在不能选订单。");
      if (!player.orderChoices.some((order) => order.id === command.discardId)) throw new RuleViolation("没有这张订单。");
      me.privateOrders = me.orderChoices.filter((order) => order.id !== command.discardId);
      me.orderChoices = [];
      break;
    }
    case "buy": {
      if (!canShop(state, player)) throw new RuleViolation("只有在营地才能买工具。");
      const def = TOOL_DEFS[command.tool];
      if (!def) throw new RuleViolation("没有这种工具。");
      if (player.gold < def.price) throw new RuleViolation("金币不够。");
      if (freeSlots(state, player) < 1) throw new RuleViolation("背包没有空格了。");
      me.gold -= def.price;
      me.tools.push({ id: `t${draft.nextId}`, kind: command.tool, durability: def.durability });
      draft.nextId += 1;
      break;
    }
    case "discardTool": {
      if (!canShop(state, player)) throw new RuleViolation("只有在营地才能丢弃工具。");
      if (!player.tools.some((tool) => tool.id === command.toolId)) throw new RuleViolation("没有这件工具。");
      me.tools = me.tools.filter((tool) => tool.id !== command.toolId);
      break;
    }
    case "deposit":
    case "sell": {
      if (state.phase !== "play" || player.status !== "camp") throw new RuleViolation("只有在营地才能存入或卖出宝石。");
      if (!player.bag.includes(command.gemId)) throw new RuleViolation("背包里没有这颗宝石。");
      const gem = draft.gems[command.gemId]!;
      me.bag = me.bag.filter((id) => id !== command.gemId);
      if (command.type === "deposit") {
        gem.location = { type: "vault", playerId };
        gem.depositedTurn = state.turn;
      } else {
        me.gold += gem.value;
        gem.location = { type: "gone" };
      }
      break;
    }
    default:
      throw new RuleViolation("未知指令。");
  }

  const active = activePlayers(draft as GameState);
  if (active.length > 0 && active.every((candidate) => candidate.confirmed)) {
    return draft.phase === "setup" ? startPlay(draft as GameState) : resolveTurn(draft as GameState);
  }
  return draft as GameState;
}

function defaultPlan(player: PlayerState): Mutable<Plan> {
  return player.status === "camp" ? { kind: "stay" } : { kind: "wait" };
}

function isCampPlan(plan: Plan): plan is CampPlan {
  return plan.kind === "descend" || plan.kind === "stay" || plan.kind === "retire";
}

/** 规划时的合法性检查；返回错误说明，合法时返回 null。 */
export function planError(state: GameState, player: PlayerState, plan: Plan): string | null {
  if (player.status === "camp") {
    if (!isCampPlan(plan)) return "你在营地，只能选择下井、留守或收工。";
    if (plan.kind === "descend" && !(Number.isInteger(plan.well) && plan.well >= 0 && plan.well < 6)) return "请选择井口。";
    return null;
  }
  if (player.status !== "mine" || !player.cell) return "你现在不能行动。";
  if (isCampPlan(plan)) return "你在矿洞里。";
  const cell = player.cell;
  switch (plan.kind) {
    case "move": {
      if (!Array.isArray(plan.path)) return "路径无效。";
      const check = checkPath(state, player, plan.path);
      return check.ok ? null : check.error;
    }
    case "dig": {
      const gem = state.gems[plan.gemId];
      if (!gem || gem.location.type !== "wall") return "这里没有可挖的宝石。";
      if (!neighbors(cell).includes(gem.location.cell)) return "要站在宝石相邻的格子上才能挖。";
      const tool = player.tools.find((candidate) => candidate.id === plan.toolId);
      if (!tool) return "你没有这件工具。";
      if (TOOL_DEFS[tool.kind].progress === 0) return `${TOOL_DEFS[tool.kind].name}不能用来挖掘。`;
      if (!toolCanDig(gem, tool.kind)) return `${GEM_DEFS[gem.kind].name}不能用${TOOL_DEFS[tool.kind].name}挖。`;
      return null;
    }
    case "pickup": {
      const gem = state.gems[plan.gemId];
      if (!gem || gem.location.type !== "ground" || gem.location.cell !== cell) return "脚下没有这颗宝石。";
      if (freeSlots(state, player) < gemSlots(gem)) return "背包放不下。";
      return null;
    }
    case "handoff": {
      const target = state.players.find((candidate) => candidate.id === plan.to);
      if (!target || target.id === player.id) return "找不到交接对象。";
      if (!player.tools.some((tool) => tool.id === plan.itemId) && !player.bag.includes(plan.itemId)) return "你没有这件东西。";
      return null;
    }
    case "cut": {
      const tool = player.tools.find((candidate) => candidate.id === plan.toolId);
      if (tool?.kind !== "chisel") return "切割需要凿。";
      const gem = state.gems[plan.gemId];
      if (!gem || !gem.heavy) return "只能切割重型宝石。";
      const here = gem.location.type === "ground" && gem.location.cell === cell;
      if (!player.bag.includes(gem.id) && !here) return "宝石要在背包里或在脚下。";
      return null;
    }
    case "evacuate":
      return isWell(cell) >= 0 ? null : "要站在井口才能撤离。";
    case "wait":
      return null;
  }
}

// ---------- 准备阶段 → 第 1 回合 ----------

function startPlay(state: GameState): GameState {
  const draft = structuredClone(state) as Draft;
  draft.phase = "play";
  draft.turn = 1;
  for (const player of draft.players) {
    player.confirmed = false;
    delete player.plan;
  }
  draft.log.push({ turn: 0, events: ["所有矿队下井，开采季开始。"] });
  return draft as GameState;
}

/** 超时：没确认的人按待命（营地里按留守）处理，然后结算。 */
export function timeoutTurn(state: GameState): GameState {
  if (state.phase === "finished") return state;
  const draft = structuredClone(state) as Draft;
  for (const player of draft.players) {
    if (player.confirmed || (state.phase === "play" && player.status === "retired")) continue;
    if (state.phase === "setup") {
      if (player.privateOrders.length === 0) {
        player.privateOrders = player.orderChoices.slice(0, PARAMS.privateOrdersKept);
        player.orderChoices = [];
      }
    } else {
      player.plan = defaultPlan(player as PlayerState);
    }
    player.confirmed = true;
  }
  return draft.phase === "setup" ? startPlay(draft as GameState) : resolveTurn(draft as GameState);
}

// ---------- 结算 ----------

export function nextElevator(state: GameState): ElevatorState | null {
  const maxLayer = ([2, 1, 0] as const).find((layer) => !isCollapsed(state, layer)) ?? 0;
  if (maxLayer === 0) return null;
  let { layer, direction } = state.elevator;
  if (layer > maxLayer) return { layer: maxLayer, direction: -1 };
  let next = layer + direction;
  if (next < 0 || next > maxLayer) {
    direction = -direction as 1 | -1;
    next = layer + direction;
  }
  return { layer: next as LayerIndex, direction };
}

export function resolveTurn(state: GameState): GameState {
  const draft = structuredClone(state) as Draft;
  const rng = createRng(state.rngState);
  const events: string[] = [];
  const name = (id: string) => draft.players.find((player) => player.id === id)?.name ?? "?";
  const gemName = (gem: Mutable<Gem>) => `${GEM_DEFS[gem.kind].name}${gem.cut ? "碎块" : ""}`;
  const readonly = () => draft as GameState;
  const byId = (id: string) => draft.players.find((player) => player.id === id)!;
  const statusAtStart = new Map(state.players.map((player) => [player.id, player.status]));
  const minePlan = (player: DraftPlayer): MinePlan | undefined =>
    statusAtStart.get(player.id) === "mine" && player.plan && !isCampPlan(player.plan as Plan)
      ? (player.plan as MinePlan)
      : undefined;

  const damageTool = (player: DraftPlayer, toolId: string) => {
    const tool = player.tools.find((candidate) => candidate.id === toolId);
    if (!tool || tool.durability === null) return;
    tool.durability -= 1;
    if (tool.durability <= 0) {
      player.tools = player.tools.filter((candidate) => candidate.id !== toolId);
      events.push(`${player.name} 的${TOOL_DEFS[tool.kind].name}用坏了。`);
    }
  };

  const shatter = (gem: Mutable<Gem>) => {
    const pool = gem.value * PARAMS.shatterShare;
    const total = Object.values(gem.contributions).reduce((sum, value) => sum + value, 0);
    const shares = Object.entries(gem.contributions).map(([id, amount]) => {
      const points = Math.floor((pool * amount) / total);
      byId(id).shatterPoints += points;
      return `${name(id)} +${points}`;
    });
    gem.location = { type: "gone" };
    events.push(`${gemName(gem)}多人出力、没有契约，碎裂了：${shares.join("，")}。`);
  };

  // 1. 合约：v1 未实现。

  // 2. 移动
  for (const player of draft.players) {
    const plan = minePlan(player);
    if (plan?.kind !== "move") continue;
    const check = checkPath(state, findPlayer(state, player.id), plan.path);
    if (!check.ok) {
      events.push(`${player.name} 的移动无效（${check.error}），原地待命。`);
      continue;
    }
    const fromLayer = parseCell(player.cell!).layer;
    player.cell = plan.path[plan.path.length - 1]!;
    const toLayer = parseCell(player.cell).layer;
    events.push(fromLayer === toLayer
      ? `${player.name} 走了 ${plan.path.length} 步。`
      : `${player.name} 从${LAYER_DEFS[fromLayer].name}到了${LAYER_DEFS[toLayer].name}。`);
    for (let jump = 0; jump < check.holes; jump += 1) {
      if (hasTool(player as PlayerState, "rope")) continue;
      const breakable = player.tools.filter((tool) => tool.durability !== null);
      if (breakable.length === 0) continue;
      const tool = rng.pick(breakable);
      events.push(`${player.name} 跳下洞口，${TOOL_DEFS[tool.kind].name}磕坏了一点。`);
      damageTool(player, tool.id);
    }
  }

  // 3. 动作：挖掘、拾取、切割、交接、撤离同时生效
  let turnVibration = 0;
  const digs = draft.players.flatMap((player) => {
    const plan = minePlan(player);
    if (plan?.kind !== "dig" || !player.cell) return [];
    const gem = draft.gems[plan.gemId];
    const tool = player.tools.find((candidate) => candidate.id === plan.toolId);
    if (!gem || gem.location.type !== "wall" || !tool || !neighbors(player.cell).includes(gem.location.cell) || !toolCanDig(gem as Gem, tool.kind)) {
      events.push(`${player.name} 的挖掘落空了。`);
      return [];
    }
    return [{ player, gem, tool }];
  });
  for (const { player, gem, tool } of digs) {
    const def = TOOL_DEFS[tool.kind];
    let progress = def.progress;
    if (GEM_DEFS[gem.kind].trait === "resonance") {
      const partners = digs.filter((other) => other.gem.id === gem.id && other.tool.kind === "fork").length;
      if (partners < 2) progress = 0;
    }
    if (tool.kind === "dynamite") gem.value = Math.floor(gem.value * PARAMS.dynamiteValueFactor);
    gem.progress += progress;
    if (progress > 0) gem.contributions[player.id] = (gem.contributions[player.id] ?? 0) + progress;
    turnVibration += def.vibration;
    events.push(progress > 0
      ? `${player.name} 用${def.name}挖${gemName(gem)}，进度 ${Math.min(gem.progress, gem.hardness)}/${gem.hardness}。`
      : `${player.name} 独自用共鸣叉敲${gemName(gem)}，没有共鸣，进度不变。`);
    damageTool(player, tool.id);
  }

  // 拾取：同一颗被多人同时拾取，按共同挖掘处理（每人贡献 1）。
  const pickups = new Map<string, DraftPlayer[]>();
  for (const player of draft.players) {
    const plan = minePlan(player);
    if (plan?.kind !== "pickup") continue;
    const gem = draft.gems[plan.gemId];
    if (!gem || gem.location.type !== "ground" || gem.location.cell !== player.cell) {
      events.push(`${player.name} 没捡到东西。`);
      continue;
    }
    pickups.set(gem.id, [...(pickups.get(gem.id) ?? []), player]);
  }
  for (const [gemId, pickers] of pickups) {
    const gem = draft.gems[gemId]!;
    if (pickers.length > 1) {
      gem.contributions = Object.fromEntries(pickers.map((player) => [player.id, 1]));
      shatter(gem);
      continue;
    }
    const picker = pickers[0]!;
    if (freeSlots(readonly(), picker as PlayerState) < gemSlots(gem as Gem)) {
      events.push(`${picker.name} 的背包放不下${gemName(gem)}。`);
      continue;
    }
    gem.location = { type: "bag", playerId: picker.id };
    picker.bag.push(gem.id);
    events.push(`${picker.name} 捡起了${gemName(gem)}。`);
  }

  for (const player of draft.players) {
    const plan = minePlan(player);
    if (plan?.kind !== "cut") continue;
    const gem = draft.gems[plan.gemId];
    const chisel = player.tools.find((tool) => tool.id === plan.toolId && tool.kind === "chisel");
    const inBag = gem !== undefined && player.bag.includes(gem.id);
    const here = gem?.location.type === "ground" && gem.location.cell === player.cell;
    if (!gem || !gem.heavy || !chisel || (!inBag && !here)) {
      events.push(`${player.name} 没能切割。`);
      continue;
    }
    const value = Math.floor(gem.value * PARAMS.cutShare);
    const location = gem.location;
    gem.location = { type: "gone" };
    const pieces = [0, 1].map(() => {
      const id = `g${draft.nextId}c`;
      draft.nextId += 1;
      draft.gems[id] = { ...structuredClone(gem), id, value, heavy: false, cut: true, location: structuredClone(location), contributions: {} };
      return id;
    });
    if (inBag) player.bag = [...player.bag.filter((id) => id !== gem.id), ...pieces];
    damageTool(player, chisel.id);
    events.push(`${player.name} 把${gemName(gem)}切成两块，每块值 ${value}。`);
  }

  for (const player of draft.players) {
    const plan = minePlan(player);
    if (plan?.kind !== "handoff") continue;
    const target = draft.players.find((candidate) => candidate.id === plan.to);
    const tool = player.tools.find((candidate) => candidate.id === plan.itemId);
    const gemId = player.bag.includes(plan.itemId) ? plan.itemId : undefined;
    const slots = tool ? 1 : gemId ? gemSlots(draft.gems[gemId] as Gem) : 0;
    if (!target || target.status !== "mine" || target.cell !== player.cell || target.acceptFrom !== player.id) {
      events.push(`${player.name} 的交接没有成功（对方要和你同格，并设置接收你的交接）。`);
      continue;
    }
    if (slots === 0 || freeSlots(readonly(), target as PlayerState) < slots) {
      events.push(`${player.name} 的交接没有成功（${target.name} 的背包放不下）。`);
      continue;
    }
    if (tool) {
      player.tools = player.tools.filter((candidate) => candidate.id !== tool.id);
      target.tools.push(tool);
      events.push(`${player.name} 把${TOOL_DEFS[tool.kind].name}交给了 ${target.name}。`);
    } else {
      player.bag = player.bag.filter((id) => id !== gemId);
      target.bag.push(gemId!);
      draft.gems[gemId!]!.location = { type: "bag", playerId: target.id };
      events.push(`${player.name} 把${gemName(draft.gems[gemId!]!)}交给了 ${target.name}。`);
    }
  }

  const evacuating = new Set(
    draft.players.filter((player) => minePlan(player)?.kind === "evacuate" && player.cell && isWell(player.cell) >= 0).map((player) => player.id),
  );

  // 4. 出土
  for (const gem of Object.values(draft.gems)) {
    if (gem.location.type !== "wall" || gem.progress < gem.hardness) continue;
    const cell = gem.location.cell;
    const contributors = Object.keys(gem.contributions);
    if (contributors.length > 1) {
      shatter(gem);
      continue;
    }
    const owner = byId(contributors[0]!);
    if (freeSlots(readonly(), owner as PlayerState) >= gemSlots(gem as Gem)) {
      gem.location = { type: "bag", playerId: owner.id };
      owner.bag.push(gem.id);
      events.push(`${owner.name} 挖出了${gemName(gem)}（价值 ${gem.value}），放进背包。`);
    } else {
      gem.location = { type: "ground", cell };
      events.push(`${owner.name} 挖出了${gemName(gem)}，背包放不下，留在了原地。`);
    }
  }

  // 5. 电梯
  const next = nextElevator(readonly());
  if (next) {
    const stop = centerCell(draft.elevator.layer);
    const riders = draft.players.filter((player) => player.status === "mine" && player.cell === stop && !evacuating.has(player.id));
    for (const rider of riders) rider.cell = centerCell(next.layer);
    if (riders.length > 0) {
      events.push(`${riders.map((rider) => rider.name).join("、")} 乘电梯到了${LAYER_DEFS[next.layer].name}。`);
    }
    draft.elevator = next;
  }

  // 6. 环境
  for (const gem of Object.values(draft.gems)) {
    const trait = GEM_DEFS[gem.kind].trait;
    if (trait === "growth" && gem.location.type === "wall") gem.value = Math.min(GROWTH_CAP, gem.value + 1);
    if (trait === "decay" && (gem.location.type === "ground" || gem.location.type === "bag")) {
      const carrier = gem.location.type === "bag" ? byId(gem.location.playerId) : undefined;
      if (carrier && hasTool(carrier as PlayerState, "shade") && !gem.decaySkipped) {
        gem.decaySkipped = true;
      } else {
        gem.decaySkipped = false;
        gem.value = Math.max(0, gem.value - 1);
      }
    }
  }

  draft.vibration += turnVibration;
  const fromVibration = Math.floor(draft.vibration / PARAMS.vibrationPerCollapse);
  draft.vibration %= PARAMS.vibrationPerCollapse;
  draft.collapse += 1 + fromVibration;

  for (const layer of [2, 1] as const) {
    if (draft.collapse < LAYER_DEFS[layer].collapseAt || draft.collapsedLayers.includes(layer)) continue;
    draft.collapsedLayers.push(layer);
    events.push(`⚠ ${LAYER_DEFS[layer].name}塌方了！`);
    for (const gem of Object.values(draft.gems)) {
      const location = gem.location;
      if ((location.type === "wall" || location.type === "ground") && parseCell(location.cell).layer === layer) {
        gem.location = { type: "gone" };
      }
    }
    for (const player of draft.players) {
      if (player.status !== "mine" || !player.cell || parseCell(player.cell).layer !== layer) continue;
      const lost = player.bag.length;
      for (const id of player.bag) draft.gems[id]!.location = { type: "gone" };
      player.bag = [];
      player.status = "camp";
      delete player.cell;
      events.push(`${player.name} 被困在${LAYER_DEFS[layer].name}，失去了背包里的 ${lost} 颗宝石，被救回营地。`);
    }
    if (draft.elevator.layer >= layer) draft.elevator = { layer: (layer - 1) as LayerIndex, direction: -1 };
  }

  for (const player of draft.players) {
    if (evacuating.has(player.id) && player.status === "mine") {
      player.status = "camp";
      delete player.cell;
      events.push(`${player.name} 撤回了营地。`);
    }
    if (statusAtStart.get(player.id) !== "camp" || !player.plan) continue;
    const plan = player.plan as CampPlan;
    if (plan.kind === "descend") {
      player.status = "mine";
      player.cell = wellCells()[plan.well]!;
      events.push(`${player.name} 从 ${plan.well + 1} 号井口下井。`);
    } else if (plan.kind === "retire") {
      player.status = "retired";
      events.push(`${player.name} 收工了。`);
    }
  }

  claimPublicOrders(draft, events);

  const finished = draft.collapse >= LAYER_DEFS[0].collapseAt || draft.players.every((player) => player.status === "retired");
  if (finished) finishGame(draft, events);

  draft.log = [...draft.log, { turn: state.turn, events }].slice(-LOG_TURNS_KEPT);
  draft.rngState = rng.state;
  if (!finished) draft.turn += 1;
  for (const player of draft.players) {
    player.confirmed = player.status === "retired";
    delete player.plan;
    delete player.acceptFrom;
  }
  return draft as GameState;
}

function claimPublicOrders(draft: Draft, events: string[]): void {
  for (const order of draft.publicOrders) {
    if (order.claimedBy.length > 0) continue;
    const winners = draft.players.filter((player) => meetsRequirement(order.requirement, vaultGems(draft as GameState, player.id)));
    if (winners.length === 0) continue;
    const points = Math.floor(order.reward / winners.length);
    order.claimedBy = winners.map((player) => player.id);
    order.claimedTurn = draft.turn;
    for (const player of winners) player.publicOrderPoints += points;
    events.push(`公共订单「${order.name}」被 ${winners.map((player) => player.name).join("、")} 拿下，+${points}。`);
  }
}

function finishGame(draft: Draft, events: string[]): void {
  draft.phase = "finished";
  if (draft.collapse >= LAYER_DEFS[0].collapseAt) {
    draft.collapsedLayers = [2, 1, 0];
    events.push("⚠ 整个矿洞塌毁，开采季结束。");
  } else {
    events.push("所有矿队都已收工，开采季结束。");
  }
  for (const player of draft.players) {
    if (player.status === "mine") {
      if (player.bag.length > 0) events.push(`${player.name} 还在井下，失去了背包里的 ${player.bag.length} 颗宝石。`);
      for (const id of player.bag) draft.gems[id]!.location = { type: "gone" };
    } else {
      for (const id of player.bag) {
        draft.gems[id]!.location = { type: "vault", playerId: player.id };
        draft.gems[id]!.depositedTurn = draft.turn;
      }
    }
    player.bag = [];
  }
  claimPublicOrders(draft, events);

  const ranked = draft.players.map((player) => {
    const score = scoreBreakdown(draft as GameState, player as PlayerState);
    return { id: player.id, total: score.total, completed: score.completedPrivate ?? 0, gold: player.gold };
  });
  const best = ranked.reduce((top, entry) => {
    if (!top) return entry;
    if (entry.total !== top.total) return entry.total > top.total ? entry : top;
    if (entry.completed !== top.completed) return entry.completed > top.completed ? entry : top;
    return entry.gold > top.gold ? entry : top;
  });
  draft.winnerIds = ranked
    .filter((entry) => entry.total === best.total && entry.completed === best.completed && entry.gold === best.gold)
    .map((entry) => entry.id);
}

// ---------- 发给各玩家的视图 ----------

const HIDDEN_ORDER: OrderDefinition = {
  id: "hidden",
  name: "未公开",
  requirement: { kind: "gemCount", count: 0 },
  reward: 0,
};

/** 隐藏别人的私人订单和尚未结算的行动；结束后全部公开。 */
export function redactGameForViewer(state: GameState, viewerId: string): GameState {
  if (state.phase === "finished") return { ...state, rngState: 0 };
  return {
    ...state,
    rngState: 0,
    players: state.players.map((player) => {
      if (player.id === viewerId) return player;
      const { plan: _plan, ...rest } = player;
      return {
        ...rest,
        privateOrders: player.privateOrders.map((_, index) => ({ ...HIDDEN_ORDER, id: `hidden-${index}`, hidden: true })),
        orderChoices: player.orderChoices.map((_, index) => ({ ...HIDDEN_ORDER, id: `hidden-choice-${index}`, hidden: true })),
      };
    }),
  };
}

export function collapseWarning(state: GameState): { layer: LayerIndex; remaining: number } | null {
  for (const layer of [2, 1, 0] as const) {
    if (state.collapsedLayers.includes(layer)) continue;
    const remaining = LAYER_DEFS[layer].collapseAt - state.collapse;
    return remaining <= PARAMS.collapseWarning ? { layer, remaining } : null;
  }
  return null;
}

export type { CellKey };
