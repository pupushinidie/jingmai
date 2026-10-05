import type { GemColor, GemKind, LayerIndex, OrderDefinition, ToolKind } from "./data.js";
import type { CellKey } from "./hex.js";

export interface Tool {
  readonly id: string;
  readonly kind: ToolKind;
  /** null 表示不损耗。 */
  readonly durability: number | null;
}

export type GemLocation =
  | { readonly type: "wall"; readonly cell: CellKey }
  | { readonly type: "ground"; readonly cell: CellKey }
  | { readonly type: "bag"; readonly playerId: string }
  | { readonly type: "vault"; readonly playerId: string }
  | { readonly type: "gone" };

export interface Gem {
  readonly id: string;
  readonly kind: GemKind;
  readonly color: GemColor;
  /** 出自哪一层；切割出的碎块沿用原石的层。 */
  readonly layer: LayerIndex;
  readonly value: number;
  readonly hardness: number;
  /** 占 2 格。切割后的碎块为 false。 */
  readonly heavy: boolean;
  /** 切割得到的碎块。 */
  readonly cut: boolean;
  readonly location: GemLocation;
  readonly progress: number;
  /** 每位玩家贡献的挖掘进度；地上的宝石被多人同时拾取时每人记 1。 */
  readonly contributions: Readonly<Record<string, number>>;
  /** 遮光袋让衰减隔回合生效：记录是否已经跳过了一次。 */
  readonly decaySkipped: boolean;
  /** 存入营地的回合，用于判定公共订单的先后。 */
  readonly depositedTurn?: number;
}

export type LinkKind = "ladder" | "hole";

/** 跨层通路：连接 upper 层与 upper+1 层同一 (q, r) 的格子。 */
export interface Link {
  readonly kind: LinkKind;
  readonly upper: 0 | 1;
  readonly q: number;
  readonly r: number;
}

export interface OrderCard extends OrderDefinition {
  /** 发给别人的视图里，私人订单只保留张数。 */
  readonly hidden?: boolean;
}

export interface PublicOrderState extends OrderDefinition {
  /** 拿到奖励的玩家；同回合同时满足就平分。 */
  readonly claimedBy: string[];
  readonly claimedTurn?: number;
}

/** 矿洞里的行动：每回合二选一，移动或一个动作。 */
export type MinePlan =
  | { readonly kind: "move"; readonly path: CellKey[] }
  | { readonly kind: "dig"; readonly gemId: string; readonly toolId: string }
  | { readonly kind: "pickup"; readonly gemId: string }
  | { readonly kind: "handoff"; readonly to: string; readonly itemId: string }
  | { readonly kind: "cut"; readonly gemId: string; readonly toolId: string }
  | { readonly kind: "evacuate" }
  | { readonly kind: "wait" };

/** 营地回合结束时的去向。 */
export type CampPlan =
  | { readonly kind: "descend"; readonly well: number }
  | { readonly kind: "stay" }
  | { readonly kind: "retire" };

export type Plan = MinePlan | CampPlan;

export type PlayerStatus = "mine" | "camp" | "retired";

export interface PlayerState {
  readonly id: string;
  readonly name: string;
  /** 座位序号，决定颜色。 */
  readonly seat: number;
  readonly status: PlayerStatus;
  /** 在矿洞里时所在的格子。 */
  readonly cell?: CellKey;
  readonly gold: number;
  readonly tools: Tool[];
  /** 背包里宝石的 id。 */
  readonly bag: string[];
  /** 开局分到的井口。 */
  readonly startWell: number;
  /** 开局抽到、尚未挑选的私人订单（只在准备阶段存在）。 */
  readonly orderChoices: OrderCard[];
  readonly privateOrders: OrderCard[];
  /** 碎裂保底分。 */
  readonly shatterPoints: number;
  readonly publicOrderPoints: number;
  readonly plan?: Plan;
  readonly confirmed: boolean;
  /** 本回合愿意接收谁的交接。 */
  readonly acceptFrom?: string;
}

export interface ElevatorState {
  readonly layer: LayerIndex;
  readonly direction: 1 | -1;
}

export interface TurnLog {
  readonly turn: number;
  readonly events: string[];
}

export interface GameState {
  /** 地图种子，同一种子生成同一张图。 */
  readonly seed: number;
  /** 局内随机数的状态（跳洞口时随机损坏的工具）。 */
  readonly rngState: number;
  readonly phase: "setup" | "play" | "finished";
  readonly turn: number;
  readonly players: PlayerState[];
  readonly gems: Record<string, Gem>;
  readonly links: Link[];
  /** 本局启用的特殊宝石。 */
  readonly enabledKinds: GemKind[];
  readonly collapsedLayers: LayerIndex[];
  readonly elevator: ElevatorState;
  readonly collapse: number;
  /** 还没凑满一点塌方进度的震动。 */
  readonly vibration: number;
  readonly publicOrders: PublicOrderState[];
  readonly log: TurnLog[];
  readonly winnerIds: string[];
  readonly nextId: number;
}

export interface PlayerDefinition {
  readonly id: string;
  readonly name: string;
}

/** 规划阶段的指令：营地操作即时生效，矿洞行动在结算时生效。 */
export type GameCommand =
  | { readonly type: "plan"; readonly plan: Plan }
  | { readonly type: "confirm" }
  | { readonly type: "unconfirm" }
  | { readonly type: "accept"; readonly from: string | null }
  | { readonly type: "keepOrders"; readonly discardId: string }
  | { readonly type: "buy"; readonly tool: ToolKind }
  | { readonly type: "discardTool"; readonly toolId: string }
  | { readonly type: "deposit"; readonly gemId: string }
  | { readonly type: "sell"; readonly gemId: string };

export class RuleViolation extends Error {}
