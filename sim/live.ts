// 让一个策略机器人开房陪你玩：npx tsx sim/live.ts [策略] [服务器地址]
// 例：npx tsx sim/live.ts diver
// 先 npm run dev。机器人建一个 2 人房（每回合 3 分钟）并打印房间码；你在网页里用房间码加入后
// 它自动开局，按选的策略和你对局；一局结束会同意再来一局。
// 机器人马上选好行动，但等其他人都确认了才确认：服务器在"只剩最后一人没确认"时只再等 60 秒，
// 机器人先确认的话真人每回合就只剩 60 秒。

import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, GameCommand, ServerToClientEvents } from "@jingmai/game";
import { STRATEGIES, makeRng, type Bot, type StrategyId } from "./bots.js";

const strategy = (process.argv[2] ?? "diver") as StrategyId;
const url = process.argv[3] ?? "http://localhost:3004";
if (!STRATEGIES[strategy] || strategy === "partner" || strategy === "traitor") {
  throw new Error(`没有这个策略：${strategy}（可选：prospector, diver, collector, blaster, leech, gambler, random）`);
}

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, { transports: ["websocket"] });
const newBot = (): Bot => STRATEGIES[strategy].create(makeRng(Date.now() % 1_000_000));
let bot = newBot();
let busy = false;
let starting = false;
/** 已经选好行动的"阶段:回合"，同一回合不重复下指令。 */
let handled = "";

const send = (command: GameCommand) =>
  new Promise<boolean>((resolve) => socket.emit("game:command", command, (response) => resolve(response.ok)));

socket.on("connect", () => {
  socket.emit("room:create", { name: `${STRATEGIES[strategy].name}机器人`, capacity: 2 }, (response) => {
    if (!response.ok) {
      console.error(response.error);
      process.exit(1);
    }
    socket.emit("room:turnSeconds", 180, () => {});
    console.log(`房间码：${response.data.code}（${STRATEGIES[strategy].name} ${STRATEGIES[strategy].english}，等你加入）`);
  });
});
socket.on("connect_error", (error) => {
  console.error(`连不上 ${url}：${error.message}。先运行 npm run dev。`);
  process.exit(1);
});

/** 最新收到的房间状态：忙着下指令时来的更新先记下，忙完再按它检查一遍。 */
let latest: Parameters<ServerToClientEvents["room:updated"]>[0] | null = null;
socket.on("room:updated", (room) => {
  latest = room;
  void handle(room);
});

async function handle(room: NonNullable<typeof latest>): Promise<void> {
  if (room.status === "waiting") {
    if (room.members.length >= 2 && !starting) {
      starting = true;
      setTimeout(() => socket.emit("room:start", (response) => {
        starting = false;
        if (!response.ok) console.log(response.error);
      }), 1500);
    }
    return;
  }
  const game = room.game;
  if (!game || busy) return;
  if (game.phase === "finished") {
    if (room.rematch && !room.rematch.acceptedIds.includes(socket.id ?? "")) socket.emit("room:rematch", true, () => {});
    return;
  }
  // 再来一局：回到准备阶段时换一个新的机器人（策略状态从头开始）。
  if (game.phase === "setup" && handled && !handled.startsWith("setup")) {
    handled = "";
    bot = newBot();
  }
  const playerId = room.members.find((member) => member.id === socket.id)?.playerId;
  const me = game.players.find((player) => player.id === playerId);
  const key = `${game.phase}:${game.turn}`;
  if (!me || me.confirmed || me.status === "retired") return;
  busy = true;
  try {
    if (handled !== key) {
      const commands = game.phase === "setup" ? bot.setup(game, me) : bot.turn(game, me);
      for (const command of commands) {
        if (command.type !== "confirm") await send(command);
      }
      handled = key;
    }
    const othersDone = game.players.every((player) => player.id === me.id || player.confirmed || (game.phase === "play" && player.status === "retired"));
    if (othersDone) await send({ type: "confirm" });
  } finally {
    busy = false;
  }
  if (latest && latest !== room) void handle(latest);
}
