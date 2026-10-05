import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LAYER_DEFS, hexToPixel, type CellKey, type GameState, type LayerIndex } from "@jingmai/game";
import MineMap, { HEX_SIZE, mapExtent, type MapHighlights } from "./MineMap.js";

/**
 * 立体视图：三张平面地图按同一比例上下叠放（CSS 3D），中心对齐。
 * 选中的层不透明、可点击；其他层半透明、点不中。
 * 电梯井、梯子、洞口画成连接上下层的竖柱。
 */
interface Mine3DProps {
  readonly game: GameState;
  readonly activeLayer: LayerIndex;
  readonly myId: string;
  readonly highlights: MapHighlights;
  readonly onCellClick: (cell: CellKey) => void;
}

const LAYERS: LayerIndex[] = [0, 1, 2];
const TOP_RADIUS = LAYER_DEFS[0].radius;
/**
 * 层间距占地图边长的比例。要大到在默认倾角下三层在屏幕上错开，
 * 否则最上面最大的浅脉会把下面两层挡住。
 */
const GAP_RATIO = 0.38;
const DEFAULT_VIEW = { spin: -18, tilt: 64 };
const TILT_RANGE = [20, 80] as const;
/** 拖动超过这么多像素就算旋转，不再当作点击。 */
const DRAG_THRESHOLD = 4;

function Mine3D({ game, activeLayer, myId, highlights, onCellClick }: Mine3DProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [view, setView] = useState(DEFAULT_VIEW);
  const drag = useRef<{ x: number; y: number; spin: number; tilt: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setFrame({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 倾斜后整体的可见高度 ≈ 边长 × (cos 倾角 + 两个层距 × sin 倾角)，按它把场景缩放到放得下。
  const tiltRad = (view.tilt * Math.PI) / 180;
  const heightFactor = Math.cos(tiltRad) + 2 * GAP_RATIO * Math.sin(tiltRad);
  const size = Math.max(160, Math.min(frame.width * 0.94, (frame.height * 0.9) / heightFactor));
  const gap = size * GAP_RATIO;
  const z = (layer: LayerIndex) => (1 - layer) * gap;
  const unit = size / (2 * mapExtent(TOP_RADIUS));
  const toScene = (q: number, r: number) => {
    const p = hexToPixel({ q, r });
    return { x: size / 2 + p.x * HEX_SIZE * unit, y: size / 2 + p.y * HEX_SIZE * unit };
  };

  const pillars = [
    { key: "elevator", kind: "elevator", q: 0, r: 0, lower: 2 as LayerIndex, upper: 0 as LayerIndex },
    ...game.links.map((link) => ({
      key: `${link.kind}-${link.upper}-${link.q}-${link.r}`,
      kind: link.kind,
      q: link.q,
      r: link.r,
      lower: (link.upper + 1) as LayerIndex,
      upper: link.upper as LayerIndex,
    })),
  ];

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, spin: view.spin, tilt: view.tilt, moved: false };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!start.moved) {
      start.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setView({
      spin: start.spin + dx * 0.4,
      tilt: Math.min(TILT_RANGE[1], Math.max(TILT_RANGE[0], start.tilt - dy * 0.3)),
    });
  }

  function handlePointerUp() {
    suppressClick.current = drag.current?.moved ?? false;
    drag.current = null;
  }

  return (
    <div
      className="jm-3d-frame"
      ref={frameRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { drag.current = null; }}
      onClickCapture={(event) => {
        // 拖动结束时浏览器还会补发一次 click，不能让它变成"走到这一格"。
        if (suppressClick.current) {
          event.stopPropagation();
          suppressClick.current = false;
        }
      }}
    >
      <div
        className="jm-3d-scene"
        style={{ width: size, height: size, transform: `rotateX(${view.tilt}deg) rotateZ(${view.spin}deg)` }}
      >
        {LAYERS.map((layer) => (
          <div
            key={layer}
            className={layer === activeLayer ? "jm-3d-layer active" : "jm-3d-layer"}
            style={{ transform: `translateZ(${z(layer)}px)` }}
          >
            <MineMap game={game} layer={layer} myId={myId} highlights={highlights} onCellClick={onCellClick} extentRadius={TOP_RADIUS} />
          </div>
        ))}
        {pillars.map((pillar) => {
          const { x, y } = toScene(pillar.q, pillar.r);
          const height = z(pillar.upper) - z(pillar.lower);
          // 两片交叉的竖片，转到任何角度都看得见。
          return [0, 90].map((turn) => (
            <div
              key={`${pillar.key}-${turn}`}
              className={`jm-pillar jm-pillar-${pillar.kind}`}
              style={{
                left: x,
                top: y - height,
                height,
                transform: `translateZ(${z(pillar.lower)}px) rotateZ(${turn}deg) rotateX(-90deg)`,
              }}
            />
          ));
        })}
      </div>
      <div className="jm-3d-controls">
        <span>拖动可旋转、调整倾斜</span>
        <button type="button" className="quiet-button" onClick={() => setView(DEFAULT_VIEW)}>复位视角</button>
      </div>
    </div>
  );
}

export default Mine3D;
