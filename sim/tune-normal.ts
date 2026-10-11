// 人机「普通」调参：每套参数对深潜者 / 订单猎人 / 搭便车 / 冒险家各打 120 局 2 人局，看平均胜率。npx tsx sim/tune-normal.ts
import { normalTune, type StrategyId } from "./bots.js";
import { runGame } from "./runner.js";
const variants: Record<string, object> = {
  base: {},
  ow2: { orderWeight: 2 },
  ow06: { orderWeight: 0.6 },
  lw: { layerWeight: [0.45, 1, 1.35] },
  lwDeep: { layerWeight: [0.4, 1, 1.6] },
  m2: { margin: 2 },
  r4: { retireBelow: 4 },
  r8: { retireBelow: 8 },
  home1: { homeAt: 1 },
};
const opps: StrategyId[] = ["diver", "collector", "leech", "gambler"];
for (const [name, v] of Object.entries(variants)) {
  for (const k of Object.keys(normalTune)) delete (normalTune as Record<string, unknown>)[k];
  Object.assign(normalTune, v);
  let seed = 77000; const out: string[] = []; let all = 0;
  for (const o of opps) {
    let w = 0; const n = 120;
    for (let i = 0; i < n; i++) { const g = runGame("t", seed++, i % 2 ? ["normal", o] : [o, "normal"]).game; w += g.rows.find(r => r.strategy === "normal")!.winShare; }
    out.push(`${o} ${(w / n * 100).toFixed(0)}`); all += w / n;
  }
  console.log(name.padEnd(8), (all / opps.length * 100).toFixed(1), out.join(" "));
}
