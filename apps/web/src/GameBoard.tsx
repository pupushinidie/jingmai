import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  COLOR_NAMES,
  GEM_DEFS,
  LAYER_DEFS,
  PARAMS,
  TOOL_DEFS,
  TOOL_KINDS,
  TRAIT_NAMES,
  collapseWarning,
  describeRequirement,
  diggableGems,
  freeSlots,
  groundGemsAt,
  isWell,
  meetsRequirement,
  movePoints,
  nextElevator,
  parseCell,
  pathTo,
  reachableCells,
  scoreBreakdown,
  toolCanDig,
  vaultGems,
  wallGemAt,
  type CellKey,
  type GameCommand,
  type GameState,
  type Gem,
  type LayerIndex,
  type LobbyRoomSnapshot,
  type OrderCard,
  type Plan,
  type PlayerState,
  type Tool,
} from "@jingmai/game";
import GameRules from "./GameRules.js";
import Mine3D from "./Mine3D.js";
import MineMap, { SEAT_COLORS, type MapHighlights } from "./MineMap.js";
import { socket } from "./socket.js";

interface GameBoardProps {
  readonly room: LobbyRoomSnapshot;
  readonly busy: boolean;
  readonly error: string;
  readonly notice: string;
  readonly brand: ReactNode;
  readonly connection: ReactNode;
  readonly chat: ReactNode;
  readonly onCommand: (command: GameCommand) => void;
  readonly onRematch: (accept: boolean) => void;
  readonly onDissolve: () => void;
}

const LAYERS: LayerIndex[] = [0, 1, 2];
const VIEW_MODE_KEY = "jingmai:view-mode";

type ViewMode = "flat" | "3d";

/** 平面 / 立体视图的选择，记在本机浏览器里。 */
function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return window.localStorage.getItem(VIEW_MODE_KEY) === "3d" ? "3d" : "flat";
    } catch {
      return "flat";
    }
  });
  const update = (next: ViewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      // 隐私模式等情况下存不了，只在本次页面里生效。
    }
  };
  return [mode, update];
}

function gemLabel(gem: Gem): string {
  return `${GEM_DEFS[gem.kind].name}${gem.cut ? "碎块" : ""}`;
}

function locationLabel(player: PlayerState): string {
  if (player.status === "retired") return "已收工";
  if (player.status === "camp" || !player.cell) return "营地";
  const pos = parseCell(player.cell);
  const well = isWell(player.cell);
  return `${LAYER_DEFS[pos.layer].name}${well >= 0 ? ` · 井${well + 1}` : ""}`;
}

function describePlan(game: GameState, plan: Plan, me: PlayerState): string {
  switch (plan.kind) {
    case "move": {
      const last = plan.path[plan.path.length - 1]!;
      const layer = parseCell(last).layer;
      return `移动 ${plan.path.length} 步 → ${LAYER_DEFS[layer].name}`;
    }
    case "dig": {
      const gem = game.gems[plan.gemId];
      const tool = me.tools.find((candidate) => candidate.id === plan.toolId);
      return `用${tool ? TOOL_DEFS[tool.kind].name : "?"}挖${gem ? gemLabel(gem) : "宝石"}`;
    }
    case "pickup":
      return `捡起${game.gems[plan.gemId] ? gemLabel(game.gems[plan.gemId]!) : "宝石"}`;
    case "handoff": {
      const target = game.players.find((candidate) => candidate.id === plan.to);
      return `交给 ${target?.name ?? "?"}`;
    }
    case "cut":
      return "切割重型宝石";
    case "evacuate":
      return "撤离回营地";
    case "wait":
      return "待命";
    case "descend":
      return `从井${plan.well + 1}下井`;
    case "stay":
      return "留在营地";
    case "retire":
      return "收工";
  }
}

function useCountdown(room: LobbyRoomSnapshot): number | null {
  const [now, setNow] = useState(Date.now());
  const [anchor, setAnchor] = useState({ at: Date.now(), ms: room.turnRemainingMs });
  useEffect(() => setAnchor({ at: Date.now(), ms: room.turnRemainingMs }), [room]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  if (anchor.ms === undefined) return null;
  return Math.max(0, Math.ceil((anchor.ms - (now - anchor.at)) / 1000));
}

function GameBoard({ room, busy, error, notice, brand, connection, chat, onCommand, onRematch, onDissolve }: GameBoardProps) {
  const game = room.game!;
  const member = room.members.find((candidate) => candidate.id === socket.id);
  const myId = member?.playerId ?? "";
  const me = game.players.find((player) => player.id === myId);
  const isHost = member?.isHost ?? false;
  const secondsLeft = useCountdown(room);

  const myLayer = me?.status === "mine" && me.cell ? parseCell(me.cell).layer : 0;
  const [viewLayer, setViewLayer] = useState<LayerIndex>(myLayer);
  useEffect(() => setViewLayer(myLayer), [myLayer, game.turn]);
  const [selected, setSelected] = useState<CellKey | null>(null);
  const [viewMode, setViewMode] = useViewMode();
  const [digChoice, setDigChoice] = useState<string | null>(null);

  const canPlan = game.phase === "play" && me?.status === "mine" && !me.confirmed;
  const reach = useMemo(() => (me && canPlan ? reachableCells(game, me) : new Map()), [game, me, canPlan]);
  const diggable = useMemo(() => (me?.cell && canPlan ? diggableGems(game, me.cell) : []), [game, me, canPlan]);

  const highlights: MapHighlights = useMemo(() => {
    const plan = me?.plan;
    const result: { -readonly [K in keyof MapHighlights]: MapHighlights[K] } = {};
    if (canPlan) {
      result.reachable = new Map([...reach].map(([cell, info]) => [cell, info.cost]));
      result.diggable = new Set(diggable.map((gem) => (gem.location as { cell: CellKey }).cell));
    }
    if (plan?.kind === "move" && me?.cell) result.path = [me.cell, ...plan.path];
    if (plan?.kind === "dig") {
      const gem = game.gems[plan.gemId];
      if (gem?.location.type === "wall") result.digTarget = gem.location.cell;
    }
    if (selected) result.selected = selected;
    return result;
  }, [canPlan, reach, diggable, me, game.gems, selected]);

  function handleCellClick(cell: CellKey) {
    setSelected(cell);
    setDigChoice(null);
    if (!me || !canPlan) return;
    const gem = diggable.find((candidate) => candidate.location.type === "wall" && candidate.location.cell === cell);
    if (gem) {
      const usable = me.tools.filter((tool) => TOOL_DEFS[tool.kind].progress > 0 && toolCanDig(gem, tool.kind));
      if (usable.length === 1) onCommand({ type: "plan", plan: { kind: "dig", gemId: gem.id, toolId: usable[0]!.id } });
      else setDigChoice(gem.id);
      return;
    }
    if (cell !== me.cell && reach.has(cell)) {
      const path = pathTo(reach, cell);
      if (path && path.length > 0) onCommand({ type: "plan", plan: { kind: "move", path } });
    }
  }

  const warning = collapseWarning(game);
  const nextStop = nextElevator(game);

  return (
    <div className="jm-screen">
      <header className="jm-topbar">
        {brand}
        <div className="jm-turn">
          {game.phase === "setup" ? "准备阶段" : game.phase === "finished" ? "已结束" : `第 ${game.turn} 回合`}
          {secondsLeft !== null && game.phase !== "finished" && (
            <span className={secondsLeft <= 10 ? "jm-timer jm-timer-low" : "jm-timer"}>{secondsLeft}s</span>
          )}
        </div>
        <CollapseMeter game={game} />
        <div className="jm-topbar-right">
          <GameRules />
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve}>解散</button>}
          {connection}
        </div>
      </header>

      {warning && (
        <div className="jm-warning" role="alert">
          ⚠ {LAYER_DEFS[warning.layer].name}{warning.layer === 0 ? "（整个矿洞）" : ""}还差 {warning.remaining} 点进度就会塌方，预计最多还剩 {warning.remaining} 回合。
        </div>
      )}

      <section className="jm-map-area">
        <div className="jm-map-toolbar">
        <div className="jm-layer-tabs" role="tablist" aria-label="矿洞层">
          {LAYERS.map((layer) => {
            const count = game.players.filter((player) => player.status === "mine" && player.cell && parseCell(player.cell).layer === layer).length;
            const collapsed = game.collapsedLayers.includes(layer);
            return (
              <button
                key={layer}
                type="button"
                role="tab"
                aria-selected={viewLayer === layer}
                className={viewLayer === layer ? "jm-layer-tab active" : "jm-layer-tab"}
                onClick={() => setViewLayer(layer)}
              >
                <strong>{LAYER_DEFS[layer].name}</strong>
                <span>
                  第{layer + 1}层{collapsed ? " · 已塌方" : ""}
                  {game.elevator.layer === layer && !collapsed ? " · 电梯在此" : ""}
                  {count > 0 ? ` · ${count}人` : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="jm-view-switch" role="group" aria-label="地图视图">
          <button type="button" aria-pressed={viewMode === "flat"} className={viewMode === "flat" ? "active" : ""} onClick={() => setViewMode("flat")}>平面</button>
          <button type="button" aria-pressed={viewMode === "3d"} className={viewMode === "3d" ? "active" : ""} onClick={() => setViewMode("3d")}>立体</button>
        </div>
        </div>
        <div className="jm-map-frame">
          {viewMode === "3d" ? (
            <Mine3D game={game} activeLayer={viewLayer} myId={myId} highlights={highlights} onCellClick={handleCellClick} />
          ) : (
            <MineMap game={game} layer={viewLayer} myId={myId} highlights={highlights} onCellClick={handleCellClick} />
          )}
        </div>
        <div className="jm-map-footer">
          <span>电梯在{LAYER_DEFS[game.elevator.layer].name}{nextStop ? `，下一站${LAYER_DEFS[nextStop.layer].name}` : "（已停用）"}</span>
          {canPlan && <span>点亮的格子可以走到（右上角数字是移动消耗），点相邻的宝石可以挖。</span>}
        </div>
        {selected ? <CellInfo game={game} cell={selected} /> : <div className="jm-cell-info"><p>点地图上的格子查看详情。</p></div>}
      </section>

      <section className="jm-actions">
        {me && game.phase === "setup" && <SetupPanel game={game} me={me} busy={busy} onCommand={onCommand} />}
        {me && game.phase === "play" && me.status === "mine" && (
          <MineActions game={game} me={me} busy={busy} digChoice={digChoice} onDigChoice={setDigChoice} onCommand={onCommand} />
        )}
        {me && game.phase === "play" && me.status === "camp" && <CampPanel game={game} me={me} busy={busy} onCommand={onCommand} />}
        {me && game.phase === "play" && me.status === "retired" && <p className="jm-hint">你已经收工，等待其他人结束。</p>}
        {(error || notice) && <p className={error ? "jm-feedback jm-feedback-error" : "jm-feedback"} role={error ? "alert" : "status"}>{error || notice}</p>}
      </section>

      <aside className="jm-side">
        {me && <MyPanel game={game} me={me} />}
        <PublicOrders game={game} />
        <Rivals game={game} room={room} myId={myId} />
      </aside>

      <aside className="jm-feed">
        <TurnLog game={game} />
        <div className="jm-chat">{chat}</div>
      </aside>

      {game.phase === "finished" && <Results game={game} room={room} myId={myId} onRematch={onRematch} />}
    </div>
  );
}

// ---------- 顶栏 ----------

function CollapseMeter({ game }: { game: GameState }) {
  const max = LAYER_DEFS[0].collapseAt;
  return (
    <div className="jm-collapse" title={`塌方进度 ${game.collapse}/${max}；每回合 +1，每 ${PARAMS.vibrationPerCollapse} 点震动再 +1`}>
      <span className="jm-collapse-label">塌方 {game.collapse}/{max}</span>
      <div className="jm-collapse-bar">
        <i style={{ width: `${Math.min(100, (game.collapse / max) * 100)}%` }} />
        {([2, 1] as const).map((layer) => (
          <b key={layer} style={{ left: `${(LAYER_DEFS[layer].collapseAt / max) * 100}%` }} title={`${LAYER_DEFS[layer].name}塌方`} />
        ))}
      </div>
      <span className="jm-collapse-sub">震动 {game.vibration}/{PARAMS.vibrationPerCollapse}</span>
    </div>
  );
}

// ---------- 地图下方的格子说明 ----------

function CellInfo({ game, cell }: { game: GameState; cell: CellKey }) {
  const pos = parseCell(cell);
  const wall = wallGemAt(game, cell);
  const ground = groundGemsAt(game, cell);
  const players = game.players.filter((player) => player.status === "mine" && player.cell === cell);
  const link = game.links.find((candidate) => candidate.q === pos.q && candidate.r === pos.r && (candidate.upper === pos.layer || candidate.upper + 1 === pos.layer));
  const well = isWell(cell);
  const lines: string[] = [];
  if (wall) {
    const def = GEM_DEFS[wall.kind];
    lines.push(`${def.name}（${COLOR_NAMES[def.color]}）价值 ${wall.value} · 硬度 ${wall.hardness} · 进度 ${wall.progress}/${wall.hardness}`);
    lines.push(`可用工具：${def.trait === "resonance" ? "共鸣叉" : def.tools.map((tool) => TOOL_DEFS[tool].name).join("、")}${def.trait !== "resonance" ? "、炸药" : ""}${def.trait !== "none" ? ` · 特性：${TRAIT_NAMES[def.trait]}` : ""}`);
    const contributors = Object.entries(wall.contributions).map(([id, amount]) => `${game.players.find((player) => player.id === id)?.name ?? "?"} ${amount}`);
    if (contributors.length > 0) lines.push(`已出力：${contributors.join("，")}${contributors.length > 1 ? "（多人出力，出土时会碎裂）" : ""}`);
  }
  for (const gem of ground) lines.push(`地上：${gemLabel(gem)}，价值 ${gem.value}`);
  if (well >= 0) lines.push(`${well + 1} 号井口：站在这里可以撤离回营地。`);
  if (link) {
    const upper = LAYER_DEFS[link.upper].name;
    const lower = LAYER_DEFS[(link.upper + 1) as LayerIndex].name;
    lines.push(link.kind === "ladder"
      ? `梯子：${upper} ↔ ${lower}。下梯 1 格，上梯 ${PARAMS.ladderUpCost} 格（带绳索 1 格）；满载没绳索爬不上去。`
      : `洞口：${upper} → ${lower}，只能往下。跳下时随机一件工具耐久 −1，带绳索可免。`);
  }
  if (pos.q === 0 && pos.r === 0) lines.push("中央电梯：每回合结算时，站在电梯所在层中心的人随电梯到下一站。");
  if (players.length > 0) lines.push(`这里有：${players.map((player) => player.name).join("、")}`);
  if (lines.length === 0) lines.push(`${LAYER_DEFS[pos.layer].name}的通道。`);
  return (
    <div className="jm-cell-info">
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}

// ---------- 行动 ----------

function PlanBar({ game, me, busy, onCommand, children }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void; children?: ReactNode }) {
  const waiting = game.players.filter((player) => !player.confirmed && player.status !== "retired").length;
  return (
    <div className="jm-plan-bar">
      <div className="jm-plan-summary">
        <span className="jm-plan-label">本回合</span>
        <strong>{me.plan ? describePlan(game, me.plan, me) : me.status === "camp" ? "还没选（默认留守）" : "还没选（默认待命）"}</strong>
        {children}
      </div>
      {me.confirmed ? (
        <div className="jm-plan-confirmed">
          <span>✓ 已确认，等待其他 {waiting} 人</span>
          <button className="quiet-button" type="button" disabled={busy} onClick={() => onCommand({ type: "unconfirm" })}>撤回</button>
        </div>
      ) : (
        <button className="primary-button jm-confirm" type="button" disabled={busy} onClick={() => onCommand({ type: "confirm" })}>确认行动</button>
      )}
    </div>
  );
}

function MineActions({ game, me, busy, digChoice, onDigChoice, onCommand }: {
  game: GameState;
  me: PlayerState;
  busy: boolean;
  digChoice: string | null;
  onDigChoice: (gemId: string | null) => void;
  onCommand: (command: GameCommand) => void;
}) {
  const [handoff, setHandoff] = useState(false);
  const plan = (next: Plan) => {
    onDigChoice(null);
    setHandoff(false);
    onCommand({ type: "plan", plan: next });
  };
  const here = me.cell ? groundGemsAt(game, me.cell) : [];
  const chisel = me.tools.find((tool) => tool.kind === "chisel");
  const heavy = [...me.bag.map((id) => game.gems[id]!), ...here].filter((gem) => gem.heavy);
  const atWell = me.cell ? isWell(me.cell) >= 0 : false;
  const sameCell = game.players.filter((player) => player.id !== me.id && player.status === "mine" && player.cell === me.cell);
  const others = game.players.filter((player) => player.id !== me.id && player.status !== "retired");
  const digGem = digChoice ? game.gems[digChoice] : undefined;
  const locked = me.confirmed || busy;

  return (
    <div className="jm-action-panel">
      <div className="jm-action-buttons">
        <span className="jm-action-hint">在地图上点格子移动、点相邻宝石挖掘（移动力 {movePoints(game, me)}），或者：</span>
        {here.map((gem) => (
          <button key={gem.id} className="jm-chip-button" type="button" disabled={locked || freeSlots(game, me) < (gem.heavy ? 2 : 1)} onClick={() => plan({ kind: "pickup", gemId: gem.id })}>
            捡起{gemLabel(gem)}
          </button>
        ))}
        {chisel && heavy.map((gem) => (
          <button key={`cut-${gem.id}`} className="jm-chip-button" type="button" disabled={locked} onClick={() => plan({ kind: "cut", gemId: gem.id, toolId: chisel.id })}>
            切割{gemLabel(gem)}
          </button>
        ))}
        {atWell && <button className="jm-chip-button" type="button" disabled={locked} onClick={() => plan({ kind: "evacuate" })}>撤离回营地</button>}
        <button className="jm-chip-button" type="button" disabled={locked || sameCell.length === 0} onClick={() => setHandoff((open) => !open)} title={sameCell.length === 0 ? "要和对方站在同一格" : ""}>交接…</button>
        <button className="jm-chip-button" type="button" disabled={locked} onClick={() => plan({ kind: "wait" })}>待命</button>
      </div>

      {digGem && (
        <div className="jm-picker">
          <span>用什么挖{gemLabel(digGem)}？</span>
          {me.tools.filter((tool) => TOOL_DEFS[tool.kind].progress > 0).map((tool) => (
            <button key={tool.id} className="jm-chip-button" type="button" disabled={locked || !toolCanDig(digGem, tool.kind)} onClick={() => plan({ kind: "dig", gemId: digGem.id, toolId: tool.id })}>
              {TOOL_DEFS[tool.kind].name}（+{TOOL_DEFS[tool.kind].progress}）
            </button>
          ))}
          {!me.tools.some((tool) => toolCanDig(digGem, tool.kind)) && <span className="jm-hint">你没有能挖它的工具。</span>}
          <button className="quiet-button" type="button" onClick={() => onDigChoice(null)}>取消</button>
        </div>
      )}

      {handoff && (
        <div className="jm-picker">
          {sameCell.map((target) => (
            <div key={target.id} className="jm-picker-row">
              <span>交给 {target.name}{target.acceptFrom === me.id ? "" : "（对方需要设置接收你）"}：</span>
              {me.tools.map((tool) => (
                <button key={tool.id} className="jm-chip-button" type="button" disabled={locked} onClick={() => plan({ kind: "handoff", to: target.id, itemId: tool.id })}>{TOOL_DEFS[tool.kind].name}</button>
              ))}
              {me.bag.map((id) => (
                <button key={id} className="jm-chip-button" type="button" disabled={locked} onClick={() => plan({ kind: "handoff", to: target.id, itemId: id })}>{gemLabel(game.gems[id]!)}</button>
              ))}
            </div>
          ))}
        </div>
      )}

      <PlanBar game={game} me={me} busy={busy} onCommand={onCommand}>
        {others.length > 0 && (
          <label className="jm-accept">
            接收交接：
            <select
              value={me.acceptFrom ?? ""}
              disabled={busy}
              onChange={(event) => onCommand({ type: "accept", from: event.target.value || null })}
            >
              <option value="">不接收</option>
              {others.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
            </select>
          </label>
        )}
      </PlanBar>
    </div>
  );
}

function Shop({ game, me, busy, onCommand }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void }) {
  const full = freeSlots(game, me) < 1;
  return (
    <div className="jm-shop">
      <div className="jm-panel-title">商店 <span>金币 {me.gold} · 背包空 {freeSlots(game, me)} 格</span></div>
      <div className="jm-shop-grid">
        {TOOL_KINDS.map((kind) => {
          const def = TOOL_DEFS[kind];
          return (
            <button
              key={kind}
              type="button"
              className="jm-shop-item"
              disabled={busy || full || me.gold < def.price}
              onClick={() => onCommand({ type: "buy", tool: kind })}
              title={def.description}
            >
              <strong>{def.name}</strong>
              <span>{def.price} 金 · {def.durability === null ? "不损耗" : `耐久 ${def.durability}`}</span>
              <small>{def.description}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SetupPanel({ game, me, busy, onCommand }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void }) {
  const waiting = game.players.filter((player) => !player.confirmed).length;
  return (
    <div className="jm-action-panel">
      {me.orderChoices.length > 0 ? (
        <div className="jm-setup-orders">
          <div className="jm-panel-title">私人订单 <span>抽 {PARAMS.privateOrdersDrawn} 留 {PARAMS.privateOrdersKept}，点一张放弃</span></div>
          <div className="jm-order-choices">
            {me.orderChoices.map((order) => (
              <button key={order.id} type="button" className="jm-order-card" disabled={busy} onClick={() => onCommand({ type: "keepOrders", discardId: order.id })}>
                <strong>{order.name} <em>+{order.reward}</em></strong>
                <span>{describeRequirement(order.requirement)}</span>
                <small>放弃这张</small>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="jm-hint">已留下 {me.privateOrders.map((order) => `「${order.name}」`).join("")}。开局前用 {PARAMS.startingGold} 金币配装，没花完的留着回营地再用。</p>
      )}
      <Shop game={game} me={me} busy={busy || me.confirmed} onCommand={onCommand} />
      <ToolList game={game} me={me} busy={busy || me.confirmed} onCommand={onCommand} />
      <div className="jm-plan-bar">
        <div className="jm-plan-summary">
          <span className="jm-plan-label">起点</span>
          <strong>{me.cell ? `${isWell(me.cell) + 1} 号井口` : "-"}</strong>
        </div>
        {me.confirmed ? (
          <div className="jm-plan-confirmed">
            <span>✓ 准备好了，等待其他 {waiting} 人</span>
            <button className="quiet-button" type="button" disabled={busy} onClick={() => onCommand({ type: "unconfirm" })}>撤回</button>
          </div>
        ) : (
          <button className="primary-button jm-confirm" type="button" disabled={busy || me.orderChoices.length > 0} onClick={() => onCommand({ type: "confirm" })}>准备好了，下井</button>
        )}
      </div>
    </div>
  );
}

function ToolList({ game, me, busy, onCommand }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void }) {
  if (me.tools.length === 0) return null;
  void game;
  return (
    <div className="jm-camp-items">
      {me.tools.map((tool) => (
        <span key={tool.id} className="jm-item">
          {TOOL_DEFS[tool.kind].name}{tool.durability !== null ? ` ${tool.durability}` : ""}
          <button type="button" disabled={busy} onClick={() => onCommand({ type: "discardTool", toolId: tool.id })}>丢弃</button>
        </span>
      ))}
    </div>
  );
}

function CampPanel({ game, me, busy, onCommand }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void }) {
  const [retireArmed, setRetireArmed] = useState(false);
  const locked = busy || me.confirmed;
  const plan = (next: Plan) => onCommand({ type: "plan", plan: next });
  return (
    <div className="jm-action-panel">
      <p className="jm-hint">你在营地。存入的宝石计分并锁定价值；卖出换金币但不计分。下井会在本回合结束时出现在选的井口。</p>
      {me.bag.length > 0 && (
        <div className="jm-camp-items">
          {me.bag.map((id) => {
            const gem = game.gems[id]!;
            return (
              <span key={id} className={`jm-item jm-item-gem jm-c-${gem.color}`}>
                {gemLabel(gem)} {gem.value}
                <button type="button" disabled={locked} onClick={() => onCommand({ type: "deposit", gemId: id })}>存入</button>
                <button type="button" disabled={locked} onClick={() => onCommand({ type: "sell", gemId: id })}>卖 {gem.value} 金</button>
              </span>
            );
          })}
        </div>
      )}
      <Shop game={game} me={me} busy={locked} onCommand={onCommand} />
      <ToolList game={game} me={me} busy={locked} onCommand={onCommand} />
      <div className="jm-destinations">
        <span>本回合结束时：</span>
        {[0, 1, 2, 3, 4, 5].map((well) => (
          <button key={well} type="button" className={me.plan?.kind === "descend" && me.plan.well === well ? "jm-chip-button active" : "jm-chip-button"} disabled={locked} onClick={() => plan({ kind: "descend", well })}>
            井{well + 1}下井
          </button>
        ))}
        <button type="button" className={me.plan?.kind === "stay" ? "jm-chip-button active" : "jm-chip-button"} disabled={locked} onClick={() => plan({ kind: "stay" })}>留守</button>
        {retireArmed ? (
          <span className="jm-retire-confirm">
            收工后不能再下井，确定？
            <button type="button" className="jm-chip-button danger" disabled={locked} onClick={() => { setRetireArmed(false); plan({ kind: "retire" }); }}>确定收工</button>
            <button type="button" className="quiet-button" onClick={() => setRetireArmed(false)}>算了</button>
          </span>
        ) : (
          <button type="button" className={me.plan?.kind === "retire" ? "jm-chip-button active" : "jm-chip-button"} disabled={locked} onClick={() => setRetireArmed(true)}>收工…</button>
        )}
      </div>
      <PlanBar game={game} me={me} busy={busy} onCommand={onCommand} />
    </div>
  );
}

// ---------- 侧栏 ----------

function BagSlots({ game, player }: { game: GameState; player: PlayerState }) {
  const items: { key: string; label: string; sub: string; className: string; slots: number }[] = [
    ...player.tools.map((tool: Tool) => ({
      key: tool.id,
      label: TOOL_DEFS[tool.kind].name,
      sub: tool.durability === null ? "∞" : `耐久${tool.durability}`,
      className: "jm-slot jm-slot-tool",
      slots: 1,
    })),
    ...player.bag.map((id) => {
      const gem = game.gems[id]!;
      return { key: id, label: gemLabel(gem), sub: `值${gem.value}`, className: `jm-slot jm-slot-gem jm-c-${gem.color}`, slots: gem.heavy ? 2 : 1 };
    }),
  ];
  const free = freeSlots(game, player);
  return (
    <div className="jm-bag">
      {items.map((item) => (
        <div key={item.key} className={item.className} style={{ gridColumn: `span ${item.slots}` }}>
          <strong>{item.label}</strong>
          <span>{item.sub}</span>
        </div>
      ))}
      {Array.from({ length: Math.max(0, free) }, (_, index) => <div key={`free-${index}`} className="jm-slot jm-slot-empty" />)}
    </div>
  );
}

function OrderLine({ order, gems }: { order: OrderCard; gems: Gem[] }) {
  if (order.hidden) return null;
  const done = meetsRequirement(order.requirement, gems);
  return (
    <li className={done ? "jm-order done" : "jm-order"}>
      <span>{done ? "✓" : "○"} {order.name}</span>
      <em>{describeRequirement(order.requirement)}</em>
      <b>+{order.reward}</b>
    </li>
  );
}

function MyPanel({ game, me }: { game: GameState; me: PlayerState }) {
  const score = scoreBreakdown(game, me);
  const vault = vaultGems(game, me.id);
  return (
    <section className="jm-panel">
      <div className="jm-panel-title">
        <span className="jm-dot" style={{ background: SEAT_COLORS[me.seat % SEAT_COLORS.length] }} />
        我的矿队 <span>{locationLabel(me)}{me.status === "mine" ? ` · 移动力 ${movePoints(game, me)}` : ""} · 金币 {me.gold}</span>
      </div>
      <BagSlots game={game} player={me} />
      <div className="jm-score-line">
        总分 <strong>{score.total}</strong>
        <span>存入 {score.vault} · 碎裂 {score.shatter} · 公共 {score.publicOrders} · 私人 {score.privateOrders ?? 0}</span>
      </div>
      {vault.length > 0 && (
        <div className="jm-vault">
          营地里：{vault.map((gem) => <i key={gem.id} className={`jm-gem-chip jm-c-${gem.color}`} title={`${gemLabel(gem)} ${gem.value}`}>{gem.value}</i>)}
        </div>
      )}
      {me.privateOrders.length > 0 && (
        <ul className="jm-orders">
          {me.privateOrders.map((order) => <OrderLine key={order.id} order={order} gems={vault} />)}
        </ul>
      )}
    </section>
  );
}

function PublicOrders({ game }: { game: GameState }) {
  return (
    <section className="jm-panel">
      <div className="jm-panel-title">公共订单 <span>第一个存入满足条件的人拿奖励</span></div>
      <ul className="jm-orders">
        {game.publicOrders.map((order) => {
          const winners = order.claimedBy.map((id) => game.players.find((player) => player.id === id)?.name ?? "?");
          return (
            <li key={order.id} className={winners.length > 0 ? "jm-order claimed" : "jm-order"}>
              <span>{order.name}</span>
              <em>{describeRequirement(order.requirement)}{winners.length > 0 ? ` · ${winners.join("、")} 拿下` : ""}</em>
              <b>+{order.reward}</b>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Rivals({ game, room, myId }: { game: GameState; room: LobbyRoomSnapshot; myId: string }) {
  return (
    <section className="jm-panel">
      <div className="jm-panel-title">所有矿队 <span>工具和背包公开</span></div>
      <div className="jm-rivals">
        {game.players.filter((player) => player.id !== myId).map((player) => {
          const online = room.members.find((member) => member.playerId === player.id)?.connected ?? false;
          const score = scoreBreakdown(game, player);
          return (
            <div key={player.id} className={online ? "jm-rival" : "jm-rival offline"}>
              <div className="jm-rival-head">
                <span className="jm-dot" style={{ background: SEAT_COLORS[player.seat % SEAT_COLORS.length] }} />
                <strong>{player.name}</strong>
                {!online && <span className="jm-tag jm-tag-off">离线</span>}
                {game.phase !== "finished" && player.status !== "retired" && (
                  <span className={player.confirmed ? "jm-tag jm-tag-ok" : "jm-tag"}>{player.confirmed ? "已确认" : "规划中"}</span>
                )}
                <span className="jm-rival-score" title="公开分（不含私人订单）">{score.total}</span>
              </div>
              <div className="jm-rival-sub">{locationLabel(player)} · 金币 {player.gold} · {player.privateOrders.length} 张私人订单</div>
              <BagSlots game={game} player={player} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TurnLog({ game }: { game: GameState }) {
  const entries = [...game.log].reverse();
  return (
    <section className="jm-panel jm-log">
      <div className="jm-panel-title">井下消息</div>
      <div className="jm-log-list">
        {entries.length === 0 && <p className="jm-hint">每回合结算后，发生的事会出现在这里。</p>}
        {entries.map((entry) => (
          <div key={entry.turn} className="jm-log-turn">
            <strong>{entry.turn === 0 ? "开局" : `第 ${entry.turn} 回合`}</strong>
            {entry.events.length === 0 ? <p>大家都在待命。</p> : entry.events.map((event, index) => <p key={index}>{event}</p>)}
          </div>
        ))}
      </div>
    </section>
  );
}

function Results({ game, room, myId, onRematch }: { game: GameState; room: LobbyRoomSnapshot; myId: string; onRematch: (accept: boolean) => void }) {
  const ranked = [...game.players]
    .map((player) => ({ player, score: scoreBreakdown(game, player) }))
    .sort((a, b) => b.score.total - a.score.total);
  const accepted = room.rematch?.acceptedIds.includes(socket.id ?? "") ?? false;
  return (
    <div className="jm-results-backdrop">
      <section className="jm-results" role="dialog" aria-labelledby="jm-results-title">
        <h2 id="jm-results-title">开采季结束</h2>
        <table>
          <thead>
            <tr><th>矿队</th><th>存入</th><th>碎裂</th><th>公共</th><th>私人</th><th>总分</th></tr>
          </thead>
          <tbody>
            {ranked.map(({ player, score }) => (
              <tr key={player.id} className={game.winnerIds.includes(player.id) ? "winner" : ""}>
                <td>
                  {game.winnerIds.includes(player.id) ? "🏆 " : ""}{player.name}{player.id === myId ? "（你）" : ""}
                  <small>{player.privateOrders.map((order) => `${order.name}${meetsRequirement(order.requirement, vaultGems(game, player.id)) ? "✓" : "✗"}`).join(" ")}</small>
                </td>
                <td>{score.vault}</td>
                <td>{score.shatter}</td>
                <td>{score.publicOrders}</td>
                <td>{score.privateOrders ?? 0}</td>
                <td><strong>{score.total}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="jm-hint">地图种子 {game.seed}</p>
        {room.rematch && (
          <div className="jm-rematch">
            <span>再来一局？还剩 {Math.ceil(room.rematch.remainingMs / 1000)} 秒（{room.rematch.acceptedIds.length}/{room.members.length} 人同意）</span>
            <button className="primary-button" type="button" disabled={accepted} onClick={() => onRematch(true)}>{accepted ? "等待其他人" : "再来一局"}</button>
            <button className="quiet-button" type="button" onClick={() => onRematch(false)}>离开</button>
          </div>
        )}
      </section>
    </div>
  );
}

export default GameBoard;
