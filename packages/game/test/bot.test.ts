import { describe, expect, it } from "vitest";
import {
  applyCommand,
  botCommand,
  botPlan,
  cellKey,
  createGame,
  GEM_DEFS,
  parseCell,
  redactGameForViewer,
  RuleViolation,
  timeoutTurn,
  TOOL_DEFS,
  wellCells,
  type CellKey,
  type GameState,
  type Gem,
  type PlayerState,
  type ToolKind,
} from "../src/index.js";

const PLAYERS = [
  { id: "a", name: "阿岩" },
  { id: "b", name: "咕噜一号" },
];

function startedGame(seed = 7): GameState {
  let state = createGame(PLAYERS, seed);
  for (const player of state.players) state = applyCommand(state, player.id, { type: "keepOrders", discardId: player.orderChoices[0]!.id });
  for (const player of state.players) state = applyCommand(state, player.id, { type: "confirm" });
  return state;
}

function gem(id: string, kind: Gem["kind"], cell: CellKey, extra: Partial<Gem> = {}): Gem {
  const def = GEM_DEFS[kind];
  return {
    id, kind, color: def.color, layer: parseCell(cell).layer, value: def.value, hardness: def.hardness,
    heavy: def.trait === "heavy", cut: false, location: { type: "wall", cell }, progress: 0, contributions: {}, decaySkipped: false, ...extra,
  };
}

function scene(state: GameState, opts: { gems?: Gem[]; players?: Record<string, Partial<PlayerState>>; tools?: Record<string, ToolKind[]>; collapse?: number }): GameState {
  const gems: Record<string, Gem> = {};
  for (const item of opts.gems ?? []) gems[item.id] = item;
  return {
    ...state,
    ...(opts.collapse !== undefined ? { collapse: opts.collapse } : {}),
    gems: opts.gems ? gems : state.gems,
    players: state.players.map((player) => ({
      ...player,
      ...opts.players?.[player.id],
      tools: opts.tools?.[player.id]?.map((kind, index) => ({ id: `${player.id}-t${index}`, kind, durability: TOOL_DEFS[kind].durability })) ?? player.tools,
    })),
  };
}

const view = (state: GameState, id = "b") => redactGameForViewer(state, id);

describe("人机只用自己看得到的信息", () => {
  it("对手的私人订单、本回合计划、地图种子不同，人机的决定完全一样", () => {
    const base = startedGame(11);
    const other = {
      ...base,
      seed: 12345,
      rngState: 999,
      players: base.players.map((player) =>
        player.id === "a"
          ? { ...player, privateOrders: [{ id: "x#1", name: "随便", requirement: { kind: "gemCount" as const, count: 1 }, reward: 99 }], plan: { kind: "wait" as const }, acceptFrom: "b" }
          : player,
      ),
    };
    // 两份完整状态不同，但人机座位看到的视图一样，决定也一样。
    expect(view(other)).not.toEqual(view(base));
    const strip = (state: GameState) => ({ ...view(state), players: view(state).players.map((player) => (player.id === "a" ? { ...player, acceptFrom: undefined } : player)) });
    expect(strip(other).seed).toBe(0);
    expect(botPlan(view(other), "b")).toEqual(botPlan(view(base), "b"));
    expect(view(base).seed).toBe(0);
    expect(view(base).players.find((player) => player.id === "a")!.privateOrders.every((order) => order.hidden)).toBe(true);
  });
});

describe("人机的关键决定", () => {
  it("准备阶段：放弃一张订单，买钻、凿、绳索", () => {
    const state = createGame(PLAYERS, 3);
    const plan = botPlan(view(state), "b");
    expect(plan.commands[0]!.type).toBe("keepOrders");
    expect(plan.commands.filter((command) => command.type === "buy").map((command) => (command as { tool: ToolKind }).tool)).toEqual(["drill", "chisel", "rope"]);
    expect(plan.reason).toContain("留下");
  });

  it("准备阶段超时、订单已经选过：只补缺的工具", () => {
    let state = createGame(PLAYERS, 3);
    state = applyCommand(state, "b", { type: "keepOrders", discardId: state.players[1]!.orderChoices[2]!.id });
    state = applyCommand(state, "b", { type: "buy", tool: "drill" });
    const plan = botPlan(view(state), "b");
    expect(plan.commands.map((command) => command.type)).toEqual(["buy", "buy"]);
  });

  it("脚下有挖出来的宝石就捡", () => {
    const spot = cellKey(0, 3, 0);
    const state = scene(startedGame(), { gems: [gem("g", "chitie", spot, { location: { type: "ground", cell: spot } })], players: { b: { cell: spot } }, tools: { b: ["drill"] } });
    expect(botPlan(view(state), "b").commands).toEqual([{ type: "plan", plan: { kind: "pickup", gemId: "g" } }]);
  });

  it("站在宝石旁边、工具合适就挖，理由里说还差几点", () => {
    const spot = cellKey(0, 3, 0);
    const state = scene(startedGame(), { gems: [gem("x", "chitie", cellKey(0, 4, 0))], players: { b: { cell: spot } }, tools: { b: ["drill", "pick"] } });
    const plan = botPlan(view(state), "b");
    expect(plan.commands).toEqual([{ type: "plan", plan: { kind: "dig", gemId: "x", toolId: "b-t0" } }]);
    expect(plan.reason).toContain("还差 1 点");
  });

  it("不碰共鸣晶（一个人挖不动，出土必碎）", () => {
    const spot = cellKey(2, 1, 0);
    const state = scene(startedGame(), { gems: [gem("gm", "gongming", cellKey(2, 2, 0))], players: { b: { cell: spot } }, tools: { b: ["fork", "drill", "chisel"] } });
    const plan = botPlan(view(state), "b").commands[0]!;
    expect(plan.type === "plan" && plan.plan.kind === "dig").toBe(false);
  });

  it("矿洞快塌毁了就往井口撤；站在井口就撤离", () => {
    const well = wellCells()[0]!;
    const near = scene(startedGame(), { gems: [gem("x", "chitie", cellKey(0, 0, 3))], players: { b: { cell: well } }, tools: { b: ["drill"] }, collapse: 37 });
    expect(botPlan(view(near), "b").commands).toEqual([{ type: "plan", plan: { kind: "evacuate" } }]);
    const far = scene(near, { players: { b: { cell: cellKey(0, 1, 0) } } });
    const step = botPlan(view(far), "b");
    expect(step.commands[0]!.type === "plan" && (step.commands[0] as { plan: { kind: string } }).plan.kind).toBe("move");
    expect(step.reason).toContain("快塌");
  });

  it("营地里：宝石全部存入；时间不够就收工", () => {
    let state = scene(startedGame(), {
      gems: [gem("v", "chitie", cellKey(0, 4, 0), { location: { type: "bag", playerId: "b" } })],
      players: { b: { status: "camp", bag: ["v"] } },
      tools: { b: ["drill", "chisel", "rope"] },
      collapse: 36,
    });
    delete (state.players[1] as { cell?: CellKey }).cell;
    const plan = botPlan(view(state), "b");
    expect(plan.commands).toEqual([{ type: "deposit", gemId: "v" }, { type: "plan", plan: { kind: "retire" } }]);
    expect(plan.reason).toContain("收工");
    // 时间还多、地图上还有宝石：存完就下井。
    state = { ...state, collapse: 2, gems: { ...startedGame().gems, v: state.gems.v! } };
    const early = botPlan(view(state), "b");
    expect(early.commands.at(-1)).toMatchObject({ type: "plan", plan: { kind: "descend" } });
  });

  it("一次一条的 botCommand 反复调用会收敛到确认", () => {
    let state = createGame(PLAYERS, 5);
    for (let guard = 0; guard < 10 && !state.players[1]!.confirmed; guard += 1) state = applyCommand(state, "b", botCommand(view(state), "b"));
    expect(state.players[1]!.confirmed).toBe(true);
  });
});

describe("自对弈", () => {
  it.each([2, 3, 4])("%i 人全是人机各 100 局：每条指令都合法，80 回合内结束", (count) => {
    let illegal = 0;
    let longest = 0;
    let slowest = 0;
    for (let game = 0; game < 100; game += 1) {
      let state = createGame(Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `p${index}` })), 1000 * count + game);
      const step = (id: string) => {
        const started = performance.now();
        const { commands } = botPlan(redactGameForViewer(state, id), id);
        slowest = Math.max(slowest, performance.now() - started);
        for (const command of [...commands, { type: "confirm" } as const]) {
          try {
            state = applyCommand(state, id, command);
          } catch (error) {
            if (!(error instanceof RuleViolation)) throw error;
            illegal += 1;
          }
        }
      };
      for (const player of state.players) step(player.id);
      for (let guard = 0; state.phase === "play"; guard += 1) {
        expect(guard).toBeLessThan(80);
        const turn = state.turn;
        for (const player of state.players) {
          const current = state.players.find((candidate) => candidate.id === player.id)!;
          if (state.phase !== "play" || state.turn !== turn || current.status === "retired" || current.confirmed) continue;
          step(player.id);
        }
        if (state.phase === "play" && state.turn === turn) state = timeoutTurn(state);
      }
      expect(state.phase).toBe("finished");
      longest = Math.max(longest, state.turn);
    }
    expect(illegal).toBe(0);
    expect(longest).toBeLessThanOrEqual(80);
    expect(slowest).toBeLessThan(300);
  }, 60_000);
});
