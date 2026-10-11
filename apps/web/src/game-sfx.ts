import { useEffect, useRef } from "react";
import { hexDistance, meetsRequirement, parseCell, vaultGems, type GameState, type PlayerState } from "@jingmai/game";
import { sfx, synth } from "./gm-sound.js";

/**
 * 晶脉的动作音效：这款没有逐条事件，对比前后两次对局状态推断刚发生了什么。
 * 自己的动作响亮，别人的减半；观战时都算别人的。第一次拿到状态（进房间、重连、观战刚进来）不出声，
 * 一下跳过好几回合（重连）不补放，新开一局只响一声开局。
 *
 * 规划阶段（营地操作即时生效）：
 *   选订单 card    买工具 coin    丢工具 pass    存入营地 宝石叮（招牌）+ chips，凑齐一张私人订单再 score
 *   卖宝石 coin    确认行动 place（别人确认：轻的 place）    撤回确认 pass
 * 结算（大家同时行动，按顺序错开）：
 *   移动 move（走几格响几步）    下井 / 回营地 / 坐电梯 绞车声（招牌，往下 / 往上滑）
 *   挖掘 镐子敲岩壁（招牌）      宝石出土 宝石叮（招牌）    拾取 / 交接 draw    切割 hit + tile
 *   宝石碎裂、被困丢宝石 bust    工具用坏 hit    收工 pass
 *   震动（挖掘让塌方多走一格）低沉的隆隆声（招牌）   某一层塌方 boom
 *   公共订单拿下 score（自己拿到响亮的大得分）
 *   新一回合要规划 yourTurn      超时被代做 timeout    开采季结束 reveal → 赢 / 输
 */

/** 开发时记下响了哪些声音（自测脚本读 window.__sfxLog）。 */
function cue(name: string, play: () => void, delayMs = 0) {
  const run = () => {
    if (import.meta.env.DEV) (window as unknown as { __sfxLog?: string[] }).__sfxLog?.push(name);
    play();
  };
  if (delayMs > 0) window.setTimeout(run, delayMs);
  else run();
}

/** 点地图格子（弹出这一格能做的事）、点不能去的地方。 */
export const pick = {
  select: (on = true) => cue(on ? "select" : "unselect", () => sfx.select(on)),
  deny: () => cue("deny", () => sfx.deny()),
};

/** 镐子敲在岩壁上：清脆的金属一声 + 碎石。 */
function pickaxe(at: number, v: number) {
  const p = synth.jitter(0.08);
  synth.tone(2350 * p, { at, duration: 0.09, volume: 0.1 * v, type: "triangle" });
  synth.tone(3700 * p, { at, duration: 0.05, volume: 0.05 * v });
  synth.noise({ at, duration: 0.05, volume: 0.32 * v, freq: 2800, q: 1.5 });
  synth.noise({ at: at + 0.03, duration: 0.18, volume: 0.12 * v, filter: "lowpass", freq: 900, freqTo: 300 });
}

/** 宝石叮：几个不成和弦的高音，像水晶碰在一起。 */
function gemChime(at: number, v: number) {
  [2093, 3136, 4186, 2637].forEach((f, i) => synth.tone(f * synth.jitter(0.01), { at: at + i * 0.045, duration: 0.5 - i * 0.08, volume: 0.07 * v }));
}

/** 绞车 / 电梯：链条咔哒几下，音高往下（下井）或往上（上来）滑。 */
function winch(at: number, v: number, down: boolean) {
  for (let i = 0; i < 4; i += 1) synth.noise({ at: at + i * 0.07, duration: 0.03, volume: 0.16 * v, freq: 1800, q: 3 });
  synth.tone(down ? 260 : 150, { at, duration: 0.45, volume: 0.09 * v, type: "triangle", glideTo: down ? 120 : 300 });
}

/** 震动：地底下低沉的隆隆声。 */
function rumble(at: number) {
  synth.noise({ at, duration: 0.9, volume: 0.3, filter: "lowpass", freq: 220, freqTo: 90 });
  synth.tone(48, { at, duration: 0.8, volume: 0.2 });
  synth.noise({ at: at + 0.25, duration: 0.25, volume: 0.08, freq: 1200, q: 0.8 });
}

function completedOrders(game: GameState, player: PlayerState): number {
  const vault = vaultGems(game, player.id);
  return player.privateOrders.filter((order) => !order.hidden && meetsRequirement(order.requirement, vault)).length;
}

/** myId：自己的玩家 id（观战传空字符串）；auto：托管中（新回合不叫「轮到你」）。 */
export function useGameSfx(game: GameState, myId: string, auto: boolean, secondsLeft: number | null) {
  const previous = useRef<GameState | null>(null);
  // 这一回合倒计时最后看到的秒数：结算时自己还没确认、时间也到了，就是超时被人机代做了。
  const lastSeconds = useRef<number | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = game;
    if (!prev || prev === game) return;
    if (game.turn < prev.turn || (prev.phase === "finished" && game.phase !== "finished")) {
      cue("gameStart", () => sfx.gameStart());
      return;
    }
    // 重连等一下跳了好几回合：不补放。
    if (game.turn - prev.turn > 1) return;
    const isMe = (id: string) => myId !== "" && id === myId;
    // 准备阶段结束、第 1 回合开始
    if (prev.phase === "setup" && game.phase === "play") {
      const meBefore = prev.players.find((player) => isMe(player.id));
      if (meBefore && !meBefore.confirmed) cue("confirm", () => sfx.place(true));
      cue("roundStart", () => sfx.roundStart(), 250);
      if (meBefore && !auto) cue("yourTurn", () => sfx.yourTurn(), 800);
      return;
    }
    const resolved = game.turn !== prev.turn || (prev.phase === "play" && game.phase === "finished");
    const before = new Map(prev.players.map((player) => [player.id, player]));

    if (!resolved) {
      // ---- 规划阶段的即时操作 ----
      let at = 0;
      for (const player of game.players) {
        const old = before.get(player.id);
        if (!old) continue;
        const mine = isMe(player.id);
        if (old.orderChoices.length > 0 && player.orderChoices.length === 0) {
          cue("orders", () => sfx.card(mine, 2), at);
          at += 150;
        }
        const deposited = old.bag.filter((id) => game.gems[id]?.location.type === "vault").length;
        const sold = old.bag.filter((id) => game.gems[id]?.location.type === "gone").length;
        if (deposited > 0) {
          cue("deposit", () => { gemChime(0, synth.level(mine)); sfx.chips(deposited, mine); }, at);
          at += 300;
          if (mine && completedOrders(game, player) > completedOrders(prev, old)) {
            cue("score", () => sfx.score(true, true), at);
            at += 350;
          }
        }
        if (sold > 0) {
          cue("sell", () => sfx.coin(mine), at);
          at += 200;
        }
        if (player.tools.length > old.tools.length) {
          cue("buy", () => sfx.coin(mine), at);
          at += 200;
        } else if (player.tools.length < old.tools.length && player.gold === old.gold) {
          cue("discardTool", () => sfx.pass(mine), at);
          at += 200;
        }
        if (!old.confirmed && player.confirmed) {
          cue("confirm", () => sfx.place(mine), at);
          at += 120;
        } else if (old.confirmed && !player.confirmed && player.status !== "retired") {
          cue("unconfirm", () => sfx.pass(mine), at);
          at += 120;
        }
      }
      return;
    }

    // ---- 一回合结算 ----
    let at = 120;
    const meBefore = prev.players.find((player) => isMe(player.id));
    if (meBefore && !meBefore.confirmed && meBefore.status !== "retired" && prev.phase !== "finished") {
      // 自己是最后一个确认的（这一下直接结算了），或者时间到了被人机代做
      if (lastSeconds.current !== null && lastSeconds.current <= 1) cue("timeout", () => sfx.timeout());
      else cue("confirm", () => sfx.place(true));
      at += 250;
    }
    let othersBudget = 4;
    const allow = (mine: boolean) => mine || othersBudget-- > 0;
    // 自己的放前面，别人的跟在后面（最多几声，免得一团）
    const order = [...game.players].sort((a, b) => Number(isMe(b.id)) - Number(isMe(a.id)));
    const newlyCollapsed = game.collapsedLayers.filter((layer) => !prev.collapsedLayers.includes(layer));

    for (const player of order) {
      const old = before.get(player.id);
      if (!old) continue;
      const mine = isMe(player.id);
      const v = synth.level(mine);
      // 下井 / 回营地 / 收工
      if (old.status === "camp" && player.status === "mine") {
        if (allow(mine)) cue("descend", () => winch(0, v, true), at);
        at += 300;
      } else if (old.status === "mine" && player.status === "camp") {
        const trapped = newlyCollapsed.length > 0 && old.bag.length > 0 && old.bag.every((id) => game.gems[id]?.location.type === "gone");
        if (trapped) {
          if (allow(mine)) cue("trapped", () => sfx.bust(mine), at + 500);
        } else if (allow(mine)) cue("evacuate", () => winch(0, v, false), at);
        at += 300;
      } else if (old.status !== "retired" && player.status === "retired") {
        if (allow(mine)) cue("retire", () => sfx.pass(mine), at);
        at += 200;
      } else if (old.status === "mine" && player.status === "mine" && old.cell && player.cell && old.cell !== player.cell) {
        const a = parseCell(old.cell);
        const b = parseCell(player.cell);
        if (allow(mine)) {
          if (a.layer !== b.layer) cue("lift", () => winch(0, v, b.layer > a.layer), at);
          else {
            const steps = Math.max(1, Math.min(6, hexDistance(a, b)));
            cue(`move:${steps}`, () => sfx.move(steps, mine), at);
          }
        }
        at += 250;
      }
      // 挖掘：自己贡献的进度涨了
      const dugGems = Object.values(game.gems).filter((gem) => (gem.contributions[player.id] ?? 0) > (prev.gems[gem.id]?.contributions[player.id] ?? 0) && prev.gems[gem.id]?.location.type === "wall");
      if (dugGems.length > 0 && allow(mine)) {
        cue("dig", () => { pickaxe(0, v); pickaxe(0.16, v * 0.7); }, at);
        at += 280;
      }
      // 背包里多了宝石：挖出土的 / 捡起来的 / 别人交过来的 / 切出来的
      const gained = player.bag.filter((id) => !old.bag.includes(id));
      const unearthed = gained.filter((id) => prev.gems[id]?.location.type === "wall");
      const cut = gained.filter((id) => !prev.gems[id]);
      const picked = gained.length - unearthed.length - cut.length;
      if (unearthed.length > 0 && allow(mine)) {
        cue("unearth", () => gemChime(0, v), at);
        at += 350;
      }
      if (cut.length > 0 && allow(mine)) {
        cue("cut", () => { sfx.hit(mine); sfx.tile(mine, 2, 1.2); }, at);
        at += 300;
      } else if (picked > 0 && allow(mine)) {
        cue("pickup", () => sfx.draw(mine, picked), at);
        at += 200;
      }
      // 工具用坏 / 跳洞口磕坏（结算时工具变少）
      if (player.tools.length < old.tools.length && player.status !== "camp" && allow(mine)) {
        cue("toolBroke", () => sfx.hit(mine), at);
        at += 200;
      }
      // 碎裂保底分涨了：多人一起挖、没有契约，宝石碎了
      if (player.shatterPoints > old.shatterPoints && allow(mine)) {
        cue("shatter", () => sfx.bust(mine), at);
        at += 400;
      }
    }

    // 环境：震动、塌方
    const extraCollapse = game.collapse - prev.collapse - 1;
    if (newlyCollapsed.length > 0) {
      cue("collapse", () => sfx.boom(true), at);
      at += 700;
    } else if (extraCollapse > 0) {
      cue("rumble", () => rumble(0), at);
      at += 600;
    }
    // 公共订单
    for (const order of game.publicOrders) {
      const was = prev.publicOrders.find((entry) => entry.id === order.id);
      if (!was || was.claimedBy.length > 0 || order.claimedBy.length === 0) continue;
      const mine = order.claimedBy.some(isMe);
      cue("score", () => sfx.score(mine, mine), at);
      at += 350;
    }

    if (game.phase === "finished") {
      const won = myId !== "" && game.winnerIds.includes(myId);
      cue("reveal", () => sfx.reveal(true), at + 200);
      cue(won ? "win" : "lose", () => sfx.gameOver(won), at + 750);
      return;
    }
    // 新一回合：还在场上的话提醒规划
    const meNow = game.players.find((player) => isMe(player.id));
    if (meNow && meNow.status !== "retired" && !auto) cue("yourTurn", () => sfx.yourTurn(), Math.max(500, at + 150));
  }, [game, myId]);
  // 放在上面那个 effect 后面：结算那一下读到的是上一次渲染时的秒数
  useEffect(() => {
    lastSeconds.current = secondsLeft;
  });
}
