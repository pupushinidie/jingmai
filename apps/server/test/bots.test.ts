import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import {
  botPlan,
  type AckResponse,
  type ClientToServerEvents,
  type GameCommand,
  type GameState,
  type LobbyRoomSnapshot,
  type PublicRoomSummary,
  type ServerToClientEvents,
} from "@jingmai/game";

// ---------- 本游戏的设定 ----------
type Capacity = 2 | 3 | 4;
const MIN_CAPACITY: Capacity = 2;
const MIN_PLAYERS = 2;
const SOLO_CAPACITY: Capacity = 4;
const FULL_TEST_CAPACITY: Capacity = 4;

/** 晶脉是同时行动：没确认、没收工的座位都要行动。 */
function pending(game: GameState, playerId: string): boolean {
  const me = game.players.find((player) => player.id === playerId);
  return !!me && game.phase !== "finished" && !me.confirmed && (game.phase === "setup" || me.status !== "retired");
}

/** 真人怎么走：照人机的打法下完这一回合的指令，再确认。 */
function humanMoves(game: GameState, playerId: string): GameCommand[] {
  return [...botPlan(game, playerId).commands, { type: "confirm" }];
}

/** 这个座位真的行动过：开局买了工具（人机替他配装）并且对局往前走了。 */
function actedBy(room: LobbyRoomSnapshot, playerId: string): boolean {
  const player = room.game?.players.find((candidate) => candidate.id === playerId);
  return !!player && room.game!.phase === "play" && room.game!.turn >= 2 && player.tools.length > 0;
}

// 人机立刻行动、每一步 300 ms 超时，测试才跑得快（服务端在导入时读这两个变量）。
process.env.BOT_DELAY_SCALE = "0";
process.env.TURN_MS = "300";


type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const clients = new Set<TestSocket>();
const latest = new Map<TestSocket, LobbyRoomSnapshot>();
let serverUrl = "";
let httpServer: typeof import("../src/index.js").httpServer;
let serverIo: typeof import("../src/index.js").io;
let nameSeq = 0;

function connect(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const client: TestSocket = createClient(serverUrl, { transports: ["websocket"], reconnection: false });
    clients.add(client);
    client.on("room:updated", (room) => latest.set(client, room));
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}

function nick(prefix: string): string {
  nameSeq += 1;
  return `${prefix}${nameSeq}`;
}

function call<T>(send: (ack: (response: AckResponse<T>) => void) => void): Promise<AckResponse<T>> {
  return new Promise((resolve) => send(resolve));
}

async function create(client: TestSocket, name: string, capacity: Capacity): Promise<LobbyRoomSnapshot> {
  const response = await call<LobbyRoomSnapshot>((ack) => client.emit("room:create", { name, capacity } as never, ack));
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

const addBot = (client: TestSocket) => call<void>((ack) => client.emit("room:add-bot", ack));

/** 再加几个人机，凑够开局人数。 */
async function addBotsUpTo(host: TestSocket, humansSeated: number): Promise<void> {
  for (let seat = humansSeated; seat < MIN_PLAYERS; seat += 1) expect((await addBot(host)).ok).toBe(true);
}
const start = (client: TestSocket) => call<LobbyRoomSnapshot>((ack) => client.emit("room:start", ack));

function lobby(client: TestSocket): Promise<PublicRoomSummary[]> {
  return new Promise((resolve) => client.emit("lobby:get", (response) => resolve(response.ok ? response.data : [])));
}

function updateWhere(client: TestSocket, test: (room: LobbyRoomSnapshot) => boolean, timeoutMs = 20_000): Promise<LobbyRoomSnapshot> {
  return new Promise((resolve, reject) => {
    const current = latest.get(client);
    if (current && test(current)) {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      client.off("room:updated", handler);
      reject(new Error("等不到想要的房间状态"));
    }, timeoutMs);
    const handler = (room: LobbyRoomSnapshot) => {
      if (!test(room)) return;
      clearTimeout(timer);
      client.off("room:updated", handler);
      resolve(room);
    };
    client.on("room:updated", handler);
  });
}

function seatOf(client: TestSocket): string {
  return latest.get(client)?.members.find((member) => member.id === client.id)?.playerId ?? "";
}

/** 这个真人每回合照 humanMoves 自动行动；返回停止函数。 */
function autoplay(client: TestSocket): () => void {
  let sentFor = "";
  const handler = (room: LobbyRoomSnapshot) => {
    const game = room.game;
    const me = seatOf(client);
    if (!game || !pending(game, me)) return;
    const key = `${game.phase}:${game.turn}`;
    if (sentFor === key) return;
    sentFor = key;
    for (const command of humanMoves(game, me)) client.emit("game:command", command, () => {});
  };
  client.on("room:updated", handler);
  const current = latest.get(client);
  if (current) handler(current);
  return () => client.off("room:updated", handler);
}

describe("人机", () => {
  beforeAll(async () => {
    const serverModule = await import("../src/index.js");
    httpServer = serverModule.httpServer;
    serverIo = serverModule.io;
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, resolve);
    });
    serverUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => serverIo.close(() => resolve()));
  });

  it("只有房主能加人机；坐满后加不了；房主能移出人机；首页列表标出人机", async () => {
    const host = await connect();
    const hostName = nick("房主");
    const { code } = await create(host, hostName, FULL_TEST_CAPACITY);
    const guest = await connect();
    expect((await call<LobbyRoomSnapshot>((ack) => guest.emit("room:join", { name: nick("客人"), code }, ack))).ok).toBe(true);

    expect((await addBot(guest)).ok).toBe(false);
    for (let seat = 2; seat < FULL_TEST_CAPACITY; seat += 1) expect((await addBot(host)).ok).toBe(true);
    const room = await updateWhere(host, (snapshot) => snapshot.members.length === FULL_TEST_CAPACITY);
    const bot = room.members.find((member) => member.bot)!;
    expect(bot).toMatchObject({ name: "咕噜一号", isHost: false, connected: true, bot: true });
    expect((await addBot(host)).ok).toBe(false);

    const summary = (await lobby(host)).find((candidate) => candidate.players[0]?.name === hostName)!;
    expect(summary.players.find((player) => player.name === "咕噜一号")?.bot).toBe(true);

    expect((await call<void>((ack) => host.emit("room:kick", bot.id, ack))).ok).toBe(true);
    await updateWhere(host, (snapshot) => snapshot.members.length === FULL_TEST_CAPACITY - 1 && !snapshot.members.some((member) => member.id === bot.id));
  });

  it("一个人加满人机就能开局，人机把整局打完；人机自动同意再来一局", async () => {
    const host = await connect();
    await create(host, nick("独行"), SOLO_CAPACITY);
    for (let seat = 1; seat < SOLO_CAPACITY; seat += 1) expect((await addBot(host)).ok).toBe(true);
    const names = (await updateWhere(host, (snapshot) => snapshot.members.length === SOLO_CAPACITY)).members.map((member) => member.name);
    expect(names.slice(1)).toEqual(["咕噜一号", "咕噜二号", "咕噜三号", "咕噜四号"].slice(0, SOLO_CAPACITY - 1));

    expect((await start(host)).ok).toBe(true);
    const stop = autoplay(host);
    const finished = await updateWhere(host, (snapshot) => snapshot.game?.phase === "finished", 60_000);
    stop();
    // 真的打完了一整局：走了好些回合，有人存入了宝石。
    expect(finished.game!.turn).toBeGreaterThan(8);
    expect(Object.values(finished.game!.gems).some((gem) => gem.location.type === "vault")).toBe(true);
    const bots = finished.members.filter((member) => member.bot).map((member) => member.id);
    expect(finished.rematch?.acceptedIds.sort()).toEqual(bots.sort());

    expect((await call<void>((ack) => host.emit("room:rematch", true, ack))).ok).toBe(true);
    const again = await updateWhere(host, (snapshot) => snapshot.game !== undefined && snapshot.game.phase !== "finished" && !snapshot.rematch);
    expect(again.game!.players).toHaveLength(SOLO_CAPACITY);
  }, 90_000);

  it("等待中最后一个真人离开，只剩人机的房间直接关掉", async () => {
    const host = await connect();
    const hostName = nick("房主");
    await create(host, hostName, MIN_CAPACITY);
    expect((await addBot(host)).ok).toBe(true);
    expect((await lobby(host)).some((candidate) => candidate.players[0]?.name === hostName)).toBe(true);
    expect((await call<void>((ack) => host.emit("room:leave", ack))).ok).toBe(true);
    expect((await lobby(host)).some((candidate) => candidate.players.some((player) => player.name === hostName))).toBe(false);
  });

  it("连续超时两次转托管，由人机代打；取消托管后交还", async () => {
    const idle = await connect();
    const active = await connect();
    const { code } = await create(idle, nick("发呆"), MIN_CAPACITY);
    expect((await call<LobbyRoomSnapshot>((ack) => active.emit("room:join", { name: nick("认真"), code }, ack))).ok).toBe(true);
    await addBotsUpTo(idle, 2);
    expect((await start(idle)).ok).toBe(true);
    const stop = autoplay(active);

    const isAuto = (snapshot: LobbyRoomSnapshot) => snapshot.members.find((member) => member.id === idle.id)?.auto === true;
    const idleSeat = seatOf(idle);
    // 第 1 次超时（准备阶段）还不托管，但这一步已经由人机代打：替他留了订单、配了工具。
    const first = await updateWhere(idle, (snapshot) => snapshot.game?.phase === "play");
    expect(isAuto(first)).toBe(false);
    expect(first.game!.players.find((player) => player.id === idleSeat)!.tools.length).toBeGreaterThan(0);
    expect(first.game!.players.find((player) => player.id === idleSeat)!.privateOrders).toHaveLength(2);
    // 第 2 次超时转托管。
    const autoRoom = await updateWhere(idle, isAuto);
    expect(autoRoom.game!.turn).toBeLessThanOrEqual(3);

    // 托管后人机立刻替他下完每回合：只剩人机要行动时没有倒计时，他也不再超时。
    const quick = await updateWhere(idle, (snapshot) => isAuto(snapshot) && !!snapshot.game && snapshot.game.phase === "play" && snapshot.game.turn >= autoRoom.game!.turn + 3);
    expect(quick.members.find((member) => member.id === idle.id)?.auto).toBe(true);
    await updateWhere(idle, (snapshot) => actedBy(snapshot, idleSeat));

    expect((await call<void>((ack) => idle.emit("room:auto", false, ack))).ok).toBe(true);
    await updateWhere(idle, (snapshot) => !isAuto(snapshot));
    stop();
  }, 30_000);

  it("掉线的人轮到时由人机代打（不算超时），用原昵称回来后交还", async () => {
    const leaver = await connect();
    const stayer = await connect();
    const leaverName = nick("掉线");
    const { code } = await create(leaver, leaverName, MIN_CAPACITY);
    expect((await call<LobbyRoomSnapshot>((ack) => stayer.emit("room:join", { name: nick("留下"), code }, ack))).ok).toBe(true);
    await addBotsUpTo(leaver, 2);
    const started = await start(leaver);
    if (!started.ok) throw new Error(started.error);
    const leaverSeat = started.data.members.find((member) => member.id === leaver.id)!.playerId;
    const stop = autoplay(stayer);
    leaver.disconnect();

    const played = await updateWhere(stayer, (snapshot) => actedBy(snapshot, leaverSeat) && snapshot.game!.turn >= 4);
    // 离线代打不算超时：打了好几回合也没转托管。
    expect(played.members.find((member) => member.playerId === leaverSeat)).toMatchObject({ connected: false });
    expect(played.members.find((member) => member.playerId === leaverSeat)?.auto).toBeUndefined();

    const back = await connect();
    const rejoined = await call<LobbyRoomSnapshot>((ack) => back.emit("room:join", { name: leaverName, code }, ack));
    expect(rejoined.ok && rejoined.data.members.find((member) => member.id === back.id)).toMatchObject({ playerId: leaverSeat, connected: true });
    stop();
  }, 30_000);

  it("真人不能用「咕噜」开头或带「人机」的昵称；人机的座位不能被顶替", async () => {
    const host = await connect();
    const bad = await call<LobbyRoomSnapshot>((ack) => host.emit("room:create", { name: "咕噜一号", capacity: 2 }, ack));
    expect(bad.ok).toBe(false);
    const bad2 = await call<LobbyRoomSnapshot>((ack) => host.emit("room:create", { name: "我是人机", capacity: 2 }, ack));
    expect(bad2.ok).toBe(false);
    const { code } = await create(host, nick("房主"), 2);
    expect((await addBot(host)).ok).toBe(true);
    expect((await start(host)).ok).toBe(true);
    const intruder = await connect();
    expect((await call<LobbyRoomSnapshot>((ack) => intruder.emit("room:join", { name: "咕噜一号", code }, ack))).ok).toBe(false);
  });
});
