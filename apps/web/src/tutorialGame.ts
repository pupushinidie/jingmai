/**
 * 晶脉和教程有关的部分（共用的 tutorial/ 文件夹之外，每款游戏自己写的）：
 * 游戏 id、「提示」怎么说、「第一次遇到」小贴士什么时候出。
 */
import { botPlan, collapseWarning, parseCell, wellCells, type GameState } from "@jingmai/game";

/** 本机记录（gm-tutorial-<id>、gm-tips-<id>）用的游戏 id。 */
export const GAME_ID = "jingmai";

export interface Hint {
  readonly say: string;
  readonly note?: string;
  /** 高亮哪个元素（data-tutorial）；null 不指。 */
  readonly anchor: string | null;
}

/**
 * 「提示」：让人机从你的位置算这一回合（它本来就只看你能看到的信息，界面拿到的就是这份），
 * 告诉你它第一步会做什么、为什么，并指着该点的地方。
 */
export function hintFor(game: GameState, playerId: string): Hint {
  const me = game.players.find((player) => player.id === playerId);
  if (!me || game.phase === "finished") return { say: "这局已经结束了。", anchor: null };
  if (me.confirmed) return { say: "你已经确认了，等其他人。", anchor: null };
  if (game.phase === "play" && me.status === "retired") return { say: "你已经收工了，等其他人结束。", anchor: null };
  const { commands, reason } = botPlan(game, playerId);
  const first = commands[0];
  if (!first || (me.plan && first.type === "plan")) {
    return { say: "选好了就点「确认行动」。", anchor: "confirm", ...(reason ? { note: reason } : {}) };
  }
  switch (first.type) {
    case "keepOrders":
      return { say: "先在订单里放弃一张最难凑齐的。", note: reason, anchor: "panel:orders" };
    case "buy":
      return { say: "我会先去商店配工具。", note: reason, anchor: game.phase === "setup" ? `buy:${first.tool}` : "dock:store" };
    case "deposit":
    case "sell":
      return { say: first.type === "deposit" ? "先把背包里的宝石存入营地。" : "先卖掉便宜的宝石换工具。", note: reason, anchor: `deposit:${first.gemId}` };
    case "plan": {
      const plan = first.plan;
      if (plan.kind === "move") return { say: "往这里走。", note: reason, anchor: `cell:${plan.path.at(-1)}` };
      if (plan.kind === "dig") {
        const gem = game.gems[plan.gemId];
        return { say: "挖这颗宝石。", note: reason, anchor: gem?.location.type === "wall" ? `cell:${gem.location.cell}` : null };
      }
      if (plan.kind === "pickup" || plan.kind === "evacuate" || plan.kind === "wait") return { say: plan.kind === "evacuate" ? "撤离回营地。" : plan.kind === "pickup" ? "捡起脚下的宝石。" : "原地待命。", note: reason, anchor: me.cell ? `cell:${me.cell}` : null };
      if (plan.kind === "descend") return { say: `从 ${plan.well + 1} 号井口下井。`, note: reason, anchor: `cell:${wellCells()[plan.well]}` };
      if (plan.kind === "retire") return { say: "我会收工。", note: reason, anchor: "retire" };
      return { say: "留守营地。", note: reason, anchor: null };
    }
    default:
      return { say: "选好了就点「确认行动」。", note: reason, anchor: "confirm" };
  }
}

/** 「第一次遇到」小贴士的内容。 */
export const TIPS = {
  camp: { title: "回到营地了", text: "在「背包」里把宝石「存入」才算分；卖掉换金币买工具，但卖掉的不算分。" },
  warning: { title: "塌方预警", text: "快塌的那一层里的人和宝石都会出不来。来得及就往井口撤，或者先离开这一层。" },
  deep: { title: "到了下层", text: "越深宝石越值钱，但塌方先从最深层开始。记得留够回井口的回合。" },
  shatter: { title: "宝石碎了", text: "几个人都挖过的宝石，出土时会碎，按各自出力分到六成，记进「碎裂」分。" },
  retired: { title: "你收工了", text: "分数已经保住，等其他人收工或者塌方到 40 结束。" },
} as const;

/** 这一步该出哪些小贴士（按优先顺序；只出第一条没看过的）。 */
export function detectTips(game: GameState, selfId: string): string[] {
  const me = game.players.find((player) => player.id === selfId);
  if (!me || game.phase !== "play") return [];
  const ids: string[] = [];
  if (collapseWarning(game)) ids.push("warning");
  if (me.shatterPoints > 0) ids.push("shatter");
  if (me.status === "camp") ids.push("camp");
  if (me.status === "retired") ids.push("retired");
  if (me.status === "mine" && me.cell && parseCell(me.cell).layer > 0) ids.push("deep");
  return ids;
}
