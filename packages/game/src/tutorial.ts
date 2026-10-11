// 新手教程的剧本（站内统一做法：剧本局 + 练习提示 + 小贴士，向导咕噜嘎）。
//
// 教程不连服务器：网页里直接跑规则引擎。地图用固定种子（同一种子同一张图），对手咕噜一号交给人机 botPlan
// （人机没有随机，局面一样决定就一样），所以剧本里每一步的局面都是确定的；剧本单测从头走到尾验证这一点。
// 晶脉是同时行动：对手总是在回合一开始就规划好并确认（看不到它选了什么），玩家一确认就结算。

import { botPlan } from "./bot.js";
import { applyCommand, createGame, redactGameForViewer } from "./engine.js";
import { parseCell, type CellKey } from "./hex.js";
import type { GameCommand, GameState, PlayerState } from "./types.js";

export const TUTORIAL_SEED = 1;
export const TUTORIAL_SELF = "you";
export const TUTORIAL_RIVAL = "gulu1";
export const TUTORIAL_RIVAL_NAME = "咕噜一号";

export type TutorialFace = "base" | "happy" | "surprised" | "think";

export interface TutorialStep {
  readonly id: string;
  /** info：讲解，点「下一步」；do：等玩家做 expect 这一步。晶脉同时行动，对手不需要 watch 步骤。 */
  readonly kind: "info" | "do" | "watch";
  /** 教程进度里的课名（同一课的几步写同一个名字，进度里只算一次）。 */
  readonly lesson?: string;
  readonly say: string;
  readonly note?: string;
  /** 触屏上换的说法。 */
  readonly noteTouch?: string;
  /**
   * 高亮哪个元素（data-tutorial）。"cell:<格子>" 是地图上的一格：格子菜单打开以后网页会改成高亮菜单。
   */
  readonly anchor: string | null;
  readonly face?: TutorialFace;
  readonly expect?: GameCommand;
  readonly moves?: readonly GameCommand[];
  /** 最后一步：接练习局。 */
  readonly finale?: boolean;
}

// 种子 1 的地图：你从 1 号井口（0:8:-4）出发，旁边 0:8:-1 有一颗赤铁晶（硬度 3），站到 0:7:-1 就能挖。
const START: CellKey = "0:8:-4";
const ACCESS: CellKey = "0:7:-1";
const GEM_CELL: CellKey = "0:8:-1";
const GEM = "g3";
// 对手（人机）开局先买了 3 件工具（t1–t3），你买的钻是 t4。
const DRILL = "t4";
const confirm: GameCommand = { type: "confirm" };

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  { id: "goal", kind: "info", lesson: "目标", anchor: null, face: "happy", say: "欢迎下井！挖宝石、带回营地，开采季结束时分数最高的赢。", note: "我是咕噜嘎，带你走一小段，大约 3 分钟。对手是人机咕噜一号。" },
  { id: "simultaneous", kind: "info", lesson: "同时行动", anchor: "turn", say: "晶脉是同时行动：每回合大家各自规划，全部确认后一起结算。", note: "你看不到别人这回合打算干什么，别人也看不到你的。这里是回合数和倒计时。" },
  { id: "orders", kind: "do", lesson: "订单", anchor: "panel:orders", expect: { type: "keepOrders", discardId: "" }, say: "先挑订单：三张私人订单里点一张放弃。", note: "凑齐订单上的宝石，结束时加分；私人订单别人看不到。下面的公共订单谁先凑齐归谁。" },
  { id: "buy", kind: "do", lesson: "工具", anchor: "buy:drill", expect: { type: "buy", tool: "drill" }, say: "工具决定能挖什么：在商店买一把钻。", note: "钻每次挖掘进度 +2，坚硬的宝石只能用钻。工具也占背包格子。" },
  { id: "ready", kind: "do", lesson: "工具", anchor: "confirm", expect: confirm, say: "配好了就点「准备好了，下井」。", note: "背包 6 格：空格越多，每回合走得越远（移动力 = 空格数 + 2）。" },
  { id: "map", kind: "info", lesson: "移动", anchor: `cell:${START}`, say: "这是浅脉，矿洞的第 1 层。你在 1 号井口。", note: "每回合二选一：走一段路，或者做一个动作（挖、捡、撤离）。" },
  { id: "move", kind: "do", lesson: "移动", anchor: `cell:${ACCESS}`, expect: { type: "plan", plan: { kind: "move", path: [ACCESS] } }, say: "点这个格子，再点「走到这里」。", note: "亮着的格子都走得到，上面的数字是要花的移动力。" },
  { id: "confirm-move", kind: "do", lesson: "同时行动", anchor: "confirm", expect: confirm, say: "选好了就点「确认行动」。", note: "大家都确认后一起结算。确认之后还能撤回重选。" },
  { id: "dig-1", kind: "do", lesson: "挖掘", anchor: `cell:${GEM_CELL}`, expect: { type: "plan", plan: { kind: "dig", gemId: GEM, toolId: DRILL } }, say: "宝石嵌在岩壁里，站在旁边才能挖：点它，选「用钻挖」。", note: "赤铁晶硬度 3：钻一次 +2，要挖两回合。" },
  { id: "confirm-dig-1", kind: "do", lesson: "挖掘", anchor: "confirm", expect: confirm, say: "确认行动。" },
  { id: "dig-2", kind: "do", lesson: "挖掘", anchor: `cell:${GEM_CELL}`, expect: { type: "plan", plan: { kind: "dig", gemId: GEM, toolId: DRILL } }, say: "再挖一下就出土了。", note: "两个人挖同一颗宝石，出土时会碎，只能按出力分到六成。" },
  { id: "confirm-dig-2", kind: "do", lesson: "挖掘", anchor: "confirm", expect: confirm, say: "确认行动。" },
  { id: "in-bag", kind: "info", lesson: "挖掘", anchor: "dock:bag", face: "happy", say: "宝石进了背包！不过要带回营地存入才算分。", note: "要是矿洞塌毁时你还在井下，背包里的宝石就全没了。" },
  { id: "collapse", kind: "info", lesson: "塌方", anchor: "collapse", face: "think", say: "每挖一下矿洞都会震动，塌方进度慢慢涨。", note: "到 24 晶心塌，32 回廊塌，40 整个矿洞塌毁、游戏结束。钻和炸药震得更厉害。" },
  { id: "go-home", kind: "do", lesson: "回营地", anchor: `cell:${START}`, expect: { type: "plan", plan: { kind: "move", path: [START] } }, say: "往回走：点 1 号井口，选「走到这里」。" },
  { id: "confirm-home", kind: "do", lesson: "回营地", anchor: "confirm", expect: confirm, say: "确认行动。" },
  { id: "evacuate", kind: "do", lesson: "回营地", anchor: `cell:${START}`, expect: { type: "plan", plan: { kind: "evacuate" } }, say: "站在井口才能撤离：点脚下的井口，选「撤离回营地」。" },
  { id: "confirm-evacuate", kind: "do", lesson: "回营地", anchor: "confirm", expect: confirm, say: "确认行动。" },
  { id: "deposit", kind: "do", lesson: "计分", anchor: `deposit:${GEM}`, expect: { type: "deposit", gemId: GEM }, say: "回到营地了：点「存入」，赤铁晶就算分了。", note: "也可以卖掉换金币买工具，但卖掉的不算分。" },
  { id: "scoring", kind: "info", lesson: "计分", anchor: "dock:orders", say: "最后的分数 = 存入的宝石 + 碎裂分 + 订单奖励。", note: "私人订单凑齐才加分；公共订单第一个凑齐的人拿，同一回合一起凑齐就平分。" },
  { id: "layers", kind: "info", lesson: "三层矿洞", anchor: "layers", say: "越往下越值钱：浅脉宝石 2–4 分，回廊 4–12，晶心 11–24。", note: "但塌方从最深层开始，困在塌掉那层的人和宝石都出不来。走梯子、跳洞口或坐中央电梯下去。" },
  { id: "views", kind: "info", lesson: "三层矿洞", anchor: "view-switch", say: "点「立体」能看到三层叠在一起，两种视图都能缩放。", note: "立体视图里点别的层就切过去；「◎ 我」会回到你所在的层。" },
  { id: "descend", kind: "do", lesson: "回营地", anchor: `cell:${START}`, expect: { type: "plan", plan: { kind: "descend", well: 0 } }, say: "再下井：点亮着的井口，选「从 1 号井口下井」。", note: "六个井口都能下，挑离想挖的宝石最近的。" },
  { id: "retire", kind: "info", lesson: "结束", anchor: "retire", face: "think", say: "觉得来不及了就「收工」：不再下井，分数保住。", note: "所有人都收工，或者塌方到 40，开采季结束。同分比凑齐的私人订单数，再比金币。" },
  { id: "auto", kind: "info", lesson: "托管", anchor: null, say: "限时内没确认，人机会替你走这一回合；连续两次超时就转为托管。", note: "托管就是人机代打，你点任何操作或「取消托管」就收回来。" },
  { id: "finale", kind: "info", finale: true, anchor: null, face: "happy", say: "剩下的交给你了，和咕噜一号把这局打完吧！", note: "拿不准就点「提示」，看人机会怎么走。" },
];

/** 两条命令是不是剧本要的那一步。订单放弃哪张、从哪个井口下都由玩家选；走路只看终点，挖掘只看挖哪颗。 */
export function sameCommand(actual: GameCommand, expected: GameCommand): boolean {
  if (actual.type !== expected.type) return false;
  switch (expected.type) {
    case "keepOrders":
      return true;
    case "buy":
      return actual.type === "buy" && actual.tool === expected.tool;
    case "deposit":
    case "sell":
      return (actual as { gemId: string }).gemId === expected.gemId;
    case "plan": {
      if (actual.type !== "plan" || actual.plan.kind !== expected.plan.kind) return false;
      const a = actual.plan;
      const e = expected.plan;
      if (e.kind === "move" && a.kind === "move") return a.path.at(-1) === e.path.at(-1);
      if (e.kind === "dig" && a.kind === "dig") return a.gemId === e.gemId;
      if (e.kind === "descend" && a.kind === "descend") return true;
      return true;
    }
    default:
      return true;
  }
}

function pendingOf(state: GameState, player: PlayerState): boolean {
  return state.phase !== "finished" && !player.confirmed && (state.phase === "setup" || player.status !== "retired");
}

/**
 * 对手先手：回合一开始就由人机规划好并确认（只看它自己的视图）。玩家还在规划时才做，
 * 这样玩家一确认就结算；玩家收工以后对手由练习局按 actor 一步步走。
 */
export function prepareRivals(state: GameState, selfId: string = TUTORIAL_SELF): GameState {
  let next = state;
  const self = next.players.find((player) => player.id === selfId);
  if (!self || !pendingOf(next, self)) return next;
  for (const rival of next.players) {
    if (rival.id === selfId || !pendingOf(next, rival)) continue;
    const before = `${next.phase}:${next.turn}`;
    for (const command of [...botPlan(redactGameForViewer(next, rival.id), rival.id).commands, { type: "confirm" } as const]) {
      try {
        next = applyCommand(next, rival.id, command);
      } catch {
        // 人机的指令不合法就跳过（不该发生）；最后的确认总会成功。
      }
      if (`${next.phase}:${next.turn}` !== before) return next;
    }
  }
  return next;
}

/** 教程里走一步：玩家的指令交给引擎，之后对手立刻规划好下一回合。 */
export function applyTutorial(state: GameState, playerId: string, command: GameCommand): GameState {
  const next = applyCommand(state, playerId, command);
  return prepareRivals(next);
}

export function createTutorialGame(selfName: string): GameState {
  const game = createGame([{ id: TUTORIAL_SELF, name: selfName }, { id: TUTORIAL_RIVAL, name: TUTORIAL_RIVAL_NAME }], TUTORIAL_SEED);
  return prepareRivals(game);
}

/** 练习局「再练一局」：新的随机地图，还是你和咕噜一号。 */
export function createPracticeGame(selfName: string, seed: number): GameState {
  const game = createGame([{ id: TUTORIAL_SELF, name: selfName }, { id: TUTORIAL_RIVAL, name: TUTORIAL_RIVAL_NAME }], seed);
  return prepareRivals(game);
}

/** 现在等谁行动：玩家还没确认就是玩家，否则是还没确认的对手；结束了返回 null。 */
export function tutorialActor(state: GameState, selfId: string = TUTORIAL_SELF): string | null {
  if (state.phase === "finished") return null;
  const pending = state.players.filter((player) => pendingOf(state, player));
  return pending.find((player) => player.id === selfId)?.id ?? pending[0]?.id ?? null;
}

/**
 * 某个锚点在这个局面下应该看得见（剧本单测用；网页上的锚点和这里一一对应）。
 * 地图格子：平面 / 立体视图都跟着玩家所在的层，所以要和玩家同一层（在营地时看浅脉）。
 */
export function anchorVisible(state: GameState, anchor: string | null, viewer: string = TUTORIAL_SELF): boolean {
  if (anchor === null) return true;
  const me = state.players.find((player) => player.id === viewer);
  if (!me) return false;
  if (anchor.startsWith("cell:")) {
    const cell = anchor.slice(5);
    const myLayer = me.status === "mine" && me.cell ? parseCell(me.cell).layer : 0;
    return parseCell(cell).layer === myLayer;
  }
  if (anchor === "panel:orders") return state.phase === "setup" && me.orderChoices.length > 0;
  if (anchor.startsWith("buy:")) return state.phase === "setup" || (state.phase === "play" && me.status === "camp");
  if (anchor === "confirm") return state.phase !== "finished" && !me.confirmed && (state.phase === "setup" ? me.orderChoices.length === 0 : me.status !== "retired");
  if (anchor.startsWith("deposit:")) return state.phase === "play" && me.status === "camp" && me.bag.includes(anchor.slice(8));
  if (anchor === "retire") return state.phase === "play" && me.status === "camp" && !me.confirmed;
  if (anchor === "turn" || anchor === "collapse" || anchor === "layers" || anchor === "view-switch" || anchor.startsWith("dock:")) return true;
  return false;
}
