import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import type {
  AckResponse,
  ClientToServerEvents,
  GameCommand,
  LobbyRoomSnapshot,
  ServerToClientEvents,
} from "@jingmai/game";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const clients = new Set<TestSocket>();
let serverUrl = "";
let httpServer: typeof import("../src/index.js").httpServer;
let serverIo: typeof import("../src/index.js").io;

function connectClient(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const client: TestSocket = createClient(serverUrl, { transports: ["websocket"], reconnection: false });
    clients.add(client);
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}

function command(client: TestSocket, payload: GameCommand): Promise<AckResponse<LobbyRoomSnapshot>> {
  return new Promise((resolve) => client.emit("game:command", payload, resolve));
}

function waitForRoomUpdate(client: TestSocket, predicate: (room: LobbyRoomSnapshot) => boolean): Promise<LobbyRoomSnapshot> {
  return new Promise((resolve) => {
    const handler = (room: LobbyRoomSnapshot) => {
      if (!predicate(room)) return;
      client.off("room:updated", handler);
      resolve(room);
    };
    client.on("room:updated", handler);
  });
}

function unwrap<T>(response: AckResponse<T>): T {
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function startedRoom() {
  const host = await connectClient();
  const guest = await connectClient();
  const created = unwrap(await new Promise<AckResponse<LobbyRoomSnapshot>>((resolve) => host.emit("room:create", { name: "阿岩", capacity: 2 }, resolve)));
  unwrap(await new Promise<AckResponse<LobbyRoomSnapshot>>((resolve) => guest.emit("room:join", { name: "小晶", code: created.code }, resolve)));
  const started = unwrap(await new Promise<AckResponse<LobbyRoomSnapshot>>((resolve) => host.emit("room:start", resolve)));
  return { host, guest, code: created.code, started };
}

async function setup(client: TestSocket): Promise<LobbyRoomSnapshot> {
  // 用自己的视图取订单：别人视图里我的订单是隐藏的。
  const room = unwrap(await command(client, { type: "unconfirm" }));
  const me = room.members.find((member) => member.id === client.id)!;
  const player = room.game!.players.find((candidate) => candidate.id === me.playerId)!;
  unwrap(await command(client, { type: "keepOrders", discardId: player.orderChoices[0]!.id }));
  return unwrap(await command(client, { type: "confirm" }));
}

describe("晶脉房间与同时回合", () => {
  beforeAll(async () => {
    process.env.LAST_PLAYER_MS = "200";
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
    delete process.env.LAST_PLAYER_MS;
  });

  it("开局进入准备阶段，只看得到自己的私人订单", async () => {
    const { host, started } = await startedRoom();
    expect(started.game?.phase).toBe("setup");
    const me = started.members.find((member) => member.id === host.id)!;
    for (const player of started.game!.players) {
      const hidden = player.orderChoices.every((order) => order.hidden);
      expect(hidden).toBe(player.id !== me.playerId);
    }
  });

  it("双方确认后进入第 1 回合；双方都规划并确认后结算到第 2 回合", async () => {
    const { host, guest } = await startedRoom();
    await setup(host);
    const playing = waitForRoomUpdate(host, (room) => room.game?.phase === "play");
    await setup(guest);
    const turnOne = await playing;
    expect(turnOne.game?.turn).toBe(1);
    expect(turnOne.turnRemainingMs).toBeGreaterThan(80_000);

    unwrap(await command(host, { type: "plan", plan: { kind: "wait" } }));
    const afterHost = unwrap(await command(host, { type: "confirm" }));
    // 只剩最后一人：倒计时缩短
    expect(afterHost.turnRemainingMs).toBeLessThanOrEqual(200);
    // 别人看不到我的行动
    const guestView = await waitForRoomUpdate(guest, (room) => room.game?.players.some((p) => p.confirmed) ?? false);
    const hostSeat = guestView.members.find((member) => member.id === host.id)!.playerId;
    expect(guestView.game!.players.find((p) => p.id === hostSeat)!.plan).toBeUndefined();

    const next = waitForRoomUpdate(host, (room) => room.game?.turn === 2);
    unwrap(await command(guest, { type: "confirm" }));
    expect((await next).game?.collapse).toBe(1);
  });

  it("最后一人超时按待命处理", async () => {
    const { host, guest } = await startedRoom();
    await setup(host);
    await setup(guest);
    unwrap(await command(host, { type: "confirm" }));
    const next = await waitForRoomUpdate(guest, (room) => room.game?.turn === 2);
    expect(next.game?.log.at(-1)?.turn).toBe(1);
  });

  it("断线后用原昵称回到原座位", async () => {
    const { host, guest, code, started } = await startedRoom();
    const seat = started.members.find((member) => member.id === guest.id)!.playerId;
    guest.disconnect();
    await waitForRoomUpdate(host, (room) => room.members.some((member) => !member.connected));
    const again = await connectClient();
    const rejoined = unwrap(await new Promise<AckResponse<LobbyRoomSnapshot>>((resolve) => again.emit("room:join", { name: "小晶", code }, resolve)));
    const member = rejoined.members.find((candidate) => candidate.id === again.id)!;
    expect(member.playerId).toBe(seat);
    const me = rejoined.game!.players.find((player) => player.id === seat)!;
    expect(me.orderChoices.every((order) => !order.hidden)).toBe(true);
  });
});
