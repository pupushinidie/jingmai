import { describe, expect, it } from "vitest";
import {
  applyCommand,
  cellKey,
  centerCell,
  checkPath,
  createGame,
  GEM_DEFS,
  hexDistance,
  LAYER_DEFS,
  layerCells,
  movePoints,
  neighbors,
  parseCell,
  redactGameForViewer,
  scoreBreakdown,
  timeoutTurn,
  TOOL_DEFS,
  wellCells,
  wellFairnessSpread,
  type CellKey,
  type GameCommand,
  type GameState,
  type Gem,
  type Plan,
  type PlayerState,
  type ToolKind,
} from "../src/index.js";

const PLAYERS = [
  { id: "a", name: "阿岩" },
  { id: "b", name: "小晶" },
];

/** 两人局，跳过准备阶段，直接进入第 1 回合。 */
function startedGame(seed = 7): GameState {
  let state = createGame(PLAYERS, seed);
  for (const player of state.players) {
    state = applyCommand(state, player.id, { type: "keepOrders", discardId: player.orderChoices[0]!.id });
  }
  for (const player of state.players) state = applyCommand(state, player.id, { type: "confirm" });
  return state;
}

/** 直接改状态搭场景：清空所有宝石，再放入需要的。 */
function withScene(
  state: GameState,
  scene: {
    players?: Record<string, Partial<PlayerState>>;
    gems?: Gem[];
    tools?: Record<string, ToolKind[]>;
  },
): GameState {
  const gems: Record<string, Gem> = {};
  for (const gem of scene.gems ?? []) gems[gem.id] = gem;
  return {
    ...state,
    gems: scene.gems ? gems : state.gems,
    players: state.players.map((player) => ({
      ...player,
      ...scene.players?.[player.id],
      tools: scene.tools?.[player.id]?.map((kind, index) => ({ id: `${player.id}-t${index}`, kind, durability: TOOL_DEFS[kind].durability })) ?? player.tools,
    })),
  };
}

function gem(id: string, kind: Gem["kind"], cell: CellKey, extra: Partial<Gem> = {}): Gem {
  const def = GEM_DEFS[kind];
  return {
    id,
    kind,
    color: def.color,
    layer: parseCell(cell).layer,
    value: def.value,
    hardness: def.hardness,
    heavy: def.trait === "heavy",
    cut: false,
    location: { type: "wall", cell },
    progress: 0,
    contributions: {},
    decaySkipped: false,
    ...extra,
  };
}

/** 双方同时规划并确认，返回结算后的状态。 */
function playTurn(state: GameState, plans: Record<string, Plan>, extra: Record<string, GameCommand[]> = {}): GameState {
  let next = state;
  for (const player of state.players) {
    if (player.status === "retired") continue;
    for (const command of extra[player.id] ?? []) next = applyCommand(next, player.id, command);
    next = applyCommand(next, player.id, { type: "plan", plan: plans[player.id] ?? (player.status === "camp" ? { kind: "stay" } : { kind: "wait" }) });
  }
  for (const player of state.players) {
    if (player.status === "retired") continue;
    next = applyCommand(next, player.id, { type: "confirm" });
  }
  return next;
}

const player = (state: GameState, id: string) => state.players.find((candidate) => candidate.id === id)!;

describe("地图生成", () => {
  it("同一种子生成同一张图", () => {
    expect(createGame(PLAYERS, 42).gems).toEqual(createGame(PLAYERS, 42).gems);
    expect(createGame(PLAYERS, 42).gems).not.toEqual(createGame(PLAYERS, 43).gems);
  });

  it.each([1, 2, 3, 99, 2026, 31337])("种子 %i 满足布局约束", (seed) => {
    const state = createGame(PLAYERS, seed);
    const gems = Object.values(state.gems);
    for (const layer of [0, 1, 2] as const) {
      const onLayer = gems.filter((candidate) => candidate.layer === layer);
      expect(onLayer).toHaveLength(LAYER_DEFS[layer].gemCount);
      for (const g of onLayer) expect(GEM_DEFS[g.kind].layers).toContain(layer);
    }
    expect(state.enabledKinds).toHaveLength(6);
    for (const upper of [0, 1]) {
      const links = state.links.filter((link) => link.upper === upper);
      expect(links.filter((link) => link.kind === "ladder")).toHaveLength(2);
      expect(links.filter((link) => link.kind === "hole")).toHaveLength(1);
      for (const link of links) {
        expect(hexDistance(link, { q: 0, r: 0 })).toBeGreaterThanOrEqual(2);
        expect(hexDistance(link, { q: 0, r: 0 })).toBeLessThanOrEqual(LAYER_DEFS[(upper + 1) as 1 | 2].radius);
      }
    }
    // 宝石互不相邻，且不压在中心、井口、梯子上。
    const cells = gems.map((g) => (g.location as { cell: CellKey }).cell);
    for (const cell of cells) {
      expect(neighbors(cell).some((next) => cells.includes(next))).toBe(false);
      expect(hexDistance(parseCell(cell), { q: 0, r: 0 })).toBeGreaterThanOrEqual(2);
      expect(wellCells()).not.toContain(cell);
      const pos = parseCell(cell);
      expect(state.links.some((link) => link.q === pos.q && link.r === pos.r && (link.upper === pos.layer || link.upper + 1 === pos.layer))).toBe(false);
    }
    const layer0 = gems.filter((g) => g.layer === 0).map((g) => ({ kind: g.kind, cell: (g.location as { cell: CellKey }).cell }));
    expect(wellFairnessSpread(layer0)).toBeLessThanOrEqual(0.2);
  });

  it("越往下宝石越值钱", () => {
    const state = createGame(PLAYERS, 5);
    const average = (layer: number) => {
      const onLayer = Object.values(state.gems).filter((g) => g.layer === layer);
      return onLayer.reduce((sum, g) => sum + g.value, 0) / onLayer.length;
    };
    expect(average(1)).toBeGreaterThan(average(0));
    expect(average(2)).toBeGreaterThan(average(1));
  });

  it("每人起点是不同的井口", () => {
    const state = createGame([...PLAYERS, { id: "c", name: "丙" }, { id: "d", name: "丁" }], 3);
    expect(new Set(state.players.map((p) => p.cell)).size).toBe(4);
    for (const p of state.players) expect(wellCells()).toContain(p.cell);
  });
});

describe("准备阶段", () => {
  it("选订单、买工具，全部确认后进入第 1 回合", () => {
    let state = createGame(PLAYERS, 1);
    expect(state.phase).toBe("setup");
    expect(() => applyCommand(state, "a", { type: "confirm" })).toThrow(/私人订单/);
    state = applyCommand(state, "a", { type: "keepOrders", discardId: player(state, "a").orderChoices[2]!.id });
    expect(player(state, "a").privateOrders).toHaveLength(2);
    state = applyCommand(state, "a", { type: "buy", tool: "drill" });
    state = applyCommand(state, "a", { type: "buy", tool: "pick" });
    state = applyCommand(state, "a", { type: "buy", tool: "chisel" });
    expect(player(state, "a").gold).toBe(2);
    expect(() => applyCommand(state, "a", { type: "buy", tool: "drill" })).toThrow(/金币不够/);
    state = applyCommand(state, "a", { type: "confirm" });
    expect(state.phase).toBe("setup");
    state = timeoutTurn(state);
    expect(state.phase).toBe("play");
    expect(state.turn).toBe(1);
    expect(player(state, "b").privateOrders).toHaveLength(2);
  });

  it("别人的私人订单和行动对我隐藏", () => {
    let state = startedGame();
    state = applyCommand(state, "b", { type: "plan", plan: { kind: "wait" } });
    const view = redactGameForViewer(state, "a");
    expect(player(view, "a").privateOrders.every((order) => !order.hidden)).toBe(true);
    expect(player(view, "b").privateOrders.every((order) => order.hidden)).toBe(true);
    expect(player(view, "b").plan).toBeUndefined();
    expect(scoreBreakdown(view, player(view, "b")).privateOrders).toBeNull();
  });
});

describe("移动", () => {
  it("移动力 = 空余格数 + 2，最多 8", () => {
    let state = startedGame();
    expect(movePoints(state, player(state, "a"))).toBe(8);
    state = withScene(state, { tools: { a: ["pick", "pick", "pick", "pick"] } });
    expect(movePoints(state, player(state, "a"))).toBe(4);
    state = withScene(state, { tools: { a: ["pick", "pick", "pick", "pick", "pick", "pick"] } });
    expect(movePoints(state, player(state, "a"))).toBe(2);
  });

  it("走不通或超出移动力的路径会被拒绝", () => {
    const state = withScene(startedGame(), { gems: [], players: { a: { cell: cellKey(0, 0, 0) } } });
    const far = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((q) => cellKey(0, q > 8 ? 8 : q, 0));
    expect(() => applyCommand(state, "a", { type: "plan", plan: { kind: "move", path: far } })).toThrow();
    const ok = applyCommand(state, "a", { type: "plan", plan: { kind: "move", path: [cellKey(0, 1, 0), cellKey(0, 2, 0)] } });
    expect(player(ok, "a").plan).toEqual({ kind: "move", path: [cellKey(0, 1, 0), cellKey(0, 2, 0)] });
  });

  it("上梯子要 3 格，带绳索 1 格；满载没绳索爬不上去", () => {
    const base = startedGame();
    const ladder = base.links.find((link) => link.upper === 0 && link.kind === "ladder")!;
    const below = cellKey(1, ladder.q, ladder.r);
    const above = cellKey(0, ladder.q, ladder.r);
    let state = withScene(base, { gems: [], players: { a: { cell: below } } });
    expect(checkPath(state, player(state, "a"), [above])).toEqual({ ok: true, cost: 3, holes: 0 });
    state = withScene(state, { tools: { a: ["rope"] } });
    expect(checkPath(state, player(state, "a"), [above])).toEqual({ ok: true, cost: 1, holes: 0 });
    state = withScene(state, { tools: { a: ["pick", "pick", "pick", "pick", "pick", "pick"] } });
    expect(checkPath(state, player(state, "a"), [above]).ok).toBe(false);
  });

  it("洞口只能往下，没带绳索跳下会损坏工具", () => {
    const base = startedGame();
    const hole = base.links.find((link) => link.upper === 0 && link.kind === "hole")!;
    let state = withScene(base, { gems: [], players: { a: { cell: cellKey(0, hole.q, hole.r) } }, tools: { a: ["pick"] } });
    state = playTurn(state, { a: { kind: "move", path: [cellKey(1, hole.q, hole.r)] } });
    expect(player(state, "a").cell).toBe(cellKey(1, hole.q, hole.r));
    expect(player(state, "a").tools[0]!.durability).toBe(5);
    expect(checkPath(state, player(state, "a"), [cellKey(0, hole.q, hole.r)]).ok).toBe(false);
  });
});

describe("挖掘与出土", () => {
  const spot = cellKey(0, 3, 0);
  const wall = cellKey(0, 4, 0);

  it("一个人挖满硬度，宝石进背包", () => {
    let state = withScene(startedGame(), {
      gems: [gem("x", "chitie", wall)],
      players: { a: { cell: spot } },
      tools: { a: ["drill"] },
    });
    state = playTurn(state, { a: { kind: "dig", gemId: "x", toolId: "a-t0" } });
    expect(state.gems.x!.progress).toBe(2);
    state = playTurn(state, { a: { kind: "dig", gemId: "x", toolId: "a-t0" } });
    expect(state.gems.x!.location).toEqual({ type: "bag", playerId: "a" });
    expect(player(state, "a").bag).toEqual(["x"]);
    expect(player(state, "a").tools[0]!.durability).toBe(2);
    // 钻每次震动 2，两回合 4 点震动 = 塌方 +1
    expect(state.collapse).toBe(3);
  });

  it("工具不对挖不了", () => {
    const state = withScene(startedGame(), { gems: [gem("x", "tiexin", wall)], players: { a: { cell: spot } }, tools: { a: ["pick"] } });
    expect(() => applyCommand(state, "a", { type: "plan", plan: { kind: "dig", gemId: "x", toolId: "a-t0" } })).toThrow(/不能用镐挖/);
  });

  it("两人合挖、没有契约：碎裂，按贡献分 60%", () => {
    let state = withScene(startedGame(), {
      gems: [gem("x", "chitie", wall)],
      players: { a: { cell: spot }, b: { cell: cellKey(0, 4, -1) } },
      tools: { a: ["drill"], b: ["pick"] },
    });
    state = playTurn(state, { a: { kind: "dig", gemId: "x", toolId: "a-t0" }, b: { kind: "dig", gemId: "x", toolId: "b-t0" } });
    expect(state.gems.x!.location).toEqual({ type: "gone" });
    // 价值 4 × 60% = 2.4；甲贡献 2/3 → 1，乙 1/3 → 0
    expect(player(state, "a").shatterPoints).toBe(1);
    expect(player(state, "b").shatterPoints).toBe(0);
  });

  it("共鸣晶要两人同回合用共鸣叉才有进度", () => {
    const deep = cellKey(2, 2, 0);
    let state = withScene(startedGame(), {
      gems: [gem("x", "gongming", deep)],
      players: { a: { cell: cellKey(2, 1, 0) }, b: { cell: cellKey(2, 3, -1) } },
      tools: { a: ["fork"], b: ["fork"] },
    });
    state = playTurn(state, { a: { kind: "dig", gemId: "x", toolId: "a-t0" } });
    expect(state.gems.x!.progress).toBe(0);
    expect(player(state, "a").tools[0]!.durability).toBe(2);
    state = playTurn(state, { a: { kind: "dig", gemId: "x", toolId: "a-t0" }, b: { kind: "dig", gemId: "x", toolId: "b-t0" } });
    expect(state.gems.x!.progress).toBe(2);
  });

  it("背包满了，宝石留在原地，之后谁都能捡", () => {
    let state = withScene(startedGame(), {
      gems: [gem("x", "qingsha", wall)],
      players: { a: { cell: spot }, b: { cell: spot } },
      tools: { a: ["pick", "pick", "pick", "pick", "pick", "pick"] },
    });
    state = playTurn(state, { a: { kind: "dig", gemId: "x", toolId: "a-t0" } });
    expect(state.gems.x!.location).toEqual({ type: "ground", cell: wall });
    state = playTurn(state, { b: { kind: "move", path: [wall] } });
    state = playTurn(state, { b: { kind: "pickup", gemId: "x" } });
    expect(player(state, "b").bag).toEqual(["x"]);
  });

  it("炸药：进度 +4、价值 −30%、震动 +6", () => {
    let state = withScene(startedGame(), { gems: [gem("x", "xuepo", wall)], players: { a: { cell: spot } }, tools: { a: ["dynamite"] } });
    state = playTurn(state, { a: { kind: "dig", gemId: "x", toolId: "a-t0" } });
    expect(state.gems.x!.value).toBe(10);
    expect(player(state, "a").tools).toHaveLength(0);
    expect(state.collapse).toBe(1 + 1);
    expect(state.vibration).toBe(2);
  });

  it("翠芽晶在岩壁里每回合 +1，萤光石出土后每回合 −1", () => {
    let state = withScene(startedGame(), {
      gems: [gem("grow", "cuiya", cellKey(1, 4, 0)), gem("glow", "yingguang", wall, { location: { type: "bag", playerId: "a" } })],
      players: { a: { cell: spot, bag: ["glow"] } },
    });
    state = playTurn(state, {});
    expect(state.gems.grow!.value).toBe(6);
    expect(state.gems.glow!.value).toBe(9);
  });

  it("切割重型宝石：两块各值 35%", () => {
    let state = withScene(startedGame(), {
      gems: [gem("king", "zijingwang", wall, { location: { type: "bag", playerId: "a" } })],
      players: { a: { cell: spot, bag: ["king"] } },
      tools: { a: ["chisel"] },
    });
    state = playTurn(state, { a: { kind: "cut", gemId: "king", toolId: "a-t0" } });
    const pieces = player(state, "a").bag.map((id) => state.gems[id]!);
    expect(pieces).toHaveLength(2);
    expect(pieces.every((piece) => piece.value === 6 && !piece.heavy && piece.cut)).toBe(true);
  });
});

describe("电梯", () => {
  it("按 1→2→3→2→1 往返，站在电梯格上的人跟着换层", () => {
    let state = withScene(startedGame(), { gems: [], players: { a: { cell: centerCell(0) } } });
    const layers: number[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      layers.push(state.elevator.layer);
      state = playTurn(state, {});
    }
    expect(layers).toEqual([0, 1, 2, 1, 0]);
    expect(player(state, "a").cell).toBe(centerCell(1));
  });
});

describe("营地往返", () => {
  it("撤离 → 营地回合存入宝石 → 下井", () => {
    const well = wellCells()[2]!;
    let state = withScene(startedGame(), {
      gems: [gem("x", "chitie", well, { location: { type: "bag", playerId: "a" } })],
      players: { a: { cell: well, bag: ["x"] } },
    });
    state = playTurn(state, { a: { kind: "evacuate" } });
    expect(player(state, "a").status).toBe("camp");
    expect(() => applyCommand(state, "a", { type: "plan", plan: { kind: "wait" } })).toThrow(/营地/);
    state = playTurn(state, { a: { kind: "descend", well: 4 } }, { a: [{ type: "deposit", gemId: "x" }, { type: "buy", tool: "rope" }] });
    expect(state.gems.x!.location).toEqual({ type: "vault", playerId: "a" });
    expect(player(state, "a").status).toBe("mine");
    expect(player(state, "a").cell).toBe(wellCells()[4]);
    expect(scoreBreakdown(state, player(state, "a")).vault).toBe(4);
  });

  it("卖出的宝石换成金币，不计分", () => {
    let state = withScene(startedGame(), {
      gems: [gem("x", "xuepo", cellKey(0, 1, 1), { location: { type: "bag", playerId: "a" } })],
      players: { a: { status: "camp", bag: ["x"] } },
    });
    delete (state.players[0] as { cell?: string }).cell;
    state = applyCommand(state, "a", { type: "sell", gemId: "x" });
    expect(player(state, "a").gold).toBe(12 + 15);
    expect(scoreBreakdown(state, player(state, "a")).vault).toBe(0);
  });

  it("公共订单：第一个存满的人拿奖励，同回合平分", () => {
    let state = startedGame(11);
    const order = state.publicOrders[0]!;
    // 给两人各准备足够的宝石，同一回合存入
    const stock: Gem[] = [];
    for (const id of ["a", "b"]) {
      for (let i = 0; i < 6; i += 1) {
        const kind = (["qingsha", "chitie", "xuepo", "zijingwang", "gongming", "cuiya"] as const)[i]!;
        stock.push(gem(`${id}${i}`, kind, cellKey(2, 0, 0), { location: { type: "bag", playerId: id } }));
      }
    }
    state = withScene(state, {
      gems: stock,
      players: { a: { status: "camp", bag: stock.filter((g) => g.id.startsWith("a")).map((g) => g.id) }, b: { status: "camp", bag: stock.filter((g) => g.id.startsWith("b")).map((g) => g.id) } },
    });
    const deposits = (id: string) => stock.filter((g) => g.id.startsWith(id)).map((g) => ({ type: "deposit" as const, gemId: g.id }));
    state = playTurn(state, {}, { a: deposits("a"), b: deposits("b") });
    const claimed = state.publicOrders.find((candidate) => candidate.id === order.id)!;
    expect(claimed.claimedBy.sort()).toEqual(["a", "b"]);
    expect(player(state, "a").publicOrderPoints).toBeGreaterThanOrEqual(Math.floor(order.reward / 2));
  });
});

describe("塌方与结束", () => {
  it("塌方进度到 24，第三层塌方：人被困、宝石没收", () => {
    let state = withScene(startedGame(), {
      gems: [gem("x", "xuepo", cellKey(2, 2, 0), { location: { type: "bag", playerId: "a" } }), gem("y", "zijingwang", cellKey(2, -2, 0))],
      players: { a: { cell: cellKey(2, 1, 0), bag: ["x"] } },
    });
    state = { ...state, collapse: 23 };
    state = playTurn(state, {});
    expect(state.collapsedLayers).toContain(2);
    expect(player(state, "a").status).toBe("camp");
    expect(player(state, "a").bag).toEqual([]);
    expect(state.gems.x!.location.type).toBe("gone");
    expect(state.gems.y!.location.type).toBe("gone");
    expect(layerCells(2).some((cell) => checkPath(state, player(state, "b"), [cell]).ok)).toBe(false);
  });

  it("塌方到 40 游戏结束：井下的人失去宝石，营地的人自动存入", () => {
    let state = withScene(startedGame(), {
      gems: [
        gem("x", "chitie", cellKey(0, 1, 1), { location: { type: "bag", playerId: "a" } }),
        gem("y", "chitie", cellKey(0, 1, 1), { location: { type: "bag", playerId: "b" } }),
      ],
      players: { a: { bag: ["x"] }, b: { status: "camp", bag: ["y"] } },
    });
    state = { ...state, collapse: 39, collapsedLayers: [2, 1] };
    state = playTurn(state, {});
    expect(state.phase).toBe("finished");
    expect(state.gems.x!.location.type).toBe("gone");
    expect(state.gems.y!.location).toEqual({ type: "vault", playerId: "b" });
    expect(state.winnerIds).toEqual(["b"]);
  });

  it("所有人收工也会结束", () => {
    let state = withScene(startedGame(), { players: { a: { status: "camp" }, b: { status: "camp" } } });
    state = playTurn(state, { a: { kind: "retire" }, b: { kind: "retire" } });
    expect(state.phase).toBe("finished");
  });

  it("超时没确认的人按待命处理", () => {
    let state = withScene(startedGame(), { gems: [] });
    const start = player(state, "b").cell;
    state = applyCommand(state, "a", { type: "plan", plan: { kind: "wait" } });
    state = applyCommand(state, "a", { type: "confirm" });
    state = applyCommand(state, "b", { type: "plan", plan: { kind: "move", path: [neighbors(start!).find((cell) => cell !== start)!] } });
    state = timeoutTurn(state);
    expect(state.turn).toBe(2);
    expect(player(state, "b").cell).toBe(start);
  });
});
