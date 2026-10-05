// 规则书 v0.1 里的全部数值。调参只改这里。

export type LayerIndex = 0 | 1 | 2;
export const LAYERS: readonly LayerIndex[] = [0, 1, 2];

export interface LayerDefinition {
  readonly name: string;
  readonly radius: number;
  readonly gemCount: number;
  /** 塌方进度到这个值时该层塌方。第一层塌方即游戏结束。 */
  readonly collapseAt: number;
}

export const LAYER_DEFS: Record<LayerIndex, LayerDefinition> = {
  0: { name: "浅脉", radius: 8, gemCount: 18, collapseAt: 40 },
  1: { name: "回廊", radius: 5, gemCount: 12, collapseAt: 32 },
  2: { name: "晶心", radius: 3, gemCount: 6, collapseAt: 24 },
};

export const PARAMS = {
  bagSlots: 6,
  /** 移动力 = 空余格数 + moveBonus，限定在 [minMove, maxMove]。 */
  moveBonus: 2,
  minMove: 2,
  maxMove: 8,
  startingGold: 12,
  ladderUpCost: 3,
  ladderUpCostWithRope: 1,
  /** 多人出力又没签约时，宝石碎裂后按贡献分到的比例。 */
  shatterShare: 0.6,
  /** 切割后每颗的价值占原价的比例。 */
  cutShare: 0.35,
  /** 每累计这么多震动，塌方进度 +1。 */
  vibrationPerCollapse: 4,
  /** 离塌方还差几点时开始预警。 */
  collapseWarning: 3,
  dynamiteValueFactor: 0.7,
  specialGemsEnabled: 4,
  publicOrders: 3,
  privateOrdersDrawn: 3,
  privateOrdersKept: 2,
} as const;

export type GemColor = "cyan" | "red" | "green" | "purple" | "gold";

export const COLOR_NAMES: Record<GemColor, string> = {
  cyan: "青",
  red: "赤",
  green: "翠",
  purple: "紫",
  gold: "金",
};

export type ToolKind = "pick" | "chisel" | "drill" | "fork" | "rope" | "shade" | "seal" | "dynamite";

export interface ToolDefinition {
  readonly name: string;
  readonly price: number;
  /** null 表示不损耗。 */
  readonly durability: number | null;
  /** 挖掘时加的进度；不能用来挖掘的工具为 0。 */
  readonly progress: number;
  /** 挖一次带来的震动。 */
  readonly vibration: number;
  readonly description: string;
}

export const TOOL_DEFS: Record<ToolKind, ToolDefinition> = {
  pick: { name: "镐", price: 2, durability: 6, progress: 1, vibration: 1, description: "挖掘进度 +1" },
  chisel: { name: "凿", price: 3, durability: 5, progress: 1, vibration: 1, description: "挖掘进度 +1；部分宝石只能用凿；可切割重型宝石" },
  drill: { name: "钻", price: 5, durability: 4, progress: 2, vibration: 2, description: "挖掘进度 +2；坚硬和重型宝石只能用钻；震动更大" },
  fork: { name: "共鸣叉", price: 3, durability: 3, progress: 1, vibration: 1, description: "挖共鸣晶必需；同回合至少 2 人一起挖才有进度" },
  rope: { name: "绳索", price: 2, durability: null, progress: 0, vibration: 0, description: "上梯只算 1 格；跳洞口不损耗工具；满载也能爬梯" },
  shade: { name: "遮光袋", price: 2, durability: null, progress: 0, vibration: 0, description: "背包里的衰减宝石改为每 2 回合 −1" },
  seal: { name: "封印盒", price: 3, durability: null, progress: 0, vibration: 0, description: "背包里一颗诅咒宝石的效果失效" },
  dynamite: { name: "炸药", price: 4, durability: 1, progress: 4, vibration: 6, description: "任何宝石都能炸（共鸣晶除外）：进度 +4，价值 −30%，震动 +6" },
};

export const TOOL_KINDS = Object.keys(TOOL_DEFS) as ToolKind[];

export type GemKind = "qingsha" | "chitie" | "yingguang" | "cuiya" | "tiexin" | "zijingwang" | "xuepo" | "gongming";
export type GemTrait = "none" | "decay" | "growth" | "hard" | "heavy" | "curse" | "resonance";

export interface GemDefinition {
  readonly name: string;
  readonly color: GemColor;
  readonly layers: readonly LayerIndex[];
  readonly value: number;
  readonly hardness: number;
  readonly tools: readonly ToolKind[];
  readonly trait: GemTrait;
  /** 每局必出的基础宝石；其余为特殊宝石，每局随机启用一部分。 */
  readonly basic: boolean;
}

export const GEM_DEFS: Record<GemKind, GemDefinition> = {
  qingsha: { name: "青砂玉", color: "cyan", layers: [0], value: 2, hardness: 1, tools: ["pick", "chisel", "drill"], trait: "none", basic: true },
  chitie: { name: "赤铁晶", color: "red", layers: [0, 1], value: 4, hardness: 3, tools: ["pick", "chisel", "drill"], trait: "none", basic: true },
  yingguang: { name: "萤光石", color: "cyan", layers: [1], value: 10, hardness: 2, tools: ["chisel"], trait: "decay", basic: false },
  cuiya: { name: "翠芽晶", color: "green", layers: [1], value: 5, hardness: 3, tools: ["chisel"], trait: "growth", basic: false },
  tiexin: { name: "铁心石", color: "purple", layers: [1, 2], value: 11, hardness: 6, tools: ["drill"], trait: "hard", basic: false },
  zijingwang: { name: "紫晶王", color: "purple", layers: [2], value: 18, hardness: 4, tools: ["drill"], trait: "heavy", basic: false },
  xuepo: { name: "血珀", color: "red", layers: [2], value: 15, hardness: 3, tools: ["chisel"], trait: "curse", basic: false },
  gongming: { name: "共鸣晶", color: "gold", layers: [2], value: 24, hardness: 4, tools: ["fork"], trait: "resonance", basic: false },
};

export const GEM_KINDS = Object.keys(GEM_DEFS) as GemKind[];

export const TRAIT_NAMES: Record<GemTrait, string> = {
  none: "",
  decay: "衰减",
  growth: "生长",
  hard: "坚硬",
  heavy: "重型",
  curse: "诅咒",
  resonance: "共鸣",
};

/** 翠芽晶留在岩壁里时每回合 +1，最高到这个值。 */
export const GROWTH_CAP = 12;

/**
 * 每层宝石的抽取权重（只在本局启用的种类里抽）。
 * 第一层固定按扇区分配：每个扇区 2 颗青砂玉 + 1 颗赤铁晶，保证六个井口起点公平。
 */
export const LAYER_GEM_WEIGHTS: Record<1 | 2, Partial<Record<GemKind, number>>> = {
  1: { chitie: 1, yingguang: 2, cuiya: 2, tiexin: 2 },
  2: { tiexin: 1, zijingwang: 1, xuepo: 1, gongming: 1 },
};
export const LAYER0_SECTOR_GEMS: readonly GemKind[] = ["qingsha", "qingsha", "chitie"];

// ---------- 订单 ----------

export type OrderRequirement =
  | { readonly kind: "colors"; readonly colors: Partial<Record<GemColor, number>> }
  | { readonly kind: "layer"; readonly layer: LayerIndex; readonly count: number }
  | { readonly kind: "distinctColors"; readonly count: number }
  | { readonly kind: "gemCount"; readonly count: number }
  | { readonly kind: "totalValue"; readonly value: number };

export interface OrderDefinition {
  readonly id: string;
  readonly name: string;
  readonly requirement: OrderRequirement;
  readonly reward: number;
}

export const PRIVATE_ORDERS: readonly OrderDefinition[] = [
  { id: "furnace", name: "炉火", requirement: { kind: "colors", colors: { red: 2, gold: 1 } }, reward: 14 },
  { id: "tricolor", name: "三色", requirement: { kind: "colors", colors: { red: 1, cyan: 1, green: 1 } }, reward: 9 },
  { id: "abyss", name: "深渊收藏", requirement: { kind: "layer", layer: 2, count: 3 }, reward: 16 },
  { id: "violet", name: "紫气东来", requirement: { kind: "colors", colors: { purple: 2 } }, reward: 10 },
  { id: "cyan-path", name: "青石小径", requirement: { kind: "colors", colors: { cyan: 4 } }, reward: 6 },
  { id: "red-flame", name: "赤焰", requirement: { kind: "colors", colors: { red: 3 } }, reward: 9 },
  { id: "green-garden", name: "翠色满园", requirement: { kind: "colors", colors: { green: 2 } }, reward: 10 },
  { id: "jade-gold", name: "金玉良缘", requirement: { kind: "colors", colors: { gold: 1, cyan: 1 } }, reward: 11 },
  { id: "corridor", name: "回廊珍藏", requirement: { kind: "layer", layer: 1, count: 3 }, reward: 9 },
  { id: "rainbow", name: "五光十色", requirement: { kind: "distinctColors", count: 4 }, reward: 13 },
  { id: "purple-gold", name: "紫金", requirement: { kind: "colors", colors: { purple: 1, gold: 1 } }, reward: 13 },
  { id: "red-purple", name: "朱紫", requirement: { kind: "colors", colors: { red: 1, purple: 1 } }, reward: 8 },
];

/** 公共订单：第一个存入满足条件的宝石的人拿奖励。 */
export const PUBLIC_ORDERS: readonly OrderDefinition[] = [
  { id: "first-five", name: "先行者", requirement: { kind: "gemCount", count: 5 }, reward: 6 },
  { id: "first-gold", name: "点石成金", requirement: { kind: "colors", colors: { gold: 1 } }, reward: 8 },
  { id: "first-thirty", name: "大宗交易", requirement: { kind: "totalValue", value: 30 }, reward: 8 },
  { id: "first-deep", name: "深入晶心", requirement: { kind: "layer", layer: 2, count: 1 }, reward: 6 },
  { id: "first-two-purple", name: "双紫", requirement: { kind: "colors", colors: { purple: 2 } }, reward: 7 },
  { id: "first-three-colors", name: "三色齐聚", requirement: { kind: "distinctColors", count: 3 }, reward: 6 },
];
