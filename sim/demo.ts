// 在终端里看一局机器人对局：npx tsx sim/demo.ts [种子] [策略…]
// 例：npx tsx sim/demo.ts 22 collector prospector blaster gambler
// 每回合打印每位玩家在哪、背包、本回合的计划，以及引擎的结算消息。

import { GEM_DEFS, LAYER_DEFS, TOOL_DEFS, applyCommand, createGame, redactGameForViewer, scoreBreakdown, timeoutTurn, type GameCommand, type Plan } from "@jingmai/game";
import { SMART_STRATEGIES, STRATEGIES, makeRng, type StrategyId } from "./bots.js";
import { layerOf } from "./pathing.js";

const args = process.argv.slice(2);
const seed = Number(args[0] ?? 22) || 22;
const strategies = (args.length > 1 ? args.slice(1) : ["collector", "prospector", "blaster", "gambler"]) as StrategyId[];
for (const id of strategies) {
  if (!STRATEGIES[id]) throw new Error(`没有这个策略：${id}（可选：${[...SMART_STRATEGIES, "random"].join(", ")}）`);
}

const players = strategies.map((id, index) => ({ id: `p${index + 1}`, name: `${STRATEGIES[id].name}${index + 1}` }));
let state = createGame(players, seed);
const bots = strategies.map((id, index) => STRATEGIES[id].create(makeRng(seed * 7919 + index * 104729 + 1)));
const apply = (id: string, command: GameCommand) => {
  try {
    state = applyCommand(state, id, command);
    return true;
  } catch {
    return false;
  }
};
const describe = (plan: Plan | undefined) => {
  if (!plan) return "待命";
  switch (plan.kind) {
    case "move": return `移动 ${plan.path.length} 步`;
    case "dig": return `挖${GEM_DEFS[state.gems[plan.gemId]!.kind].name}`;
    case "pickup": return "捡起";
    case "descend": return `从井${plan.well + 1}下井`;
    default: return { evacuate: "撤离", wait: "待命", stay: "留守", retire: "收工", cut: "切割", handoff: "交接" }[plan.kind];
  }
};

console.log(`种子 ${seed}：${players.map((player) => player.name).join("、")}`);
state.players.forEach((player, index) => {
  const view = redactGameForViewer(state, player.id);
  for (const command of bots[index]!.setup(view, view.players[index]!)) apply(player.id, command);
});
if (state.phase === "setup") state = timeoutTurn(state);
for (const player of state.players) {
  console.log(`  ${player.name} 订单 ${player.privateOrders.map((order) => order.name).join("、")}；工具 ${player.tools.map((tool) => TOOL_DEFS[tool.kind].name).join("、")}`);
}

while (state.phase === "play" && state.turn <= 80) {
  const turn = state.turn;
  const plans: string[] = [];
  state.players.forEach((player, index) => {
    if (player.status === "retired") return;
    const view = redactGameForViewer(state, player.id);
    let plan: Plan | undefined;
    for (const command of bots[index]!.turn(view, view.players[index]!)) {
      if (command.type === "confirm") continue;
      if (apply(player.id, command) && command.type === "plan") plan = command.plan;
    }
    const where = player.status === "mine" && player.cell ? LAYER_DEFS[layerOf(player.cell)].name : "营地";
    plans.push(`${player.name}@${where}[包${player.bag.length}] ${describe(plan)}`);
  });
  state.players.forEach((player, index) => {
    if (player.status !== "retired" && !state.players[index]!.confirmed) apply(player.id, { type: "confirm" });
  });
  if (state.phase === "play" && state.turn === turn) state = timeoutTurn(state);
  console.log(`\n第 ${turn} 回合 · 塌方 ${state.collapse}/40\n  ${plans.join("  |  ")}`);
  for (const event of state.log.at(-1)?.events ?? []) console.log(`  · ${event}`);
}

console.log("\n结算：");
for (const player of [...state.players].sort((a, b) => scoreBreakdown(state, b).total - scoreBreakdown(state, a).total)) {
  const score = scoreBreakdown(state, player);
  console.log(`  ${state.winnerIds.includes(player.id) ? "🏆" : "  "} ${player.name} ${score.total} 分（存入 ${score.vault}，碎裂 ${score.shatter}，公共 ${score.publicOrders}，私人 ${score.privateOrders ?? 0}）`);
}
