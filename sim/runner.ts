// 模拟器的公共部分：跑一局（runGame）、逐回合分析、把一批对局汇总成统计（summarize）。
// simulate.ts（主实验）和 balance.ts（规则调整实验）都用它。

import {
  GEM_DEFS,
  GEM_KINDS,
  LAYER_DEFS,
  PARAMS,
  RuleViolation,
  TOOL_KINDS,
  applyCommand,
  centerCell,
  createGame,
  freeSlots,
  meetsRequirement,
  redactGameForViewer,
  scoreBreakdown,
  timeoutTurn,
  vaultGems,
  type GameCommand,
  type GameState,
  type GemKind,
  type Plan,
  type ToolKind,
} from "@jingmai/game";
import { ALL_STRATEGIES, STRATEGIES, createTeam, makeRng, retireReasons, rules, type Bot, type StrategyId, type Team } from "./bots.js";
import { layerOf } from "./pathing.js";

// ---------- 逐局记录 ----------

export type Fate = "stored" | "shattered" | "buried" | "lostCarried" | "sold" | "left";
const FATES: readonly Fate[] = ["stored", "shattered", "buried", "lostCarried", "sold", "left"];

export interface PlayerRow {
  strategy: StrategyId;
  seat: number;
  total: number;
  vault: number;
  shatter: number;
  publicOrders: number;
  privateOrders: number;
  privateHeld: string[];
  privateDone: string[];
  winShare: number;
  won: boolean;
  rank: number;
  gold: number;
  endStatus: "mine" | "camp" | "retired";
  retiredTurn: number | null;
  trips: number;
  trapped: number;
  lostToCollapse: number;
  lostAtEnd: number;
  digs: Record<ToolKind, number>;
  bought: Record<ToolKind, number>;
  vaultByKind: Partial<Record<GemKind, number>>;
  vaultCountByKind: Partial<Record<GemKind, number>>;
  shatterByKind: Partial<Record<GemKind, number>>;
  digsByKind: Partial<Record<GemKind, number>>;
  soldValue: number;
  soldCount: number;
  maxLayer: number;
  elevatorRides: number;
  invalid: number;
  /** 共鸣契约（只在规则实验里）：持宝人 / 合伙人。 */
  role: "carrier" | "partner" | null;
  /** 和搭档一起挖出的共鸣晶（记在持宝人名下）。 */
  pactGems: number;
  /** 作为合伙人按约分到的分。 */
  pactShare: number;
  /** 背约罚分。 */
  pactPenalty: number;
  betrayals: number;
  betrayed: number;
}

export interface GameRow {
  experiment: string;
  seed: number;
  players: number;
  endReason: "collapse" | "retired" | "timeout";
  endTurn: number;
  /** 结束时的塌方进度（满 40 整个矿洞塌毁）。 */
  endCollapse: number;
  collapseTurn: { 1: number | null; 2: number | null };
  vibrationTotal: number;
  enabledKinds: GemKind[];
  fates: Partial<Record<GemKind, Partial<Record<Fate, number>>>>;
  publicClaims: { name: string; turn: number | null; winners: StrategyId[] }[];
  rows: PlayerRow[];
}

export interface DemoTurn {
  turn: number;
  collapse: number;
  players: { total: number; layer: number | null; status: string; bag: number; plan: string }[];
  events: string[];
}

const zeroTools = () => Object.fromEntries(TOOL_KINDS.map((kind) => [kind, 0])) as Record<ToolKind, number>;

/** 数据核对：碎裂分重算对不上的次数、引擎异常、被拒指令的原因。 */
export const checks = {
  shatterMismatches: 0,
  engineErrors: 0,
  engineErrorSamples: [] as string[],
  invalidReasons: new Map<string, number>(),
};

/**
 * 规则实验。apply 直接改引擎导入的数据对象（每个实验在自己的进程里跑，互不影响）；
 * tremor、pact 是只在模拟器里试的新规则，不改游戏本身。
 */
export interface Variant {
  readonly name: string;
  readonly description: string;
  readonly apply?: () => void;
  /** 每回合结算后，矿洞余震让塌方额外 +1 的概率。 */
  readonly tremor?: number;
  /**
   * 红区大震：塌方进度到 from 以后，每回合结算后有 chance 的概率大震，塌方直接跳到 39，
   * 也就是下一回合结束时整个矿洞塌毁。
   */
  readonly quake?: { readonly from: number; readonly chance: number; readonly to?: number };
  /**
   * 共鸣契约：签约的两人一起挖出的共鸣晶不碎裂，进持宝人的背包。
   * 持宝人存入时履约：宝石价值 ×(1 + bonus) 两人平分（合伙人那份直接计分）；
   * 背约：持宝人独吞原价，扣 betrayPenalty 分，合伙人什么都拿不到。
   */
  readonly pact?: { readonly bonus: number; readonly betrayPenalty: number; readonly partnerShare?: number };
}

export interface RunOptions {
  readonly record?: boolean;
  readonly variant?: Variant;
}

function planLabel(plan: Plan | undefined): string {
  if (!plan) return "—";
  switch (plan.kind) {
    case "move": return `move ${plan.path.length}`;
    case "dig": return "dig";
    case "descend": return `descend ${plan.well + 1}`;
    default: return plan.kind;
  }
}

export function runGame(experiment: string, seed: number, strategies: readonly StrategyId[], options: RunOptions = {}): { game: GameRow; demo?: DemoTurn[] } {
  const { record = false, variant } = options;
  const definitions = strategies.map((strategy, index) => ({ id: `p${index + 1}`, name: `${STRATEGIES[strategy].name}${index + 1}` }));
  let state = createGame(definitions, seed);
  // 合伙人两两组队：前一个座位当持宝人；持宝人是背约者时，这一队存入时会背约。
  const teamSeats = strategies.flatMap((strategy, index) => (strategy === "partner" || strategy === "traitor" ? [index] : []));
  const teams: Team[] = [];
  for (let index = 0; index + 1 < teamSeats.length; index += 2) {
    const [carrier, partner] = [teamSeats[index]!, teamSeats[index + 1]!];
    teams.push(createTeam([definitions[carrier]!.id, definitions[partner]!.id], strategies[carrier] === "traitor"));
  }
  const teamOf = (index: number) => teams.find((team) => team.members.includes(definitions[index]!.id));
  const bots: Bot[] = strategies.map((strategy, index) => {
    const team = teamOf(index);
    return STRATEGIES[strategy].create(makeRng(seed * 7919 + index * 104729 + 1), team ? { team } : {});
  });
  const tremorRng = makeRng(seed * 31 + 7);
  // 红区是公开规则：告诉机器人从哪里开始可能大震。
  rules.redZone = variant?.quake?.from ?? Infinity;
  /** 契约生效、还没存入的共鸣晶 → 所属的队。 */
  const pactGems = new Map<string, Team>();
  const seatOf = (id: string) => definitions.findIndex((definition) => definition.id === id);
  const rows: PlayerRow[] = strategies.map((strategy, seat) => ({
    strategy, seat, total: 0, vault: 0, shatter: 0, publicOrders: 0, privateOrders: 0, privateHeld: [], privateDone: [],
    winShare: 0, won: false, rank: 0, gold: 0, endStatus: "camp", retiredTurn: null, trips: 1, trapped: 0, lostToCollapse: 0,
    lostAtEnd: 0, digs: zeroTools(), bought: zeroTools(), vaultByKind: {}, vaultCountByKind: {}, shatterByKind: {}, digsByKind: {},
    soldValue: 0, soldCount: 0, maxLayer: 0, elevatorRides: 0, invalid: 0,
    role: null, pactGems: 0, pactShare: 0, pactPenalty: 0, betrayals: 0, betrayed: 0,
  }));
  for (const team of teams) {
    rows[seatOf(team.carrier)]!.role = "carrier";
    rows[seatOf(team.members.find((id) => id !== team.carrier)!)]!.role = "partner";
  }

  /** 持宝人存入共鸣晶：按约分成或背约。 */
  const settlePact = (gemId: string) => {
    const team = pactGems.get(gemId);
    const pact = variant?.pact;
    if (!team || !pact) return;
    pactGems.delete(gemId);
    const next = structuredClone(state) as { -readonly [K in keyof GameState]: any };
    const gem = next.gems[gemId];
    const carrier = next.players.find((player: { id: string }) => player.id === team.carrier);
    const partnerId = team.members.find((id) => id !== team.carrier)!;
    const partner = next.players.find((player: { id: string }) => player.id === partnerId);
    if (team.betray) {
      carrier.shatterPoints -= pact.betrayPenalty;
      rows[seatOf(team.carrier)]!.pactPenalty += pact.betrayPenalty;
      rows[seatOf(team.carrier)]!.betrayals += 1;
      rows[seatOf(partnerId)]!.betrayed += 1;
    } else {
      // 合伙人那份直接计分；持宝人那份留在营地里（还能算订单）。
      const pool = gem.value * (1 + pact.bonus);
      const share = Math.round(pool * (pact.partnerShare ?? 0.5));
      gem.value = Math.round(pool) - share;
      partner.shatterPoints += share;
      rows[seatOf(partnerId)]!.pactShare += share;
    }
    state = next as GameState;
  };
  const fateOf = new Map<string, Fate>();
  const collapseTurn: GameRow["collapseTurn"] = { 1: null, 2: null };
  const demo: DemoTurn[] = [];

  const apply = (index: number, command: GameCommand): boolean => {
    const id = definitions[index]!.id;
    const before = state;
    try {
      state = applyCommand(state, id, command);
    } catch (error) {
      if (error instanceof RuleViolation) {
        rows[index]!.invalid += 1;
        const key = `${rows[index]!.strategy} ${command.type}${command.type === "plan" ? `:${command.plan.kind}` : ""} → ${error.message}`;
        checks.invalidReasons.set(key, (checks.invalidReasons.get(key) ?? 0) + 1);
      } else {
        checks.engineErrors += 1;
        if (checks.engineErrorSamples.length < 5) checks.engineErrorSamples.push(`${command.type}: ${(error as Error).message}`);
      }
      return false;
    }
    if (command.type === "buy") rows[index]!.bought[command.tool] += 1;
    if (command.type === "deposit" && pactGems.has(command.gemId)) settlePact(command.gemId);
    if (command.type === "sell") {
      const gem = before.gems[command.gemId]!;
      rows[index]!.soldValue += gem.value;
      rows[index]!.soldCount += 1;
      fateOf.set(gem.id, "sold");
    }
    return true;
  };

  // 准备阶段
  state.players.forEach((player, index) => {
    for (const command of bots[index]!.setup(redactGameForViewer(state, player.id), redactGameForViewer(state, player.id).players[index]!)) apply(index, command);
  });
  if (state.phase === "setup") state = timeoutTurn(state);

  while (state.phase === "play" && state.turn <= 80) {
    const plans = new Map<string, Plan>();
    state.players.forEach((player, index) => {
      if (player.status === "retired") return;
      const view = redactGameForViewer(state, player.id);
      for (const command of bots[index]!.turn(view, view.players[index]!)) {
        if (command.type === "confirm") continue;
        if (apply(index, command) && command.type === "plan") plans.set(player.id, command.plan);
      }
    });
    const before = state;
    state.players.forEach((player, index) => {
      if (player.status !== "retired" && !state.players[index]!.confirmed) apply(index, { type: "confirm" });
    });
    // 正常情况下最后一人确认就会结算；万一没结算（指令出错），按超时处理，免得卡住。
    if (state.phase === "play" && state.turn === before.turn) state = timeoutTurn(state);
    if (variant?.pact && state.phase === "play") state = applyPact(before, state, teams, pactGems, rows, seatOf);
    if (variant?.tremor && state.phase === "play" && tremorRng.next() < variant.tremor) state = { ...state, collapse: state.collapse + 1 };
    const quake = variant?.quake;
    const quakeTo = quake?.to ?? 39;
    if (quake && state.phase === "play" && state.collapse >= quake.from && state.collapse < quakeTo && tremorRng.next() < quake.chance) {
      state = { ...state, collapse: quakeTo };
    }
    analyzeTurn(before, state, plans, rows, fateOf, collapseTurn);
    if (record) {
      demo.push({
        turn: before.turn,
        collapse: state.collapse,
        players: state.players.map((player) => ({
          total: scoreBreakdown(state, player).total,
          layer: player.status === "mine" && player.cell ? layerOf(player.cell) : null,
          status: player.status,
          bag: player.bag.length,
          plan: planLabel(plans.get(player.id)),
        })),
        events: state.log.at(-1)?.turn === before.turn ? [...state.log.at(-1)!.events] : [],
      });
    }
  }

  // 对局结束时还没存入的契约宝石（被结算自动存入营地）：照常按约分成或背约，再重新排名。
  if (variant?.pact) {
    let settled = false;
    for (const gemId of [...pactGems.keys()]) {
      if (state.gems[gemId]?.location.type === "vault") {
        settlePact(gemId);
        settled = true;
      }
    }
    if (settled && state.phase === "finished") state = { ...state, winnerIds: rankWinners(state) };
  }

  // 结算
  const finished = state.phase === "finished";
  const endReason: GameRow["endReason"] = !finished ? "timeout" : state.collapse >= LAYER_DEFS[0].collapseAt ? "collapse" : "retired";
  const totals = state.players.map((player) => scoreBreakdown(state, player));
  const ranking = [...totals].map((score) => score.total).sort((a, b) => b - a);
  state.players.forEach((player, index) => {
    const row = rows[index]!;
    const score = totals[index]!;
    row.total = score.total;
    row.vault = score.vault;
    // 契约分和背约罚分记在引擎的碎裂分里，这里拆出来单独统计。
    row.shatter = score.shatter - row.pactShare + row.pactPenalty;
    row.publicOrders = score.publicOrders;
    row.privateOrders = score.privateOrders ?? 0;
    const vault = vaultGems(state, player.id);
    row.privateHeld = player.privateOrders.map((order) => order.name);
    row.privateDone = player.privateOrders.filter((order) => meetsRequirement(order.requirement, vault)).map((order) => order.name);
    row.won = state.winnerIds.includes(player.id);
    row.winShare = row.won ? 1 / state.winnerIds.length : 0;
    row.rank = ranking.indexOf(score.total) + 1;
    row.gold = player.gold;
    row.endStatus = player.status;
    for (const gem of vault) {
      row.vaultByKind[gem.kind] = (row.vaultByKind[gem.kind] ?? 0) + gem.value;
      row.vaultCountByKind[gem.kind] = (row.vaultCountByKind[gem.kind] ?? 0) + 1;
    }
  });

  const fates: GameRow["fates"] = {};
  for (const gem of Object.values(state.gems)) {
    let fate = fateOf.get(gem.id);
    if (gem.location.type === "vault") fate = "stored";
    if (!fate && (gem.location.type === "wall" || gem.location.type === "ground")) fate = "left";
    if (!fate) continue;
    const entry = (fates[gem.kind] ??= {});
    entry[fate] = (entry[fate] ?? 0) + 1;
  }

  const game: GameRow = {
    experiment,
    seed,
    players: strategies.length,
    endReason,
    endTurn: state.turn,
    endCollapse: Math.min(state.collapse, LAYER_DEFS[0].collapseAt),
    collapseTurn,
    vibrationTotal: state.collapse - state.turn,
    enabledKinds: [...state.enabledKinds],
    fates,
    publicClaims: state.publicOrders.map((order) => ({
      name: order.name,
      turn: order.claimedTurn ?? null,
      winners: order.claimedBy.map((id) => strategies[Number(id.slice(1)) - 1]!),
    })),
    rows,
  };
  return record ? { game, demo } : { game };
}

/** 和引擎 finishGame 一样的排名：总分，其次完成的私人订单数，再其次金币。 */
function rankWinners(state: GameState): string[] {
  const ranked = state.players.map((player) => {
    const score = scoreBreakdown(state, player);
    return { id: player.id, total: score.total, completed: score.completedPrivate ?? 0, gold: player.gold };
  });
  const best = ranked.reduce((top, entry) => {
    if (entry.total !== top.total) return entry.total > top.total ? entry : top;
    if (entry.completed !== top.completed) return entry.completed > top.completed ? entry : top;
    return entry.gold > top.gold ? entry : top;
  });
  return ranked.filter((entry) => entry.total === best.total && entry.completed === best.completed && entry.gold === best.gold).map((entry) => entry.id);
}

/**
 * 共鸣契约：一队两人一起挖出的共鸣晶，引擎按现行规则让它碎裂了；这里撤销碎裂分，
 * 把宝石放进持宝人的背包（放不下就留在原地），等存入时再按约结算。
 */
function applyPact(
  before: GameState,
  after: GameState,
  teams: readonly Team[],
  pactGems: Map<string, Team>,
  rows: PlayerRow[],
  seatOf: (id: string) => number,
): GameState {
  let next: any = null;
  for (const [id, gem] of Object.entries(after.gems)) {
    const previous = before.gems[id];
    if (!previous || previous.location.type !== "wall" || gem.location.type !== "gone") continue;
    if (GEM_DEFS[gem.kind].trait !== "resonance" || gem.progress < gem.hardness) continue;
    const contributors = Object.keys(gem.contributions);
    const team = teams.find((candidate) => contributors.length >= 2 && contributors.every((member) => candidate.members.includes(member)));
    if (!team) continue;
    next ??= structuredClone(after);
    const total = contributors.reduce((sum, member) => sum + gem.contributions[member]!, 0);
    const pool = gem.value * PARAMS.shatterShare;
    for (const member of contributors) {
      const player = next.players.find((candidate: { id: string }) => candidate.id === member);
      player.shatterPoints -= Math.floor((pool * gem.contributions[member]!) / total);
    }
    const carrier = next.players.find((candidate: { id: string }) => candidate.id === team.carrier);
    const target = next.gems[id];
    if (carrier.status === "mine" && freeSlots(next, carrier) >= 1) {
      target.location = { type: "bag", playerId: carrier.id };
      carrier.bag.push(id);
    } else {
      target.location = { type: "ground", cell: previous.location.cell };
    }
    next.log[next.log.length - 1]?.events.push(`共鸣契约生效：${carrier.name} 带着共鸣晶。`);
    pactGems.set(id, team);
    rows[seatOf(team.carrier)]!.pactGems += 1;
  }
  return next ?? after;
}

function analyzeTurn(
  before: GameState,
  after: GameState,
  plans: Map<string, Plan>,
  rows: PlayerRow[],
  fateOf: Map<string, Fate>,
  collapseTurn: GameRow["collapseTurn"],
): void {
  const cutIds = new Set([...plans.values()].flatMap((plan) => (plan.kind === "cut" ? [plan.gemId] : [])));
  const newlyCollapsed = after.collapsedLayers.filter((layer) => layer > 0 && !before.collapsedLayers.includes(layer));
  for (const layer of newlyCollapsed) collapseTurn[layer as 1 | 2] ??= before.turn;
  const ended = after.phase === "finished";

  before.players.forEach((player, index) => {
    const row = rows[index]!;
    const next = after.players[index]!;
    const plan = plans.get(player.id);
    if (plan?.kind === "dig") {
      const tool = player.tools.find((candidate) => candidate.id === plan.toolId);
      if (tool) row.digs[tool.kind] += 1;
      const gem = before.gems[plan.gemId];
      if (gem) row.digsByKind[gem.kind] = (row.digsByKind[gem.kind] ?? 0) + 1;
    }
    if (player.status === "mine" && next.status === "camp" && plan?.kind !== "evacuate") row.trapped += 1;
    if (player.status === "camp" && next.status === "mine") row.trips += 1;
    if (next.status === "retired" && player.status !== "retired") row.retiredTurn = before.turn;
    if (next.status === "mine" && next.cell) row.maxLayer = Math.max(row.maxLayer, layerOf(next.cell));
    // 坐了电梯：结算后的位置不是自己走到的地方，而是从电梯所在层的中心被带走了。
    if (player.status === "mine" && next.status === "mine" && player.cell && next.cell) {
      const planned = plan?.kind === "move" ? plan.path[plan.path.length - 1]! : player.cell;
      if (next.cell !== planned && planned === centerCell(before.elevator.layer)) row.elevatorRides += 1;
    }
  });

  const shatterGain = new Map<string, number>();
  for (const [id, gem] of Object.entries(after.gems)) {
    const previous = before.gems[id];
    if (!previous || gem.location.type !== "gone" || previous.location.type === "gone") continue;
    if (cutIds.has(id)) continue;
    const location = previous.location;
    if (location.type === "bag") {
      const owner = after.players.findIndex((player) => player.id === location.playerId);
      if (ended && after.players[owner]?.status === "mine") rows[owner]!.lostAtEnd += 1;
      else rows[owner]!.lostToCollapse += 1;
      fateOf.set(id, "lostCarried");
      continue;
    }
    if (location.type !== "wall" && location.type !== "ground") continue;
    // 结算顺序：出土（多人出力就碎裂）在塌方之前。所以先看是不是这回合挖出来 / 多人同时捡起的。
    const contributors = Object.keys(gem.contributions);
    const unearthed = location.type === "wall" && gem.progress >= gem.hardness;
    const pickers = [...plans.values()].filter((plan) => plan.kind === "pickup" && plan.gemId === id).length;
    const shattered = (unearthed && contributors.length > 1) || (location.type === "ground" && pickers >= 2);
    if (!shattered) {
      if (unearthed && contributors.length === 1) {
        // 一个人挖出来、同一回合又丢了（被困或对局结束时还在井下）。
        const owner = after.players.findIndex((player) => player.id === contributors[0]);
        if (ended && after.players[owner]?.status === "mine") rows[owner]!.lostAtEnd += 1;
        else rows[owner]!.lostToCollapse += 1;
        fateOf.set(id, "lostCarried");
      } else {
        fateOf.set(id, "buried");
      }
      continue;
    }
    // 多人出力碎裂：和引擎同样的算法分到每位出力者。
    fateOf.set(id, "shattered");
    const total = Object.values(gem.contributions).reduce((sum, amount) => sum + amount, 0);
    const pool = gem.value * PARAMS.shatterShare;
    for (const [playerId, amount] of Object.entries(gem.contributions)) {
      const points = Math.floor((pool * amount) / total);
      const index = after.players.findIndex((player) => player.id === playerId);
      rows[index]!.shatterByKind[gem.kind] = (rows[index]!.shatterByKind[gem.kind] ?? 0) + points;
      shatterGain.set(playerId, (shatterGain.get(playerId) ?? 0) + points);
    }
  }
  after.players.forEach((player, index) => {
    const delta = player.shatterPoints - before.players[index]!.shatterPoints;
    if (delta !== (shatterGain.get(player.id) ?? 0)) checks.shatterMismatches += 1;
  });
}


// ---------- 汇总 ----------

export const mean = (values: readonly number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
export const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
export function histogram(values: readonly number[], width: number): { from: number; count: number }[] {
  if (values.length === 0) return [];
  const min = Math.floor(Math.min(...values) / width) * width;
  const max = Math.max(...values);
  const bins: { from: number; count: number }[] = [];
  for (let from = min; from <= max; from += width) bins.push({ from, count: 0 });
  for (const value of values) bins[Math.floor((value - min) / width)]!.count += 1;
  return bins;
}
export function quantiles(values: readonly number[]): { p10: number; p25: number; p50: number; p75: number; p90: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}

export function summarize(set: readonly GameRow[]) {
  const rows = set.flatMap((game) => game.rows);
  const winners = rows.filter((row) => row.won);
  const others = rows.filter((row) => !row.won);
  const enabledCount = (kind: GemKind) => set.filter((game) => game.enabledKinds.includes(kind)).length;

  const breakdown = (group: readonly PlayerRow[]) => ({
    vault: round(mean(group.map((row) => row.vault))),
    shatter: round(mean(group.map((row) => row.shatter))),
    publicOrders: round(mean(group.map((row) => row.publicOrders))),
    privateOrders: round(mean(group.map((row) => row.privateOrders))),
    pactShare: round(mean(group.map((row) => row.pactShare))),
    pactPenalty: round(mean(group.map((row) => row.pactPenalty))),
    total: round(mean(group.map((row) => row.total))),
  });
  const ORDER: readonly StrategyId[] = [...ALL_STRATEGIES, "partner", "traitor"];

  const gems = GEM_KINDS.map((kind) => {
    const games = enabledCount(kind);
    const sumBy = (group: readonly PlayerRow[], key: "vaultByKind" | "shatterByKind" | "vaultCountByKind" | "digsByKind") => group.reduce((sum, row) => sum + (row[key][kind] ?? 0), 0);
    const fate = Object.fromEntries(FATES.map((name) => [name, set.reduce((sum, game) => sum + (game.fates[kind]?.[name] ?? 0), 0)])) as Record<Fate, number>;
    return {
      kind,
      name: GEM_DEFS[kind].name,
      color: GEM_DEFS[kind].color,
      layers: GEM_DEFS[kind].layers,
      baseValue: GEM_DEFS[kind].value,
      hardness: GEM_DEFS[kind].hardness,
      trait: GEM_DEFS[kind].trait,
      gamesEnabled: games,
      vaultPerGame: round(games ? sumBy(rows, "vaultByKind") / games : 0),
      shatterPerGame: round(games ? sumBy(rows, "shatterByKind") / games : 0),
      winnerVaultPerGame: round(games ? sumBy(winners, "vaultByKind") / games : 0),
      winnerShatterPerGame: round(games ? sumBy(winners, "shatterByKind") / games : 0),
      storedValueAvg: round(sumBy(rows, "vaultCountByKind") ? sumBy(rows, "vaultByKind") / sumBy(rows, "vaultCountByKind") : 0),
      digsPerGame: round(games ? sumBy(rows, "digsByKind") / games : 0),
      pointsPerDig: round(sumBy(rows, "digsByKind") ? (sumBy(rows, "vaultByKind") + sumBy(rows, "shatterByKind")) / sumBy(rows, "digsByKind") : 0),
      fate,
    };
  });

  const strategyStats = ORDER.map((id) => {
    const group = rows.filter((row) => row.strategy === id);
    return {
      id,
      name: STRATEGIES[id].name,
      english: STRATEGIES[id].english,
      summary: STRATEGIES[id].summary,
      seats: group.length,
      winRate: round(group.length ? group.reduce((sum, row) => sum + row.winShare, 0) / group.length : 0, 4),
      avgRank: round(mean(group.map((row) => row.rank))),
      breakdown: breakdown(group),
      scoreQuantiles: quantiles(group.map((row) => row.total)),
      trappedPerGame: round(mean(group.map((row) => row.trapped))),
      lostGems: round(mean(group.map((row) => row.lostToCollapse + row.lostAtEnd))),
      inMineAtEnd: round(mean(group.map((row) => (row.endStatus === "mine" ? 1 : 0))), 3),
      retiredRate: round(mean(group.map((row) => (row.endStatus === "retired" ? 1 : 0))), 3),
      retireTurn: round(mean(group.filter((row) => row.retiredTurn !== null).map((row) => row.retiredTurn!))),
      trips: round(mean(group.map((row) => row.trips))),
      digs: round(mean(group.map((row) => Object.values(row.digs).reduce((sum, value) => sum + value, 0)))),
      privateDoneRate: round(group.reduce((sum, row) => sum + row.privateDone.length, 0) / Math.max(1, group.reduce((sum, row) => sum + row.privateHeld.length, 0)), 3),
      maxLayer: round(mean(group.map((row) => row.maxLayer))),
      elevatorRides: round(mean(group.map((row) => row.elevatorRides))),
      retireReasons: Object.fromEntries([...retireReasons].filter(([key]) => key.startsWith(`${id}:`)).map(([key, count]) => [key.slice(id.length + 1), count])),
    };
  }).filter((entry) => entry.seats > 0);

  const toolStats = TOOL_KINDS.map((kind) => ({
    kind,
    winnerDigs: round(mean(winners.map((row) => row.digs[kind]))),
    otherDigs: round(mean(others.map((row) => row.digs[kind]))),
    winnerBought: round(mean(winners.map((row) => row.bought[kind]))),
    otherBought: round(mean(others.map((row) => row.bought[kind]))),
    winnersUsing: round(mean(winners.map((row) => (row.digs[kind] > 0 ? 1 : 0))), 3),
  }));
  const topTool = (row: PlayerRow) => TOOL_KINDS.reduce((best, kind) => (row.digs[kind] > row.digs[best] ? kind : best), TOOL_KINDS[0]!);
  const winnerTopTool = Object.fromEntries(TOOL_KINDS.map((kind) => [kind, winners.filter((row) => Object.values(row.digs).some((n) => n > 0) && topTool(row) === kind).length]));

  const orderNames = [...new Set(rows.flatMap((row) => row.privateHeld))];
  const privateOrders = orderNames.map((name) => {
    const held = rows.filter((row) => row.privateHeld.includes(name)).length;
    const done = rows.filter((row) => row.privateDone.includes(name)).length;
    return { name, held, done, rate: round(held ? done / held : 0, 3) };
  }).sort((a, b) => b.held - a.held);
  const publicNames = [...new Set(set.flatMap((game) => game.publicClaims.map((claim) => claim.name)))];
  const publicOrders = publicNames.map((name) => {
    const claims = set.flatMap((game) => game.publicClaims.filter((claim) => claim.name === name));
    const claimed = claims.filter((claim) => claim.turn !== null);
    return { name, offered: claims.length, claimed: claimed.length, rate: round(claimed.length / Math.max(1, claims.length), 3), avgTurn: round(mean(claimed.map((claim) => claim.turn!))) };
  });

  const winnerTotalsAll = winners.map((row) => row.total);
  const margins = set.map((game) => {
    const totals = game.rows.map((row) => row.total).sort((a, b) => b - a);
    return totals[0]! - (totals[1] ?? 0);
  });
  const winnerStrategyCounts = Object.fromEntries(ORDER.map((id) => [id, round(set.reduce((sum, game) => sum + game.rows.filter((row) => row.strategy === id).reduce((s, row) => s + row.winShare, 0), 0), 2)]));

  return {
    games: set.length,
    endReasons: {
      collapse: set.filter((game) => game.endReason === "collapse").length,
      retired: set.filter((game) => game.endReason === "retired").length,
      timeout: set.filter((game) => game.endReason === "timeout").length,
    },
    endTurn: { mean: round(mean(set.map((game) => game.endTurn))), quantiles: quantiles(set.map((game) => game.endTurn)) },
    endCollapse: { mean: round(mean(set.map((game) => game.endCollapse))), histogram: histogram(set.map((game) => game.endCollapse), 2) },
    endTurnHistogram: {
      collapse: histogram(set.filter((game) => game.endReason === "collapse").map((game) => game.endTurn), 1),
      retired: histogram(set.filter((game) => game.endReason === "retired").map((game) => game.endTurn), 1),
    },
    collapseTurns: {
      layer2: { mean: round(mean(set.flatMap((game) => (game.collapseTurn[2] !== null ? [game.collapseTurn[2]] : [])))), share: round(set.filter((game) => game.collapseTurn[2] !== null).length / Math.max(1, set.length), 3) },
      layer1: { mean: round(mean(set.flatMap((game) => (game.collapseTurn[1] !== null ? [game.collapseTurn[1]] : [])))), share: round(set.filter((game) => game.collapseTurn[1] !== null).length / Math.max(1, set.length), 3) },
    },
    vibrationPerGame: round(mean(set.map((game) => game.vibrationTotal))),
    trappedPerGame: round(mean(set.map((game) => game.rows.reduce((sum, row) => sum + row.trapped, 0)))),
    caughtAtEndPerGame: round(mean(set.map((game) => game.rows.filter((row) => row.endStatus === "mine").length))),
    winner: {
      totalQuantiles: quantiles(winnerTotalsAll),
      mean: round(mean(winnerTotalsAll)),
      histogram: histogram(winnerTotalsAll, 5),
      nonWinnerHistogram: histogram(others.map((row) => row.total), 5),
      marginQuantiles: quantiles(margins),
      tieRate: round(set.filter((game) => game.rows.filter((row) => row.won).length > 1).length / Math.max(1, set.length), 3),
      breakdown: breakdown(winners),
      everyoneBreakdown: breakdown(rows),
      strategyWins: winnerStrategyCounts,
    },
    gems,
    tools: toolStats,
    winnerTopTool,
    strategies: strategyStats,
    privateOrders,
    publicOrders,
    roles: (["carrier", "partner"] as const).map((role) => {
      const group = rows.filter((row) => row.role === role);
      return {
        role,
        seats: group.length,
        winRate: round(group.length ? group.reduce((sum, row) => sum + row.winShare, 0) / group.length : 0, 4),
        breakdown: breakdown(group),
        goldPerGame: round(mean(set.map((game) => game.rows.filter((row) => row.role === "carrier").reduce((sum, row) => sum + row.pactGems, 0)))),
        betrayedRate: round(mean(group.map((row) => (row.betrayed > 0 ? 1 : 0))), 3),
      };
    }).filter((entry) => entry.seats > 0),
  };
}

