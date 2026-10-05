// 本地测试用的陪玩机器人：先 npm run dev 并在网页里建房，再 node scripts/test-bot.mjs <房间码>
// 它会加入房间，准备阶段留两张订单、买一把镐，之后每回合都待命（在营地就留守）。
import { io } from "socket.io-client";
const code = process.argv[2];
const s = io("http://localhost:3004", { transports: ["websocket"] });
let acting = false;
const cmd = (c) => new Promise((r) => s.emit("game:command", c, r));
s.on("connect", () => s.emit("room:join", { name: "小晶", code }, (r) => console.log("join", r.ok || r.error)));
s.on("room:updated", async (room) => {
  const g = room.game; if (!g || acting) return;
  const me = g.players.find((p) => p.id === room.members.find((m) => m.id === s.id)?.playerId);
  if (!me || me.confirmed || g.phase === "finished") return;
  acting = true;
  try {
    if (g.phase === "setup") {
      if (me.orderChoices.length) await cmd({ type: "keepOrders", discardId: me.orderChoices[0].id });
      if (!me.tools.length) await cmd({ type: "buy", tool: "pick" });
    } else {
      await cmd({ type: "plan", plan: me.status === "camp" ? { kind: "stay" } : { kind: "wait" } });
    }
    const r = await cmd({ type: "confirm" });
    if (!r.ok) console.log("confirm", r.error);
  } finally { acting = false; }
});
