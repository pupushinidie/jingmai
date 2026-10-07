// 把模拟结果嵌进报告模板：node sim/build-report.mjs
// 输出 sim/out/report.html（完整网页，可直接用浏览器打开）和 sim/out/report-fragment.html（发布用的页面片段）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const template = readFileSync(here("./report-template.html"), "utf8");
const summary = JSON.parse(readFileSync(here("./out/summary.json"), "utf8"));
// 规则调整实验（npx tsx sim/balance.ts …）的结果：有就一起放进报告，只取报告要用的字段。
const BALANCE = [
  "base-solo", "tremor-solo", "economy-solo", "quake-solo", "quakeSurface-solo", "proposal2-solo", "proposal3-solo",
  "pact-pair", "pact-traitor", "pact50-pair", "pact50-traitor", "pact75-pair", "pact75-traitor", "pact100-pair", "pact100-traitor",
  "proposal2-pair", "proposal2-traitor",
];
const balance = {};
for (const name of BALANCE) {
  const path = here(`./out/balance/${name}.json`);
  if (!existsSync(path)) continue;
  const run = JSON.parse(readFileSync(path, "utf8"));
  balance[name] = {
    variant: run.variant,
    description: run.description,
    table: run.table,
    games: run.games,
    endTurn: run.endTurn.mean,
    collapseShare: run.endReasons.collapse / run.games,
    caughtPerGame: run.caughtAtEndPerGame,
    winnerMedian: run.winner.totalQuantiles.p50,
    strategies: run.strategies.map((entry) => ({ id: entry.id, seats: entry.seats, winRate: entry.winRate, avg: entry.breakdown.total, caught: entry.inMineAtEnd })),
    roles: run.roles.map((entry) => ({ role: entry.role, seats: entry.seats, winRate: entry.winRate, avg: entry.breakdown.total, gold: entry.goldPerGame })),
  };
}
summary.balance = balance;
// JSON 放在 <script> 里：把 "</" 转义，防止提前结束标签。
const fragment = template.replace("__DATA__", () => JSON.stringify(summary).replaceAll("</", "<\\/"));
writeFileSync(here("./out/report-fragment.html"), fragment);

const split = fragment.indexOf('<div id="tip"');
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${fragment.slice(0, split)}</head>
<body>
${fragment.slice(split)}
</body>
</html>
`;
writeFileSync(here("./out/report.html"), page);
console.log(`报告已生成：${here("./out/report.html")}`);
