import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  COLOR_NAMES,
  GEM_DEFS,
  GROWTH_CAP,
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
  isPassable,
  isWell,
  meetsRequirement,
  movePoints,
  neighbors,
  nextElevator,
  parseCell,
  pathTo,
  reachableCells,
  scoreBreakdown,
  toolCanDig,
  usedSlots,
  vaultGems,
  wallGemAt,
  wellCells,
  type CellKey,
  type GameCommand,
  type GameState,
  type Gem,
  type GemTrait,
  type LayerIndex,
  type LobbyRoomSnapshot,
  type OrderCard,
  type Plan,
  type PlayerState,
  type Reach,
  type Tool,
} from "@jingmai/game";
import GameRules from "./GameRules.js";
import { GameRoomMenu, SpectateBar } from "./RoomExtras.js";
import FlatMap from "./FlatMap.js";
import Mine3D from "./Mine3D.js";
import { SEAT_COLORS, type MapHighlights } from "./MineMap.js";
import type { Point } from "./mapGeometry.js";
import { socket } from "./socket.js";

/**
 * 对局界面：地图占满整屏。点格子在旁边弹出这一格能做的事（移动、挖掘、拾取、切割、
 * 交接、撤离、下井），背包、商店、契约、订单等收进底部按钮，点开是浮动面板。
 */
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
  /** 观战时从这位玩家的座位看。 */
  readonly watchId: string;
  readonly onWatch: (playerId: string) => void;
  /** 观战的人离开。 */
  readonly onLeave: () => void;
}

const LAYERS: LayerIndex[] = [0, 1, 2];
const VIEW_MODE_KEY = "jingmai:view-mode";

type ViewMode = "flat" | "3d";
type PanelId = "bag" | "store" | "contract" | "orders" | "teams" | "log" | "chat";

const PANELS: readonly { id: PanelId; label: string }[] = [
  { id: "bag", label: "背包" },
  { id: "store", label: "商店" },
  { id: "contract", label: "契约" },
  { id: "orders", label: "订单" },
  { id: "teams", label: "队伍" },
  { id: "log", label: "消息" },
  { id: "chat", label: "聊天" },
];

/** 格子菜单的位置（相对地图区域），靠右或靠下时往反方向展开。 */
interface MenuState {
  readonly cell: CellKey;
  readonly x: number;
  readonly y: number;
  readonly alignRight: boolean;
  readonly alignBottom: boolean;
}

const TRAIT_HINTS: Record<GemTrait, string> = {
  none: "",
  decay: "出土后每回合价值 −1，带遮光袋改为每 2 回合 −1",
  growth: `留在岩壁里每回合价值 +1，最高 ${GROWTH_CAP}`,
  hard: "只能用钻挖",
  heavy: "占背包 2 格，可以用凿切成两块",
  curse: "放在背包里移动力 −2，封印盒可以压住一颗",
  resonance: "要两人同回合用共鸣叉一起挖才有进度",
};

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

/** 服务端给的剩余毫秒数换成本地倒计时；每收到新快照（syncKey 变化）重新校准。 */
function useCountdown(remainingMs: number | undefined, syncKey: unknown): number | null {
  const [now, setNow] = useState(Date.now());
  const [anchor, setAnchor] = useState({ at: Date.now(), ms: remainingMs });
  useEffect(() => setAnchor({ at: Date.now(), ms: remainingMs }), [remainingMs, syncKey]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  if (anchor.ms === undefined) return null;
  return Math.max(0, Math.ceil((anchor.ms - (now - anchor.at)) / 1000));
}

function gemLabel(gem: Gem): string {
  return `${GEM_DEFS[gem.kind].name}${gem.cut ? "碎块" : ""}`;
}

function toolLabel(tool: Tool): string {
  return `${TOOL_DEFS[tool.kind].name}${tool.durability !== null ? ` ${tool.durability}` : ""}`;
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

function GameBoard({ room, busy, error, notice, brand, connection, chat, onCommand, onRematch, onDissolve, watchId, onWatch, onLeave }: GameBoardProps) {
  const game = room.game!;
  const member = room.members.find((candidate) => candidate.id === socket.id);
  // 观战的人没有座位：牌桌按 watchId 那位玩家的座位摆（me 就是他），但什么都不能点，也不叫「你」。
  const spectating = !member;
  const myId = member?.playerId ?? watchId;
  const selfId = spectating ? "" : myId;
  const me = game.players.find((player) => player.id === myId);
  const isHost = member?.isHost ?? false;
  const secondsLeft = useCountdown(room.turnRemainingMs, room);

  const myLayer = me?.status === "mine" && me.cell ? parseCell(me.cell).layer : 0;
  const [viewLayer, setViewLayer] = useState<LayerIndex>(myLayer);
  useEffect(() => setViewLayer(myLayer), [myLayer, game.turn]);
  const [viewMode, setViewMode] = useViewMode();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  const canPlan = !spectating && game.phase === "play" && me?.status === "mine" && !me.confirmed;
  const choosingWell = !spectating && game.phase === "play" && me?.status === "camp" && !me.confirmed;
  // 观战时面板里的按钮都按不了（和「忙」一样处理）。
  const locked = busy || spectating;
  const reach = useMemo(() => (me && canPlan ? reachableCells(game, me) : new Map<CellKey, Reach>()), [game, me, canPlan]);
  const diggable = useMemo(() => (me?.cell && canPlan ? diggableGems(game, me.cell) : []), [game, me, canPlan]);

  const highlights: MapHighlights = useMemo(() => {
    const plan = me?.plan;
    const result: { -readonly [K in keyof MapHighlights]: MapHighlights[K] } = {};
    if (canPlan) {
      result.reachable = new Map([...reach].map(([cell, info]) => [cell, info.cost]));
      result.diggable = new Set(diggable.map((gem) => (gem.location as { cell: CellKey }).cell));
    }
    if (choosingWell) result.targets = new Set(wellCells());
    if (plan?.kind === "move" && me?.cell) result.path = [me.cell, ...plan.path];
    if (plan?.kind === "dig") {
      const gem = game.gems[plan.gemId];
      if (gem?.location.type === "wall") result.digTarget = gem.location.cell;
    }
    const plannedWell = plan?.kind === "descend" ? wellCells()[plan.well] : undefined;
    if (plannedWell) result.planned = plannedWell;
    if (menu) result.selected = menu.cell;
    return result;
  }, [canPlan, choosingWell, reach, diggable, me, game.gems, menu]);

  // 保持引用稳定：地图按它缓存格子内容，倒计时每秒刷新时不必重画整张图。
  const handleCellClick = useCallback((cell: CellKey, point: Point) => {
    const rect = mapRef.current?.getBoundingClientRect();
    if (!rect || spectating) return;
    const x = point.x - rect.left;
    const y = point.y - rect.top;
    setMenu((current) => (current?.cell === cell ? null : { cell, x, y, alignRight: x > rect.width / 2, alignBottom: y > rect.height * 0.55 }));
  }, [spectating]);
  const closeMenu = useCallback(() => setMenu(null), []);

  // 结算后、换层或换视图时，旧菜单的位置和内容都可能过时。
  useEffect(() => setMenu(null), [game.turn, game.phase, viewLayer, viewMode]);

  const menuOpen = useRef(false);
  menuOpen.current = menu !== null;
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuOpen.current) setMenu(null);
      else setPanel(null);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // 准备阶段先打开订单；选好订单后换到商店配装。
  const needsOrders = !spectating && game.phase === "setup" && (me?.orderChoices.length ?? 0) > 0;
  const previousNeedsOrders = useRef(false);
  useEffect(() => {
    if (needsOrders) setPanel("orders");
    else if (previousNeedsOrders.current && game.phase === "setup") setPanel((current) => (current === "orders" ? "store" : current));
    previousNeedsOrders.current = needsOrders;
  }, [needsOrders, game.phase]);

  // 开局（准备阶段 → 第 1 回合）时收起准备时打开的面板，把地图让出来。
  const previousPhase = useRef(game.phase);
  useEffect(() => {
    if (previousPhase.current === "setup" && game.phase === "play") setPanel(null);
    previousPhase.current = game.phase;
  }, [game.phase]);

  // 回到营地时打开背包：存入、卖出都在那里。
  const myStatus = me?.status;
  const previousStatus = useRef(myStatus);
  useEffect(() => {
    if (!spectating && myStatus === "camp" && previousStatus.current === "mine" && game.phase === "play") setPanel("bag");
    previousStatus.current = myStatus;
  }, [myStatus, game.phase]);

  // 消息和聊天的未读提示。
  const latestLogTurn = game.log.at(-1)?.turn ?? -1;
  const [seenLogTurn, setSeenLogTurn] = useState(latestLogTurn);
  useEffect(() => {
    if (panel === "log") setSeenLogTurn(latestLogTurn);
  }, [panel, latestLogTurn]);
  const lastChatId = room.chat.at(-1)?.id;
  const [seenChatId, setSeenChatId] = useState(lastChatId);
  useEffect(() => {
    if (panel === "chat") setSeenChatId(lastChatId);
  }, [panel, lastChatId]);
  const seenChatIndex = room.chat.findIndex((message) => message.id === seenChatId);
  const unreadChat = room.chat.slice(seenChatIndex + 1).filter((message) => message.senderId !== socket.id).length;

  const badges: Partial<Record<PanelId, string>> = {};
  if (needsOrders) badges.orders = "!";
  if (latestLogTurn > seenLogTurn) badges.log = "新";
  if (unreadChat > 0) badges.chat = String(Math.min(unreadChat, 99));

  const togglePanel = (id: PanelId) => {
    setMenu(null);
    setPanel((current) => (current === id ? null : id));
  };

  const myCell = me?.status === "mine" ? me.cell : undefined;
  const warning = collapseWarning(game);
  const nextStop = nextElevator(game);
  const panelTitle = PANELS.find((entry) => entry.id === panel)?.label ?? "";

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
          <GameRoomMenu room={room} />
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve}>解散</button>}
          {connection}
        </div>
      </header>

      <section className="jm-stage">
        <div className="jm-map-region" ref={mapRef}>
          <div className="jm-map-frame">
            {viewMode === "3d" ? (
              <Mine3D game={game} activeLayer={viewLayer} myId={myId} highlights={highlights} onCellClick={handleCellClick} onSelectLayer={setViewLayer} myCell={myCell} />
            ) : (
              <FlatMap game={game} layer={viewLayer} myId={myId} highlights={highlights} onCellClick={handleCellClick} onSelectLayer={setViewLayer} myCell={myCell} />
            )}
          </div>

          <div className="jm-hud-top">
            <div className="jm-layer-tabs" role="tablist" aria-label="矿洞层">
              {LAYERS.map((layer) => {
                const count = game.players.filter((player) => player.status === "mine" && player.cell && parseCell(player.cell).layer === layer).length;
                const collapsed = game.collapsedLayers.includes(layer);
                const meta = [
                  collapsed ? "已塌方" : `第${layer + 1}层`,
                  game.elevator.layer === layer && !collapsed ? "电梯" : "",
                  count > 0 ? `${count}人` : "",
                ].filter(Boolean).join(" · ");
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
                    <span>{meta}</span>
                  </button>
                );
              })}
            </div>
            <span className="jm-hud-chip" title="电梯每回合结算时走一站，站在电梯所在层中心的人跟着换层">
              电梯 {LAYER_DEFS[game.elevator.layer].name}{nextStop ? ` → ${LAYER_DEFS[nextStop.layer].name}` : "（停用）"}
            </span>
            <span className="jm-hud-spacer" />
            <div className="jm-view-switch" role="group" aria-label="地图视图">
              <button type="button" aria-pressed={viewMode === "flat"} className={viewMode === "flat" ? "active" : ""} onClick={() => setViewMode("flat")}>平面</button>
              <button type="button" aria-pressed={viewMode === "3d"} className={viewMode === "3d" ? "active" : ""} onClick={() => setViewMode("3d")}>立体</button>
            </div>
            {(warning || error || notice) && (
              <div className="jm-hud-messages">
                {warning && (
                  <p className="jm-warning" role="alert">
                    ⚠ {LAYER_DEFS[warning.layer].name}{warning.layer === 0 ? "（整个矿洞）" : ""}还差 {warning.remaining} 点就会塌方，最多还剩 {warning.remaining} 回合。
                  </p>
                )}
                {(error || notice) && (
                  <p className={error ? "jm-toast jm-toast-error" : "jm-toast"} role={error ? "alert" : "status"}>{error || notice}</p>
                )}
              </div>
            )}
          </div>

          {menu && me && (
            <CellMenu game={game} me={me} menu={menu} reach={reach} busy={busy} onCommand={onCommand} onClose={closeMenu} />
          )}

          {panel && panel !== "chat" && me && (
            <FloatingPanel title={panelTitle} onClose={() => setPanel(null)}>
              {panel === "bag" && <BagPanel game={game} me={me} busy={locked} onCommand={onCommand} />}
              {panel === "store" && <StorePanel game={game} me={me} busy={locked} onCommand={onCommand} />}
              {panel === "contract" && <ContractPanel game={game} />}
              {panel === "orders" && <OrdersPanel game={game} me={me} busy={locked} onCommand={onCommand} />}
              {panel === "teams" && <TeamsPanel game={game} room={room} myId={selfId} />}
              {panel === "log" && <LogPanel game={game} />}
            </FloatingPanel>
          )}
          {/* 聊天一直挂着，关掉面板也不丢正在输入的内容。 */}
          <FloatingPanel title="聊天" className="jm-float-chat" hidden={panel !== "chat"} onClose={() => setPanel(null)}>
            {chat}
          </FloatingPanel>
        </div>

        <footer className="jm-dock">
          {spectating
            ? <SpectateBar room={room} watchId={myId} onWatch={onWatch} onLeave={onLeave} />
            : <PlanBar game={game} me={me} busy={busy} onCommand={onCommand} onOpenPanel={setPanel} />}
          <nav className="jm-dock-buttons" aria-label="面板">
            {PANELS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={panel === id ? "jm-dock-button active" : "jm-dock-button"}
                aria-pressed={panel === id}
                onClick={() => togglePanel(id)}
              >
                {label}
                {id === "bag" && me && <small>{usedSlots(game, me)}/{PARAMS.bagSlots}</small>}
                {badges[id] && <b className="jm-badge">{badges[id]}</b>}
              </button>
            ))}
          </nav>
        </footer>
      </section>

      {game.phase === "finished" && <Results game={game} room={room} myId={selfId} spectating={spectating} onRematch={onRematch} onLeave={onLeave} />}
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

// ---------- 格子菜单 ----------

/** 这一格是什么：标题和几行说明。 */
function cellDetails(game: GameState, cell: CellKey): { title: string; lines: string[] } {
  const pos = parseCell(cell);
  const layerName = LAYER_DEFS[pos.layer].name;
  const wall = wallGemAt(game, cell);
  const well = isWell(cell);
  const link = game.links.find((candidate) => candidate.q === pos.q && candidate.r === pos.r && (candidate.upper === pos.layer || candidate.upper + 1 === pos.layer));
  const lines: string[] = [];
  let title = `${layerName}通道`;

  if (game.collapsedLayers.includes(pos.layer)) lines.push("这一层已经塌方，进不去了。");
  if (wall) {
    const def = GEM_DEFS[wall.kind];
    title = `${def.name}（${COLOR_NAMES[def.color]}）`;
    lines.push(`价值 ${wall.value} · 硬度 ${wall.hardness} · 进度 ${wall.progress}/${wall.hardness}`);
    lines.push(`可用工具：${def.trait === "resonance" ? "共鸣叉" : [...def.tools.map((tool) => TOOL_DEFS[tool].name), "炸药"].join("、")}`);
    if (def.trait !== "none") lines.push(`${TRAIT_NAMES[def.trait]}：${TRAIT_HINTS[def.trait]}`);
    const contributors = Object.entries(wall.contributions).map(([id, amount]) => `${game.players.find((player) => player.id === id)?.name ?? "?"} ${amount}`);
    if (contributors.length > 0) lines.push(`已出力：${contributors.join("，")}${contributors.length > 1 ? "（多人出力，出土时会碎裂）" : ""}`);
  } else if (well >= 0) {
    title = `${well + 1} 号井口`;
    lines.push("站在井口可以撤离回营地；在营地时从井口下井。");
  } else if (pos.q === 0 && pos.r === 0) {
    title = `中央电梯 · ${layerName}`;
    lines.push("每回合结算时，站在电梯所在层中心的人随电梯到下一站。");
  } else if (link) {
    const upper = LAYER_DEFS[link.upper].name;
    const lower = LAYER_DEFS[(link.upper + 1) as LayerIndex].name;
    title = link.kind === "ladder" ? `梯子 · ${upper} ↕ ${lower}` : `洞口 · ${upper} ↓ ${lower}`;
    lines.push(link.kind === "ladder"
      ? `下梯 1 格，上梯 ${PARAMS.ladderUpCost} 格（带绳索 1 格）；满载又没绳索爬不上去。`
      : "只能往下跳。跳下时随机一件工具耐久 −1，带绳索可免。");
  }
  for (const gem of groundGemsAt(game, cell)) lines.push(`地上有${gemLabel(gem)}，价值 ${gem.value}`);
  const players = game.players.filter((player) => player.status === "mine" && player.cell === cell);
  if (players.length > 0) lines.push(`这里有：${players.map((player) => player.name).join("、")}`);
  return { title, lines };
}

function MenuButton({ children, onClick, disabled, active, primary, title }: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  primary?: boolean;
  title?: string;
}) {
  const classes = ["jm-menu-button"];
  if (primary) classes.push("primary");
  if (active) classes.push("active");
  return (
    <button type="button" className={classes.join(" ")} disabled={disabled} title={title} onClick={onClick}>
      {children}
      {active && <i className="jm-menu-check" aria-label="当前计划">✓</i>}
    </button>
  );
}

function CellMenu({ game, me, menu, reach, busy, onCommand, onClose }: {
  game: GameState;
  me: PlayerState;
  menu: MenuState;
  reach: Map<CellKey, Reach>;
  busy: boolean;
  onCommand: (command: GameCommand) => void;
  onClose: () => void;
}) {
  const { cell } = menu;
  const details = cellDetails(game, cell);
  const current = me.plan;
  const plan = (next: Plan) => {
    onCommand({ type: "plan", plan: next });
    onClose();
  };
  const actions: ReactNode[] = [];
  let hint: string | null = null;

  if (game.phase === "play" && me.status === "mine" && me.cell) {
    const wall = wallGemAt(game, cell);
    if (me.confirmed) {
      hint = "本回合已确认，想改的话先撤回。";
      actions.push(<MenuButton key="unconfirm" disabled={busy} onClick={() => onCommand({ type: "unconfirm" })}>撤回确认</MenuButton>);
    } else if (wall) {
      if (!neighbors(me.cell).includes(cell)) {
        hint = "要站到它旁边的格子才能挖。";
      } else {
        const diggers = me.tools.filter((tool) => TOOL_DEFS[tool.kind].progress > 0);
        for (const tool of diggers) {
          const usable = toolCanDig(wall, tool.kind);
          const def = TOOL_DEFS[tool.kind];
          actions.push(
            <MenuButton
              key={tool.id}
              primary={usable}
              disabled={busy || !usable}
              active={current?.kind === "dig" && current.gemId === wall.id && current.toolId === tool.id}
              title={usable ? def.description : `${GEM_DEFS[wall.kind].name}不能用${def.name}挖`}
              onClick={() => plan({ kind: "dig", gemId: wall.id, toolId: tool.id })}
            >
              用{def.name}挖 <small>进度 +{def.progress}{tool.durability !== null ? ` · 耐久 ${tool.durability}` : ""}</small>
            </MenuButton>,
          );
        }
        if (!diggers.some((tool) => toolCanDig(wall, tool.kind))) {
          const def = GEM_DEFS[wall.kind];
          const needed = def.trait === "resonance" ? "共鸣叉" : [...def.tools.map((tool) => TOOL_DEFS[tool].name), "炸药"].join("、");
          hint = `你没有能挖它的工具（需要${needed}），回营地在商店买。`;
        }
      }
    } else if (cell === me.cell) {
      const here = groundGemsAt(game, cell);
      for (const gem of here) {
        const fits = freeSlots(game, me) >= (gem.heavy ? 2 : 1);
        actions.push(
          <MenuButton key={`pick-${gem.id}`} primary={fits} disabled={busy || !fits} title={fits ? "" : "背包放不下"} active={current?.kind === "pickup" && current.gemId === gem.id} onClick={() => plan({ kind: "pickup", gemId: gem.id })}>
            捡起{gemLabel(gem)} <small>价值 {gem.value}{gem.heavy ? " · 占 2 格" : ""}</small>
          </MenuButton>,
        );
      }
      const chisel = me.tools.find((tool) => tool.kind === "chisel");
      if (chisel) {
        for (const gem of [...me.bag.map((id) => game.gems[id]!), ...here].filter((candidate) => candidate.heavy)) {
          actions.push(
            <MenuButton key={`cut-${gem.id}`} disabled={busy} active={current?.kind === "cut" && current.gemId === gem.id} onClick={() => plan({ kind: "cut", gemId: gem.id, toolId: chisel.id })}>
              用凿切割{gemLabel(gem)} <small>两块各值 {Math.floor(gem.value * PARAMS.cutShare)}</small>
            </MenuButton>,
          );
        }
      }
      if (isWell(cell) >= 0) {
        actions.push(
          <MenuButton key="evacuate" primary disabled={busy} active={current?.kind === "evacuate"} onClick={() => plan({ kind: "evacuate" })}>
            撤离回营地 <small>本回合结束时到营地</small>
          </MenuButton>,
        );
      }
      const sameCell = game.players.filter((player) => player.id !== me.id && player.status === "mine" && player.cell === cell);
      for (const target of sameCell) {
        const items = [
          ...me.tools.map((tool) => ({ id: tool.id, label: toolLabel(tool) })),
          ...me.bag.map((id) => ({ id, label: `${gemLabel(game.gems[id]!)} ${game.gems[id]!.value}` })),
        ];
        actions.push(
          <div key={`handoff-${target.id}`} className="jm-menu-group">
            <span>交给 {target.name}{target.acceptFrom === me.id ? "（对方已设置接收你）" : "（要对方设置接收你才会成功）"}</span>
            <div className="jm-menu-chips">
              {items.length === 0 && <em className="jm-hint">你没有可以交出的东西。</em>}
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={current?.kind === "handoff" && current.to === target.id && current.itemId === item.id ? "jm-chip-button active" : "jm-chip-button"}
                  disabled={busy}
                  onClick={() => plan({ kind: "handoff", to: target.id, itemId: item.id })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>,
        );
      }
      actions.push(
        <MenuButton key="wait" disabled={busy} active={current?.kind === "wait"} onClick={() => plan({ kind: "wait" })}>
          待命 <small>原地不动</small>
        </MenuButton>,
      );
    } else {
      const info = reach.get(cell);
      if (info && info.cost > 0) {
        const last = current?.kind === "move" ? current.path[current.path.length - 1] : undefined;
        actions.push(
          <MenuButton
            key="move"
            primary
            disabled={busy}
            active={last === cell}
            onClick={() => {
              const path = pathTo(reach, cell);
              if (path && path.length > 0) plan({ kind: "move", path });
            }}
          >
            走到这里 <small>消耗 {info.cost} / {movePoints(game, me)}</small>
          </MenuButton>,
        );
      } else {
        hint = isPassable(game, cell) ? `走不到：本回合移动力 ${movePoints(game, me)}。` : "这里过不去。";
      }
    }
    if (cell === me.cell) {
      const others = game.players.filter((player) => player.id !== me.id && player.status !== "retired");
      if (others.length > 0) {
        actions.push(
          <label key="accept" className="jm-menu-accept">
            接收交接
            <select value={me.acceptFrom ?? ""} disabled={busy} onChange={(event) => onCommand({ type: "accept", from: event.target.value || null })}>
              <option value="">不接收</option>
              {others.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
            </select>
          </label>,
        );
      }
    }
  } else if (game.phase === "play" && me.status === "camp") {
    const well = isWell(cell);
    if (me.confirmed) {
      hint = "本回合已确认，想改的话先撤回。";
    } else if (well >= 0) {
      actions.push(
        <MenuButton key="descend" primary disabled={busy} active={current?.kind === "descend" && current.well === well} onClick={() => plan({ kind: "descend", well })}>
          从 {well + 1} 号井口下井 <small>本回合结束时出现在这里</small>
        </MenuButton>,
      );
    } else {
      hint = "你在营地。点浅脉边上亮起来的井口选择下井，或者在下方选留守、收工。";
    }
  } else if (game.phase === "setup" && cell === me.cell) {
    hint = "这是你的起点。在「订单」里选好订单、在「商店」配好工具，然后点「准备好了」。";
  }

  const style: CSSProperties = {
    left: menu.x,
    top: menu.y,
    transform: `translate(${menu.alignRight ? "calc(-100% - 12px)" : "12px"}, ${menu.alignBottom ? "calc(-100% + 12px)" : "-12px"})`,
  };
  return (
    <div className="jm-cell-menu" style={style} role="dialog" aria-label={details.title}>
      <header>
        <strong>{details.title}</strong>
        <button type="button" className="jm-menu-close" onClick={onClose} aria-label="关闭">×</button>
      </header>
      {details.lines.map((line) => <p key={line} className="jm-menu-line">{line}</p>)}
      {actions.length > 0 && <div className="jm-menu-actions">{actions}</div>}
      {hint && <p className="jm-menu-hint">{hint}</p>}
    </div>
  );
}

// ---------- 底部：本回合计划 ----------

function PlanBar({ game, me, busy, onCommand, onOpenPanel }: {
  game: GameState;
  me: PlayerState | undefined;
  busy: boolean;
  onCommand: (command: GameCommand) => void;
  onOpenPanel: (panel: PanelId) => void;
}) {
  const [retireArmed, setRetireArmed] = useState(false);
  useEffect(() => setRetireArmed(false), [game.turn]);
  if (!me) return <div className="jm-planbar"><span className="jm-hint">你在旁观这局。</span></div>;

  const waiting = game.players.filter((player) => !player.confirmed && (game.phase === "setup" || player.status !== "retired")).length;
  const stats = `${me.status === "mine" ? `移动力 ${movePoints(game, me)} · ` : ""}背包 ${usedSlots(game, me)}/${PARAMS.bagSlots} · 金币 ${me.gold}`;
  const confirmed = (
    <div className="jm-plan-confirmed">
      <span>✓ 已确认，等待其他 {waiting} 人</span>
      <button className="quiet-button" type="button" disabled={busy} onClick={() => onCommand({ type: "unconfirm" })}>撤回</button>
    </div>
  );

  if (game.phase === "finished") {
    return <div className="jm-planbar"><div className="jm-planbar-text"><strong>开采季结束</strong></div></div>;
  }
  if (game.phase === "setup") {
    const pending = me.orderChoices.length > 0;
    return (
      <div className="jm-planbar">
        <div className="jm-planbar-text">
          <span className="jm-plan-label">准备</span>
          <strong>{pending ? "先在「订单」里放弃一张" : `${me.cell ? `${isWell(me.cell) + 1} 号井口出发 · ` : ""}已留下${me.privateOrders.map((order) => `「${order.name}」`).join("")}`}</strong>
          <span className="jm-planbar-stats">{stats}</span>
        </div>
        <div className="jm-planbar-actions">
          {me.confirmed ? confirmed : pending ? (
            <button className="primary-button jm-confirm" type="button" onClick={() => onOpenPanel("orders")}>去选订单</button>
          ) : (
            <button className="primary-button jm-confirm" type="button" disabled={busy} onClick={() => onCommand({ type: "confirm" })}>准备好了，下井</button>
          )}
        </div>
      </div>
    );
  }
  if (me.status === "retired") {
    return <div className="jm-planbar"><div className="jm-planbar-text"><strong>你已经收工，等待其他人结束。</strong><span className="jm-planbar-stats">{stats}</span></div></div>;
  }

  const inCamp = me.status === "camp";
  const acceptName = me.acceptFrom ? game.players.find((player) => player.id === me.acceptFrom)?.name : undefined;
  const plan = (next: Plan) => onCommand({ type: "plan", plan: next });
  return (
    <div className="jm-planbar">
      <div className="jm-planbar-text">
        <span className="jm-plan-label">本回合</span>
        <strong title="没确认的话，时间到也按这个结算">{me.plan ? describePlan(game, me.plan, me) : inCamp ? "还没选（默认留守）" : "还没选（默认待命）"}</strong>
        <span className="jm-planbar-stats">{inCamp ? `营地 · ${stats}` : stats}</span>
        {acceptName && (
          <span className="jm-accept-chip">
            接收 {acceptName} 的交接
            <button type="button" disabled={busy} onClick={() => onCommand({ type: "accept", from: null })} aria-label="不再接收">×</button>
          </span>
        )}
      </div>
      <div className="jm-planbar-actions">
        {inCamp && !me.confirmed && (
          retireArmed ? (
            <span className="jm-retire-confirm">
              收工后不能再下井，确定？
              <button type="button" className="jm-chip-button danger" disabled={busy} onClick={() => { setRetireArmed(false); plan({ kind: "retire" }); }}>确定收工</button>
              <button type="button" className="quiet-button" onClick={() => setRetireArmed(false)}>算了</button>
            </span>
          ) : (
            <>
              <button type="button" className={me.plan?.kind === "stay" ? "jm-chip-button active" : "jm-chip-button"} disabled={busy} onClick={() => plan({ kind: "stay" })}>留守</button>
              <button type="button" className={me.plan?.kind === "retire" ? "jm-chip-button active" : "jm-chip-button"} disabled={busy} onClick={() => setRetireArmed(true)}>收工…</button>
            </>
          )
        )}
        {me.confirmed ? confirmed : (
          <button className="primary-button jm-confirm" type="button" disabled={busy} onClick={() => onCommand({ type: "confirm" })}>确认行动</button>
        )}
      </div>
    </div>
  );
}

// ---------- 浮动面板 ----------

function FloatingPanel({ title, onClose, hidden, className, children }: {
  title: string;
  onClose: () => void;
  hidden?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `jm-float ${className}` : "jm-float"} role="dialog" aria-label={title} hidden={hidden}>
      <header className="jm-float-head">
        <strong>{title}</strong>
        <button type="button" onClick={onClose} aria-label={`关闭${title}`}>×</button>
      </header>
      <div className="jm-float-body">{children}</div>
    </section>
  );
}

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

function BagPanel({ game, me, busy, onCommand }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void }) {
  const score = scoreBreakdown(game, me);
  const vault = vaultGems(game, me.id);
  const inCamp = game.phase === "play" && me.status === "camp";
  const canDiscard = game.phase === "setup" || inCamp;
  const locked = busy || me.confirmed;
  return (
    <>
      <p className="jm-hint">
        <span className="jm-dot jm-dot-inline" style={{ background: SEAT_COLORS[me.seat % SEAT_COLORS.length] }} />
        {locationLabel(me)}{me.status === "mine" ? ` · 移动力 ${movePoints(game, me)}` : ""} · 金币 {me.gold} · 工具也占格子，背包越满走得越慢
      </p>
      <BagSlots game={game} player={me} />
      {(me.bag.length > 0 || (canDiscard && me.tools.length > 0)) && (
        <ul className="jm-bag-list">
          {me.bag.map((id) => {
            const gem = game.gems[id]!;
            const trait = GEM_DEFS[gem.kind].trait;
            return (
              <li key={id} className={`jm-c-${gem.color}`}>
                <i className="jm-gem-chip">{gem.value}</i>
                <span className="jm-bag-name">{gemLabel(gem)}{trait !== "none" ? <small>{TRAIT_NAMES[trait]}</small> : null}</span>
                {inCamp && (
                  <>
                    <button type="button" disabled={locked} onClick={() => onCommand({ type: "deposit", gemId: id })}>存入</button>
                    <button type="button" disabled={locked} onClick={() => onCommand({ type: "sell", gemId: id })}>卖 {gem.value} 金</button>
                  </>
                )}
              </li>
            );
          })}
          {canDiscard && me.tools.map((tool) => (
            <li key={tool.id}>
              <i className="jm-tool-chip">{TOOL_DEFS[tool.kind].name.slice(0, 1)}</i>
              <span className="jm-bag-name">{TOOL_DEFS[tool.kind].name}<small>{tool.durability === null ? "不损耗" : `耐久 ${tool.durability}`}</small></span>
              <button type="button" disabled={locked} onClick={() => onCommand({ type: "discardTool", toolId: tool.id })}>丢弃</button>
            </li>
          ))}
        </ul>
      )}
      <p className="jm-hint">
        {inCamp
          ? "存入的宝石计分并锁定价值；卖出换金币但不计分。"
          : me.bag.length > 0
            ? "宝石要带回营地才能存入或卖出。捡起、切割、交接：在地图上点你所在的格子。"
            : "背包里还没有宝石。挖宝石：在地图上点你旁边的宝石格。"}
      </p>
      <div className="jm-score-line">
        总分 <strong>{score.total}</strong>
        <span>存入 {score.vault} · 碎裂 {score.shatter} · 公共 {score.publicOrders} · 私人 {score.privateOrders ?? 0}</span>
      </div>
      {vault.length > 0 && (
        <div className="jm-vault">
          营地里：{vault.map((gem) => <i key={gem.id} className={`jm-gem-chip jm-c-${gem.color}`} title={`${gemLabel(gem)} ${gem.value}`}>{gem.value}</i>)}
        </div>
      )}
    </>
  );
}

function StorePanel({ game, me, busy, onCommand }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void }) {
  const canShop = game.phase === "setup" || (game.phase === "play" && me.status === "camp");
  const free = freeSlots(game, me);
  const locked = busy || me.confirmed || !canShop;
  return (
    <>
      <p className="jm-hint">
        {!canShop
          ? "只有在营地（或开局准备时）才能买工具，现在可以先看看。"
          : me.confirmed
            ? "你已经确认了，撤回后才能再买。"
            : `金币 ${me.gold} · 背包空 ${free} 格。工具也占背包格子。`}
      </p>
      <div className="jm-shop-grid">
        {TOOL_KINDS.map((kind) => {
          const def = TOOL_DEFS[kind];
          return (
            <button
              key={kind}
              type="button"
              className="jm-shop-item"
              disabled={locked || free < 1 || me.gold < def.price}
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
    </>
  );
}

function ContractPanel({ game }: { game: GameState }) {
  const worked = Object.values(game.gems).filter((gem) => gem.location.type === "wall" && Object.keys(gem.contributions).length > 0);
  const name = (id: string) => game.players.find((player) => player.id === id)?.name ?? "?";
  return (
    <>
      <p className="jm-contract-note">契约系统还在设计中，会在之后的版本加入。</p>
      <p className="jm-hint">
        现在的规则：一颗宝石只要两人以上出过力，出土时就会碎裂，按出力比例分得价值的 {Math.round(PARAMS.shatterShare * 100)}% 直接计分。
        共鸣晶必须两人合挖，所以目前只能拿碎裂分；需要金色宝石的订单这一版先不发。
      </p>
      <div className="jm-panel-title">正在开采的宝石</div>
      {worked.length === 0 ? (
        <p className="jm-hint">还没有人开始挖。</p>
      ) : (
        <ul className="jm-contract-list">
          {worked.map((gem) => {
            const contributors = Object.entries(gem.contributions);
            const location = gem.location as { cell: CellKey };
            return (
              <li key={gem.id}>
                <span className={`jm-gem-chip jm-c-${gem.color}`}>{gem.value}</span>
                <div>
                  <strong>{gemLabel(gem)}</strong>
                  <small>{LAYER_DEFS[parseCell(location.cell).layer].name} · 进度 {gem.progress}/{gem.hardness} · {contributors.map(([id, amount]) => `${name(id)} ${amount}`).join("，")}</small>
                </div>
                <span className={contributors.length > 1 ? "jm-tag jm-tag-off" : "jm-tag"}>{contributors.length > 1 ? "会碎裂" : "单人"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
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

function OrdersPanel({ game, me, busy, onCommand }: { game: GameState; me: PlayerState; busy: boolean; onCommand: (command: GameCommand) => void }) {
  const vault = vaultGems(game, me.id);
  return (
    <>
      {me.orderChoices.length > 0 && (
        <section>
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
        </section>
      )}
      {me.privateOrders.length > 0 && (
        <section>
          <div className="jm-panel-title">我的私人订单 <span>别人看不到，结束时按营地里的宝石结算</span></div>
          <ul className="jm-orders">
            {me.privateOrders.map((order) => <OrderLine key={order.id} order={order} gems={vault} />)}
          </ul>
        </section>
      )}
      <section>
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
    </>
  );
}

function TeamsPanel({ game, room, myId }: { game: GameState; room: LobbyRoomSnapshot; myId: string }) {
  const others = game.players.filter((player) => player.id !== myId);
  return (
    <>
      <p className="jm-hint">工具和背包都是公开的；私人订单只显示张数。</p>
      <div className="jm-rivals">
        {others.map((player) => {
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
    </>
  );
}

function LogPanel({ game }: { game: GameState }) {
  const entries = [...game.log].reverse();
  return (
    <div className="jm-log-list">
      {entries.length === 0 && <p className="jm-hint">每回合结算后，发生的事会出现在这里。</p>}
      {entries.map((entry) => (
        <div key={entry.turn} className="jm-log-turn">
          <strong>{entry.turn === 0 ? "开局" : `第 ${entry.turn} 回合`}</strong>
          {entry.events.length === 0 ? <p>大家都在待命。</p> : entry.events.map((event, index) => <p key={index}>{event}</p>)}
        </div>
      ))}
    </div>
  );
}

// ---------- 结算 ----------

function Results({ game, room, myId, spectating, onRematch, onLeave }: {
  game: GameState;
  room: LobbyRoomSnapshot;
  myId: string;
  spectating: boolean;
  onRematch: (accept: boolean) => void;
  onLeave: () => void;
}) {
  const ranked = [...game.players]
    .map((player) => ({ player, score: scoreBreakdown(game, player) }))
    .sort((a, b) => b.score.total - a.score.total);
  const accepted = room.rematch?.acceptedIds.includes(socket.id ?? "") ?? false;
  const rematchSeconds = useCountdown(room.rematch?.remainingMs, room);
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
        {spectating ? (
          <div className="jm-rematch">
            <span>{room.rematch ? `等玩家决定要不要再来一局（${room.rematch.acceptedIds.length}/${room.members.length} 人同意）` : "对局结束"}</span>
            <div className="gm-panel-actions">
              <button className="quiet-button" type="button" onClick={onLeave}>离开观战</button>
            </div>
          </div>
        ) : room.rematch && (
          <div className="jm-rematch">
            <span>再来一局？还剩 {rematchSeconds ?? 0} 秒（{room.rematch.acceptedIds.length}/{room.members.length} 人同意）</span>
            <button className="primary-button" type="button" disabled={accepted} onClick={() => onRematch(true)}>{accepted ? "等待其他人" : "再来一局"}</button>
            <button className="quiet-button" type="button" onClick={() => onRematch(false)}>离开</button>
          </div>
        )}
      </section>
    </div>
  );
}

export default GameBoard;
