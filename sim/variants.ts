// 规则调整实验的候选方案。apply() 直接改引擎导入的数据对象（每个实验单独一个进程，互不影响）。

import { GEM_DEFS, PARAMS, TOOL_DEFS } from "@jingmai/game";
import type { Variant } from "./runner.js";

type Writable<T> = { -readonly [K in keyof T]: T[K] };
const tool = (kind: keyof typeof TOOL_DEFS) => TOOL_DEFS[kind] as Writable<(typeof TOOL_DEFS)[typeof kind]>;
const gem = (kind: keyof typeof GEM_DEFS) => GEM_DEFS[kind] as Writable<(typeof GEM_DEFS)[typeof kind]>;
const params = PARAMS as unknown as { dynamiteValueFactor: number; shatterShare: number };

/** 炸药划算一点：3 金、价值只降 15%、震动 4。 */
const cheaperDynamite = () => {
  tool("dynamite").price = 3;
  tool("dynamite").vibration = 4;
  params.dynamiteValueFactor = 0.85;
};
/** 钻耐久 5：一把钻正好挖完铁心石（3 次）+ 紫晶王（2 次），紫色订单才做得成。 */
const longerDrill = () => {
  tool("drill").durability = 5;
};
/** 浅脉值钱一点：青砂玉 2 → 3。 */
const richerSurface = () => {
  gem("qingsha").value = 3;
};
/** 赤铁晶 4 → 5（浅脉、回廊都有，浅脉矿工受益最多）。 */
const richerIron = () => {
  gem("chitie").value = 5;
};

export const VARIANTS: Record<string, Variant> = {
  base: { name: "base", description: "现行规则" },
  tremor: { name: "tremor", description: "余震：每回合 35% 概率塌方额外 +1", tremor: 0.35 },
  economy: {
    name: "economy",
    description: "炸药 3 金 / −15% / 震动 4；钻耐久 5；青砂玉值 3",
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); },
  },
  combo: {
    name: "combo",
    description: "余震 35% + 炸药、钻、青砂玉三项调整",
    tremor: 0.35,
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); },
  },
  pact: {
    name: "pact",
    description: "共鸣契约：合挖的共鸣晶不碎裂，存入时 ×1.25 平分；背约独吞扣 5 分",
    pact: { bonus: 0.25, betrayPenalty: 5 },
  },
  pact50: {
    name: "pact50",
    description: "共鸣契约：存入时 ×1.5 平分；背约独吞扣 6 分",
    pact: { bonus: 0.5, betrayPenalty: 6 },
  },
  pact75: {
    name: "pact75",
    description: "共鸣契约：存入时 ×1.75 平分；背约独吞扣 8 分",
    pact: { bonus: 0.75, betrayPenalty: 8 },
  },
  pact100: {
    name: "pact100",
    description: "共鸣契约：存入时 ×2 平分；背约独吞扣 10 分",
    pact: { bonus: 1, betrayPenalty: 10 },
  },
  quake: {
    name: "quake",
    description: "红区大震：塌方 ≥ 28 后每回合 15% 概率塌方跳到 39，下回合末整个矿洞塌毁",
    quake: { from: 28, chance: 0.15 },
  },
  quakeEconomy: {
    name: "quakeEconomy",
    description: "红区大震 + 炸药、钻、青砂玉三项调整",
    quake: { from: 28, chance: 0.15 },
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); },
  },
  pact75s: {
    name: "pact75s",
    description: "共鸣契约：存入时 ×1.75，合伙人分 55%、持宝人 45%；背约独吞扣 8 分",
    pact: { bonus: 0.75, betrayPenalty: 8, partnerShare: 0.55 },
  },
  quake38: {
    name: "quake38",
    description: "红区大震：塌方 ≥ 28 后每回合 15% 概率塌方跳到 38（两回合后整个矿洞塌毁）",
    quake: { from: 28, chance: 0.15, to: 38 },
  },
  quake38Economy: {
    name: "quake38Economy",
    description: "红区大震（跳到 38）+ 炸药、钻、青砂玉三项调整",
    quake: { from: 28, chance: 0.15, to: 38 },
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); },
  },
  proposal: {
    name: "proposal",
    description: "推荐方案：红区大震（跳到 38）+ 炸药、钻、青砂玉三项调整 + 共鸣契约 ×1.75（合伙人 55%），背约扣 8 分",
    quake: { from: 28, chance: 0.15, to: 38 },
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); },
    pact: { bonus: 0.75, betrayPenalty: 8, partnerShare: 0.55 },
  },
  quake20: {
    name: "quake20",
    description: "红区大震：塌方 ≥ 28 后每回合 20% 概率塌方跳到 39",
    quake: { from: 28, chance: 0.2 },
  },
  quakeSurface: {
    name: "quakeSurface",
    description: "红区大震 15% + 炸药、钻、青砂玉调整 + 赤铁晶值 5",
    quake: { from: 28, chance: 0.15 },
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); richerIron(); },
  },
  proposal2: {
    name: "proposal2",
    description: "推荐方案：红区大震 15%（跳到 39）+ 炸药 3 金 / −15% / 震动 4 + 钻耐久 5 + 青砂玉值 3 + 赤铁晶值 5 + 共鸣契约 ×1.75 平分，背约扣 8 分",
    quake: { from: 28, chance: 0.15 },
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); richerIron(); },
    pact: { bonus: 0.75, betrayPenalty: 8 },
  },
  proposal3: {
    name: "proposal3",
    description: "proposal2 + 碎裂分成 60% → 50%",
    quake: { from: 28, chance: 0.15 },
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); richerIron(); params.shatterShare = 0.5; },
    pact: { bonus: 0.75, betrayPenalty: 8 },
  },
  comboPact: {
    name: "comboPact",
    description: "combo + 共鸣契约",
    tremor: 0.35,
    apply: () => { cheaperDynamite(); longerDrill(); richerSurface(); },
    pact: { bonus: 0.25, betrayPenalty: 5 },
  },
};
