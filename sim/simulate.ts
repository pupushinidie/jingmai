// 机器人对局模拟：npm run sim [-- --scale 1]
// 直接调用规则引擎（不走网络），每局记录结束方式、得分构成、每种宝石的去向和贡献、工具使用等，
// 汇总写到 sim/out/summary.json（给可视化报告用），逐局明细写到 sim/out/games.jsonl。

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAYER_DEFS, PARAMS } from "@jingmai/game";
import { ALL_STRATEGIES, SMART_STRATEGIES, STRATEGIES, makeRng, type StrategyId } from "./bots.js";
import { checks, round, runGame, summarize, type GameRow } from "./runner.js";

// ---------- 实验 ----------

function pickStrategies(rng: ReturnType<typeof makeRng>, pool: readonly StrategyId[], count: number): StrategyId[] {
  return Array.from({ length: count }, () => rng.pick(pool));
}

const scale = Number(process.argv[process.argv.indexOf("--scale") + 1] ?? 1) || 1;
const games: GameRow[] = [];
const started = Date.now();
const progress = (label: string) => process.stdout.write(`\r${label} ${games.length} 局，${((Date.now() - started) / 1000).toFixed(1)}s   `);

const mixRng = makeRng(20261005);
let seed = 1;
// 主实验：4 人桌，每个座位从 5 种策略里随机抽（可以重复）。胜率、赢家分布都看这一组。
for (const [count, total] of [[4, 2000], [3, 600], [2, 600]] as const) {
  const games_ = Math.round(total * scale);
  for (let index = 0; index < games_; index += 1) {
    games.push(runGame(`smart${count}`, seed++, pickStrategies(mixRng, SMART_STRATEGIES, count)).game);
    if (index % 50 === 0) progress(`${count} 人局`);
  }
}
// 基准线：桌上混进随机机器人。
for (let index = 0; index < Math.round(400 * scale); index += 1) {
  games.push(runGame("withRandom4", seed++, pickStrategies(mixRng, ALL_STRATEGIES, 4)).game);
}
progress("含随机");
for (const strategy of SMART_STRATEGIES) {
  const total = Math.round(200 * scale);
  for (let index = 0; index < total; index += 1) {
    games.push(runGame(`mirror-${strategy}`, seed++, [strategy, strategy, strategy, strategy]).game);
  }
  progress(`镜像 ${strategy}`);
}
process.stdout.write("\n");

// 示范局：4 种不同的聪明策略同桌，取赢家分数最接近中位数的一局重放并逐回合记录。
const demoCandidates = games.filter((game) => game.experiment === "smart4" && new Set(game.rows.map((row) => row.strategy)).size === 4);
const winnerTotals = demoCandidates.map((game) => Math.max(...game.rows.map((row) => row.total))).sort((a, b) => a - b);
const medianWinner = winnerTotals[Math.floor(winnerTotals.length / 2)] ?? 0;
const demoGame = demoCandidates.sort((a, b) => Math.abs(Math.max(...a.rows.map((r) => r.total)) - medianWinner) - Math.abs(Math.max(...b.rows.map((r) => r.total)) - medianWinner))[0];
const demo = demoGame ? runGame("demo", demoGame.seed, demoGame.rows.map((row) => row.strategy), { record: true }) : undefined;


const experiments = [...new Set(games.map((game) => game.experiment))];
const summary = {
  generatedAt: new Date().toISOString(),
  gamesTotal: games.length,
  seconds: round((Date.now() - started) / 1000, 1),
  checks: { shatterMismatches: checks.shatterMismatches, engineErrors: checks.engineErrors, engineErrorSamples: checks.engineErrorSamples, invalidCommands: games.reduce((sum, game) => sum + game.rows.reduce((s, row) => s + row.invalid, 0), 0) },
  rules: {
    collapseAt: [LAYER_DEFS[0].collapseAt, LAYER_DEFS[1].collapseAt, LAYER_DEFS[2].collapseAt],
    shatterShare: PARAMS.shatterShare,
  },
  strategies: ALL_STRATEGIES.map((id) => ({ id, name: STRATEGIES[id].name, english: STRATEGIES[id].english, summary: STRATEGIES[id].summary })),
  experiments: Object.fromEntries(experiments.map((name) => [name, summarize(games.filter((game) => game.experiment === name))])),
  smartAll: summarize(games.filter((game) => game.experiment.startsWith("smart"))),
  demo: demo && demoGame ? {
    seed: demoGame.seed,
    players: demoGame.rows.map((row, index) => ({ strategy: row.strategy, name: `${STRATEGIES[row.strategy].name}${index + 1}` })),
    final: demo.game.rows.map((row) => ({ strategy: row.strategy, total: row.total, vault: row.vault, shatter: row.shatter, publicOrders: row.publicOrders, privateOrders: row.privateOrders, won: row.won })),
    endReason: demo.game.endReason,
    turns: demo.demo,
  } : null,
};

// 用 fileURLToPath：URL.pathname 会把中文目录名转义成 %E6…。
const outDir = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}summary.json`, JSON.stringify(summary, null, 1));
writeFileSync(`${outDir}games.jsonl`, games.map((game) => JSON.stringify(game)).join("\n"));
console.log(`完成 ${games.length} 局，用时 ${summary.seconds}s；碎裂分核对不一致 ${checks.shatterMismatches} 次，引擎异常 ${checks.engineErrors} 次，被拒指令 ${summary.checks.invalidCommands} 条。`);
if (checks.engineErrorSamples.length) console.log("引擎异常示例：", checks.engineErrorSamples);
if (checks.invalidReasons.size) console.log("被拒指令：", [...checks.invalidReasons].sort((a, b) => b[1] - a[1]).slice(0, 12));

