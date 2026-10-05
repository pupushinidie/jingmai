import { useMemo } from "react";
import {
  GEM_DEFS,
  LAYER_DEFS,
  centerCell,
  hexToPixel,
  layerCells,
  parseCell,
  wellCells,
  type CellKey,
  type GameState,
  type Gem,
  type LayerIndex,
} from "@jingmai/game";

export const SEAT_COLORS = ["#2f6f8f", "#b5653a", "#5b7f3a", "#8a4f8f"];

const HEX_SIZE = 10;

function hexPoints(cx: number, cy: number, size: number): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 30);
    return `${(cx + size * Math.cos(angle)).toFixed(2)},${(cy + size * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");
}

export interface MapHighlights {
  /** 可以走到的格子及代价。 */
  readonly reachable?: Map<CellKey, number>;
  /** 可以挖的宝石格。 */
  readonly diggable?: Set<CellKey>;
  /** 已规划的路径（含起点）。 */
  readonly path?: CellKey[];
  /** 已规划要挖的宝石格。 */
  readonly digTarget?: CellKey;
  readonly selected?: CellKey;
}

interface MineMapProps {
  readonly game: GameState;
  readonly layer: LayerIndex;
  readonly myId: string;
  readonly highlights: MapHighlights;
  readonly onCellClick: (cell: CellKey) => void;
}

function MineMap({ game, layer, myId, highlights, onCellClick }: MineMapProps) {
  const radius = LAYER_DEFS[layer].radius;
  const collapsed = game.collapsedLayers.includes(layer);
  const cells = useMemo(() => layerCells(layer), [layer]);
  const wells = useMemo(() => wellCells(), []);

  const gemsByCell = useMemo(() => {
    const wall = new Map<CellKey, Gem>();
    const ground = new Map<CellKey, Gem[]>();
    for (const gem of Object.values(game.gems)) {
      if (gem.location.type === "wall") wall.set(gem.location.cell, gem);
      if (gem.location.type === "ground") ground.set(gem.location.cell, [...(ground.get(gem.location.cell) ?? []), gem]);
    }
    return { wall, ground };
  }, [game.gems]);

  const playersByCell = useMemo(() => {
    const map = new Map<CellKey, typeof game.players>();
    for (const player of game.players) {
      if (player.status !== "mine" || !player.cell) continue;
      map.set(player.cell, [...(map.get(player.cell) ?? []), player]);
    }
    return map;
  }, [game.players]);

  const links = game.links.filter((link) => link.upper === layer || link.upper + 1 === layer);
  const pos = (cell: CellKey) => {
    const p = hexToPixel(parseCell(cell));
    return { x: p.x * HEX_SIZE, y: p.y * HEX_SIZE };
  };

  const extent = (Math.sqrt(3) * radius + 1.2) * HEX_SIZE;
  const viewBox = `${-extent} ${-extent} ${extent * 2} ${extent * 2}`;
  const elevatorHere = game.elevator.layer === layer;
  const pathOnLayer = (highlights.path ?? []).filter((cell) => parseCell(cell).layer === layer);

  return (
    <svg className={collapsed ? "jm-map jm-map-collapsed" : "jm-map"} viewBox={viewBox} role="img" aria-label={`${LAYER_DEFS[layer].name}地图`}>
      {cells.map((cell) => {
        const { x, y } = pos(cell);
        const wall = gemsByCell.wall.get(cell);
        const reach = highlights.reachable?.get(cell);
        const classes = ["jm-cell"];
        if (wall) classes.push("jm-cell-wall", `jm-c-${wall.color}`);
        if (reach !== undefined && reach > 0) classes.push("jm-cell-reach");
        if (highlights.diggable?.has(cell)) classes.push("jm-cell-dig");
        if (highlights.digTarget === cell) classes.push("jm-cell-dig-target");
        if (highlights.selected === cell) classes.push("jm-cell-selected");
        if (cell === centerCell(layer)) classes.push("jm-cell-center");
        return (
          <g key={cell} className={classes.join(" ")} onClick={() => onCellClick(cell)}>
            <polygon points={hexPoints(x, y, HEX_SIZE * 0.96)} />
            {wall && <GemMark gem={wall} x={x} y={y} />}
          </g>
        );
      })}

      {/* 井口 */}
      {layer === 0 && wells.map((cell, index) => {
        const { x, y } = pos(cell);
        return (
          <g key={cell} className="jm-well" pointerEvents="none">
            <polygon points={hexPoints(x, y, HEX_SIZE * 0.78)} />
            <text x={x} y={y + 3}>井{index + 1}</text>
          </g>
        );
      })}

      {/* 电梯 */}
      <g className={elevatorHere ? "jm-elevator jm-elevator-here" : "jm-elevator"} pointerEvents="none">
        <rect x={-HEX_SIZE * 0.55} y={-HEX_SIZE * 0.55} width={HEX_SIZE * 1.1} height={HEX_SIZE * 1.1} rx={2} />
        <text x={0} y={3.2}>梯</text>
      </g>

      {/* 梯子与洞口 */}
      {links.map((link) => {
        const cell = `${layer}:${link.q}:${link.r}`;
        const { x, y } = pos(cell);
        const upperSide = link.upper === layer;
        const label = link.kind === "ladder" ? (upperSide ? "梯↓" : "梯↑") : upperSide ? "洞↓" : "落点";
        return (
          <g key={`${link.kind}-${cell}`} className={`jm-link jm-link-${link.kind}`} pointerEvents="none">
            <circle cx={x} cy={y} r={HEX_SIZE * 0.62} />
            <text x={x} y={y + 2.8}>{label}</text>
          </g>
        );
      })}

      {/* 地上的宝石 */}
      {[...gemsByCell.ground].filter(([cell]) => parseCell(cell).layer === layer).map(([cell, gems]) => {
        const { x, y } = pos(cell);
        return (
          <g key={`ground-${cell}`} pointerEvents="none">
            {gems.map((gem, index) => (
              <rect
                key={gem.id}
                className={`jm-ground-gem jm-c-${gem.color}`}
                x={x - 3 + index * 3.5}
                y={y + 1.5}
                width={4.2}
                height={4.2}
                transform={`rotate(45 ${x - 0.9 + index * 3.5} ${y + 3.6})`}
              />
            ))}
          </g>
        );
      })}

      {/* 规划路径 */}
      {pathOnLayer.length > 1 && (
        <polyline
          className="jm-path"
          points={pathOnLayer.map((cell) => { const p = pos(cell); return `${p.x},${p.y}`; }).join(" ")}
          pointerEvents="none"
        />
      )}
      {pathOnLayer.length > 0 && highlights.path && highlights.path.length > 1 && (() => {
        const last = highlights.path[highlights.path.length - 1]!;
        if (parseCell(last).layer !== layer) return null;
        const { x, y } = pos(last);
        return <circle className="jm-path-end" cx={x} cy={y} r={HEX_SIZE * 0.5} pointerEvents="none" />;
      })()}

      {/* 可达格的移动代价 */}
      {highlights.reachable && [...highlights.reachable].filter(([cell, cost]) => cost > 0 && parseCell(cell).layer === layer).map(([cell, cost]) => {
        const { x, y } = pos(cell);
        return <text key={`cost-${cell}`} className="jm-cost" x={x + HEX_SIZE * 0.42} y={y - HEX_SIZE * 0.32} pointerEvents="none">{cost}</text>;
      })}

      {/* 玩家 */}
      {[...playersByCell].filter(([cell]) => parseCell(cell).layer === layer).map(([cell, players]) => {
        const { x, y } = pos(cell);
        return players.map((player, index) => {
          const offset = players.length === 1 ? 0 : (index - (players.length - 1) / 2) * 5.2;
          return (
            <g key={player.id} className={player.id === myId ? "jm-pawn jm-pawn-me" : "jm-pawn"} pointerEvents="none">
              <circle cx={x + offset} cy={y - 1} r={4.4} fill={SEAT_COLORS[player.seat % SEAT_COLORS.length]} />
              <text x={x + offset} y={y + 1.6}>{player.name.slice(0, 1)}</text>
            </g>
          );
        });
      })}

      {collapsed && <text className="jm-collapsed-label" x={0} y={0}>已塌方</text>}
    </svg>
  );
}

function GemMark({ gem, x, y }: { gem: Gem; x: number; y: number }) {
  const def = GEM_DEFS[gem.kind];
  return (
    <g pointerEvents="none">
      <text className="jm-gem-name" x={x} y={y - 1}>{def.name.slice(0, 2)}</text>
      <text className="jm-gem-value" x={x} y={y + 5.6}>
        {gem.value}{gem.progress > 0 ? ` · ${gem.progress}/${gem.hardness}` : ""}
      </text>
    </g>
  );
}

export default MineMap;
