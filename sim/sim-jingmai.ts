// 人机「普通」（packages/game/src/bot.ts）的测量：npx tsx sim/sim-jingmai.ts [--games 300]
// 1. 自对弈：2 / 3 / 4 人全是人机各 N 局，每条指令都必须合法，回合数有上限（防死循环），记每次决策的耗时。
// 2. 强度：对随机、对一眼能想到的基线「稳健矿工」（只挖浅脉、装满就回），以及 sim 里的其他策略，2 人局胜率；
//    4 人局（人机 + 3 个随机抽的聪明策略）的胜率和平均名次。

import { RuleViolation, applyCommand, botPlan, createGame, redactGameForViewer, timeoutTurn, type GameState } from "@jingmai/game";
import { SMART_STRATEGIES, makeRng, type StrategyId } from "./bots.js";
import { runGame } from "./runner.js";

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) || fallback : fallback;
};
const GAMES = arg("--games", 300);
const MAX_TURNS = 80;

// ---------- 自对弈 ----------

const times: number[] = [];
let illegal = 0;
let unfinished = 0;
const turnCounts: number[] = [];

function selfPlay(seed: number, count: number): void {
  let state: GameState = createGame(Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, name: `咕噜${index + 1}` })), seed);
  const step = (id: string) => {
    const started = performance.now();
    const { commands } = botPlan(redactGameForViewer(state, id), id);
    times.push(performance.now() - started);
    for (const command of [...commands, { type: "confirm" } as const]) {
      try {
        state = applyCommand(state, id, command);
      } catch (error) {
        if (!(error instanceof RuleViolation)) throw error;
        illegal += 1;
        if (illegal <= 5) console.log(`非法指令 seed=${seed} ${id} ${JSON.stringify(command)}：${error.message}`);
      }
      if (state.phase === "finished") return;
    }
  };
  for (const player of state.players) step(player.id);
  if (state.phase === "setup") state = timeoutTurn(state);
  while (state.phase === "play") {
    if (state.turn > MAX_TURNS) {
      unfinished += 1;
      return;
    }
    const turn = state.turn;
    for (const player of state.players) {
      if (state.phase !== "play" || state.turn !== turn) break;
      const current = state.players.find((candidate) => candidate.id === player.id)!;
      if (current.status === "retired" || current.confirmed) continue;
      step(player.id);
    }
    if (state.phase === "play" && state.turn === turn) {
      illegal += 1;
      state = timeoutTurn(state);
    }
  }
  turnCounts.push(state.turn);
}

const startedAll = Date.now();
let seed = 900_000;
for (const count of [2, 3, 4]) {
  for (let index = 0; index < GAMES; index += 1) selfPlay(seed++, count);
}
times.sort((a, b) => a - b);
const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
console.log(`自对弈 2/3/4 人各 ${GAMES} 局：非法指令 ${illegal}，超过 ${MAX_TURNS} 回合没结束 ${unfinished} 局，平均 ${(turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length).toFixed(1)} 回合`);
console.log(`决策耗时：${times.length} 次，平均 ${mean.toFixed(2)}ms，p99 ${times[Math.floor(times.length * 0.99)]!.toFixed(2)}ms，最坏 ${times.at(-1)!.toFixed(2)}ms`);

// ---------- 强度 ----------

function duel(opponent: StrategyId, games: number): { win: number; avg: number; opp: number } {
  let win = 0;
  let total = 0;
  let oppTotal = 0;
  for (let index = 0; index < games; index += 1) {
    const order: StrategyId[] = index % 2 ? ["normal", opponent] : [opponent, "normal"];
    const game = runGame("duel", seed++, order).game;
    const mine = game.rows.find((row) => row.strategy === "normal" && (opponent !== "normal" || row.seat === (index % 2 ? 0 : 1)))!;
    const theirs = game.rows.find((row) => row !== mine)!;
    win += mine.winShare;
    total += mine.total;
    oppTotal += theirs.total;
  }
  return { win: win / games, avg: total / games, opp: oppTotal / games };
}

const duelGames = Math.max(100, Math.round(GAMES * 2 / 3));
for (const opponent of ["random", "prospector", "diver", "collector", "leech", "gambler", "blaster"] as StrategyId[]) {
  const result = duel(opponent, opponent === "random" || opponent === "prospector" ? GAMES : duelGames);
  console.log(`2 人局 对 ${opponent}：胜率 ${(result.win * 100).toFixed(1)}%，平均 ${result.avg.toFixed(1)} 分 vs ${result.opp.toFixed(1)} 分`);
}

const mixRng = makeRng(424242);
for (const count of [3, 4]) {
  let win = 0;
  let rank = 0;
  for (let index = 0; index < GAMES; index += 1) {
    const seat = index % count;
    const order: StrategyId[] = Array.from({ length: count }, (_, position) => (position === seat ? "normal" : mixRng.pick(SMART_STRATEGIES)));
    const game = runGame("table", seed++, order).game;
    const row = game.rows[seat]!;
    win += row.winShare;
    rank += row.rank;
  }
  console.log(`${count} 人局（人机 + ${count - 1} 个随机抽的 sim 策略）${GAMES} 局：胜率 ${(win / GAMES * 100).toFixed(1)}%（公平值 ${(100 / count).toFixed(0)}%），平均名次 ${(rank / GAMES).toFixed(2)}`);
}
console.log(`用时 ${((Date.now() - startedAll) / 1000).toFixed(0)}s`);
