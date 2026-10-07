// 规则调整实验：npx tsx sim/balance.ts <方案> [--games 1000] [--table solo|pair|traitor]
//   solo    4 人桌，每个座位从 6 种策略里随机抽（看各策略胜率是否接近 25%）
//   pair    前两个座位是一队合伙人（持宝人履约），后两个随机策略
//   traitor 同上，但持宝人是背约者
// 结果写到 sim/out/balance/<方案>-<桌型>.json。

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SMART_STRATEGIES, makeRng, type StrategyId } from "./bots.js";
import { checks, round, runGame, summarize, type GameRow } from "./runner.js";
import { VARIANTS } from "./variants.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const variant = VARIANTS[args[0] ?? "base"];
if (!variant) throw new Error(`没有这个方案：${args[0]}（可选：${Object.keys(VARIANTS).join(", ")}）`);
const table = option("table", "solo") as "solo" | "pair" | "traitor";
const total = Number(option("games", "1000"));
variant.apply?.();

const rng = makeRng(777);
const games: GameRow[] = [];
const started = Date.now();
for (let index = 0; index < total; index += 1) {
  const seed = 100000 + index;
  const others = () => rng.pick(SMART_STRATEGIES);
  const seats: StrategyId[] = table === "solo"
    ? [others(), others(), others(), others()]
    : [table === "traitor" ? "traitor" : "partner", "partner", others(), others()];
  games.push(runGame(`${variant.name}-${table}`, seed, seats, { variant }).game);
  if (index % 100 === 0) process.stdout.write(`\r${variant.name}-${table} ${index}/${total}`);
}
const summary = {
  variant: variant.name,
  description: variant.description,
  table,
  seconds: round((Date.now() - started) / 1000, 1),
  checks: { shatterMismatches: checks.shatterMismatches, engineErrors: checks.engineErrors, engineErrorSamples: checks.engineErrorSamples },
  ...summarize(games),
};
const outDir = fileURLToPath(new URL("./out/balance/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}${variant.name}-${table}.json`, JSON.stringify(summary, null, 1));
const winRates = summary.strategies.map((entry) => `${entry.id} ${(entry.winRate * 100).toFixed(1)}%`).join("  ");
console.log(`\r${variant.name}-${table}: ${total} 局 ${summary.seconds}s · ${winRates} · 回合 ${summary.endTurn.mean} · 碎裂核对 ${checks.shatterMismatches} · 异常 ${checks.engineErrors}`);
