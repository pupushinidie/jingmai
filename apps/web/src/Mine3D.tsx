import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LAYER_DEFS, cellKey, hexToPixel, parseCell, type CellKey, type GameState, type LayerIndex } from "@jingmai/game";
import { DRAG_THRESHOLD, clamp, distance, midpoint, useElementSize, useTween, useWheel, wheelZoomFactor } from "./gestures.js";
import {
  GAP_RATIO,
  HEX_SIZE,
  STACK_RADIUS,
  cellPoint,
  hitTestStack,
  mapExtent,
  projectToScreen,
  stackGeometry,
  type Point,
} from "./mapGeometry.js";
import MineMap, { type MapHighlights } from "./MineMap.js";

/**
 * 立体视图：三张平面地图按同一比例上下叠放（CSS 3D），中心对齐。
 *
 * 点击不交给浏览器判定：3D 里浏览器把点击给"最靠前"的那一层，选中晶心时点它的格子
 * 会被前面的浅脉截走。这里自己从点击位置投一条射线，算出它穿过每层的哪一格
 * （mapGeometry.ts）：落在选中层上就是点那一格；否则选中最靠前的那一层。
 */
interface Mine3DProps {
  readonly game: GameState;
  readonly activeLayer: LayerIndex;
  readonly myId: string;
  readonly highlights: MapHighlights;
  readonly onCellClick: (cell: CellKey, point: Point) => void;
  readonly onSelectLayer: (layer: LayerIndex) => void;
  readonly myCell: CellKey | undefined;
}

const LAYERS: LayerIndex[] = [0, 1, 2];
const EXTENT = mapExtent(STACK_RADIUS);
const DEFAULT_VIEW: View3D = { spin: -18, tilt: 64, zoom: 1, panX: 0, panY: 0 };
const TILT_RANGE = [20, 80] as const;
const ZOOM_RANGE = [0.6, 4] as const;
const ZOOM_STEP = 1.5;
const LOCATE_ZOOM = 2.2;
const noop = () => {};

interface View3D {
  spin: number;
  tilt: number;
  zoom: number;
  panX: number;
  panY: number;
}

type Gesture =
  | { kind: "rotate" | "pan"; start: Point; view: View3D; moved: boolean; button: number }
  | { kind: "pinch"; startDistance: number; anchor: Point; view: View3D };

function Mine3D({ game, activeLayer, myId, highlights, onCellClick, onSelectLayer, myCell }: Mine3DProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const frame = useElementSize(frameRef);
  const [view, setView] = useState<View3D>(DEFAULT_VIEW);
  const [hover, setHover] = useState<{ layer: LayerIndex; cell?: CellKey } | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const pendingCenter = useRef<CellKey | null>(null);
  const tween = useTween<{ spin: number; tilt: number; zoom: number; panX: number; panY: number }>((value) => setView(value));

  // 按默认倾角定 1 倍大小，拖动倾角时整体不会忽大忽小。
  const defaultTilt = (DEFAULT_VIEW.tilt * Math.PI) / 180;
  const heightFactor = Math.cos(defaultTilt) + 2 * GAP_RATIO * Math.sin(defaultTilt);
  const baseSize = Math.max(160, Math.min(frame.width * 0.94, (frame.height * 0.9) / heightFactor));
  const g = stackGeometry(baseSize, view);

  const limitPan = (value: number, extent: number, zoom: number) => {
    const room = baseSize * zoom * 0.7 + extent * 0.25;
    return clamp(value, -room, room);
  };
  const limit = (next: View3D): View3D => {
    const zoom = clamp(next.zoom, ZOOM_RANGE[0], ZOOM_RANGE[1]);
    return {
      spin: next.spin,
      tilt: clamp(next.tilt, TILT_RANGE[0], TILT_RANGE[1]),
      zoom,
      panX: limitPan(next.panX, frame.width, zoom),
      panY: limitPan(next.panY, frame.height, zoom),
    };
  };
  const animateTo = (target: View3D) => tween.start({ ...view }, { ...limit(target) });

  /** 视图中心在屏幕上的位置。 */
  const frameCenter = (): Point | null => {
    const rect = frameRef.current?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  };

  const hitsAt = (clientX: number, clientY: number) => {
    const center = frameCenter();
    if (!center) return [];
    return hitTestStack(g, (clientX - center.x - view.panX) / view.zoom, (clientY - center.y - view.panY) / view.zoom);
  };

  /** 把某一格移到视图中央。 */
  const centerOn = (cell: CellKey, zoom: number) => {
    const p = cellPoint(cell);
    const s = projectToScreen(g, parseCell(cell).layer, p.x, p.y);
    animateTo({ ...view, zoom, panX: -s.x * zoom, panY: -s.y * zoom });
  };

  // 切换选中层：放大状态下镜头跟过去；「定位到我」触发的切换则居中到我。
  const previousLayer = useRef(activeLayer);
  useEffect(() => {
    if (previousLayer.current === activeLayer) return;
    previousLayer.current = activeLayer;
    const pending = pendingCenter.current;
    if (pending && parseCell(pending).layer === activeLayer) {
      pendingCenter.current = null;
      centerOn(pending, Math.max(view.zoom, LOCATE_ZOOM));
    } else if (view.zoom > 1.05) {
      centerOn(cellKey(activeLayer, 0, 0), view.zoom);
    }
  }, [activeLayer]);

  function locateMe() {
    if (!myCell) return;
    const myLayer = parseCell(myCell).layer;
    if (myLayer !== activeLayer) {
      pendingCenter.current = myCell;
      onSelectLayer(myLayer);
      return;
    }
    centerOn(myCell, Math.max(view.zoom, LOCATE_ZOOM));
  }

  function zoomAroundCenter(factor: number) {
    const zoom = clamp(view.zoom * factor, ZOOM_RANGE[0], ZOOM_RANGE[1]);
    const ratio = zoom / view.zoom;
    animateTo({ ...view, zoom, panX: view.panX * ratio, panY: view.panY * ratio });
  }

  useWheel(frameRef, (event) => {
    event.preventDefault();
    tween.cancel();
    const center = frameCenter();
    if (!center) return;
    setView((current) => {
      const zoom = clamp(current.zoom * wheelZoomFactor(event), ZOOM_RANGE[0], ZOOM_RANGE[1]);
      // 光标下的那一点保持不动。
      const dx = event.clientX - center.x;
      const dy = event.clientY - center.y;
      const ratio = zoom / current.zoom;
      return limit({ ...current, zoom, panX: dx - (dx - current.panX) * ratio, panY: dy - (dy - current.panY) * ratio });
    });
  });

  function updateHover(event: ReactPointerEvent<HTMLDivElement>) {
    const hits = hitsAt(event.clientX, event.clientY);
    const active = hits.find((hit) => hit.layer === activeLayer);
    const next = active ? { layer: activeLayer, cell: active.cell } : hits[0] ? { layer: hits[0].layer } : null;
    if (next?.layer !== hover?.layer || next?.cell !== hover?.cell) setHover(next);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest(".jm-map-controls, .jm-3d-label")) return;
    tween.cancel();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      gesture.current = {
        kind: event.button === 2 || event.shiftKey ? "pan" : "rotate",
        start: { x: event.clientX, y: event.clientY },
        view,
        moved: false,
        button: event.button,
      };
    } else if (pointers.current.size === 2) {
      const center = frameCenter();
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      if (!center) return;
      const mid = midpoint(a, b);
      gesture.current = {
        kind: "pinch",
        startDistance: Math.max(1, distance(a, b)),
        // 双指中点下的场景点（1 倍坐标），捏合过程中让它跟着中点走。
        anchor: { x: (mid.x - center.x - view.panX) / view.zoom, y: (mid.y - center.y - view.panY) / view.zoom },
        view,
      };
      for (const id of pointers.current.keys()) frameRef.current?.setPointerCapture(id);
      setHover(null);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) {
      if (event.pointerType === "mouse") updateHover(event);
      return;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture.current;
    if (!current) return;
    if (current.kind === "pinch") {
      const center = frameCenter();
      if (!center) return;
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const mid = midpoint(a, b);
      const zoom = clamp((current.view.zoom * distance(a, b)) / current.startDistance, ZOOM_RANGE[0], ZOOM_RANGE[1]);
      setView(limit({ ...current.view, zoom, panX: mid.x - center.x - current.anchor.x * zoom, panY: mid.y - center.y - current.anchor.y * zoom }));
      return;
    }
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setHover(null);
    }
    setView(limit(current.kind === "pan"
      ? { ...current.view, panX: current.view.panX + dx, panY: current.view.panY + dy }
      : { ...current.view, spin: current.view.spin + dx * 0.4, tilt: current.view.tilt - dy * 0.3 }));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current;
    if (pointers.current.size === 0 || current?.kind === "pinch") gesture.current = null;
    // 没拖动、单指或左键松开：当作点击。
    if (current && current.kind !== "pinch" && !current.moved && current.button === 0 && pointers.current.size === 0) {
      const hits = hitsAt(event.clientX, event.clientY);
      const active = hits.find((hit) => hit.layer === activeLayer);
      if (active) onCellClick(active.cell, { x: event.clientX, y: event.clientY });
      else if (hits[0]) onSelectLayer(hits[0].layer);
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
  }

  const size = baseSize * view.zoom;
  const gap = size * GAP_RATIO;
  const sceneZ = (layer: LayerIndex) => (1 - layer) * gap;
  const toScene = (q: number, r: number) => {
    const p = hexToPixel({ q, r });
    const unit = size / (2 * EXTENT);
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

  // 层名牌：贴在每层最左边那个角的左侧，用屏幕坐标画，不跟着平面倾斜，始终看得清。
  const labels = LAYERS.map((layer) => {
    const radius = LAYER_DEFS[layer].radius;
    const s = projectToScreen(g, layer, -(Math.sqrt(3) * radius + 1.3) * HEX_SIZE, 0);
    return { layer, left: frame.width / 2 + view.panX + s.x * view.zoom, top: frame.height / 2 + view.panY + s.y * view.zoom };
  });

  const frameClasses = ["jm-3d-frame"];
  if (hover) frameClasses.push("pointing");

  return (
    <div
      className={frameClasses.join(" ")}
      ref={frameRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="jm-3d-panner" style={{ perspective: `${g.perspective * view.zoom}px`, transform: `translate(${view.panX}px, ${view.panY}px)` }}>
        <div
          className="jm-3d-scene"
          style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, transform: `rotateX(${view.tilt}deg) rotateZ(${view.spin}deg)` }}
        >
          {LAYERS.map((layer) => {
            const classes = ["jm-3d-layer"];
            if (layer === activeLayer) classes.push("active");
            else if (hover?.layer === layer) classes.push("preview");
            return (
              <div key={layer} className={classes.join(" ")} style={{ transform: `translateZ(${sceneZ(layer)}px)` }}>
                <MineMap
                  game={game}
                  layer={layer}
                  myId={myId}
                  highlights={highlights}
                  onCellClick={noop}
                  extentRadius={STACK_RADIUS}
                  passive
                  {...(layer === activeLayer && hover?.cell ? { hoveredCell: hover.cell } : {})}
                />
              </div>
            );
          })}
          {pillars.map((pillar) => {
            const { x, y } = toScene(pillar.q, pillar.r);
            const height = sceneZ(pillar.upper) - sceneZ(pillar.lower);
            // 两片交叉的竖片，转到任何角度都看得见。
            return [0, 90].map((turn) => (
              <div
                key={`${pillar.key}-${turn}`}
                className={`jm-pillar jm-pillar-${pillar.kind}`}
                style={{ left: x, top: y - height, height, transform: `translateZ(${sceneZ(pillar.lower)}px) rotateZ(${turn}deg) rotateX(-90deg)` }}
              />
            ));
          })}
        </div>
      </div>

      {labels.map(({ layer, left, top }) => (
        <button
          key={layer}
          type="button"
          className={layer === activeLayer ? "jm-3d-label active" : "jm-3d-label"}
          style={{ left, top }}
          aria-pressed={layer === activeLayer}
          onClick={() => onSelectLayer(layer)}
        >
          {LAYER_DEFS[layer].name}
        </button>
      ))}

      <div className="jm-map-controls">
        <button type="button" aria-label="放大" disabled={view.zoom >= ZOOM_RANGE[1] - 0.001} onClick={() => zoomAroundCenter(ZOOM_STEP)}>＋</button>
        <button type="button" aria-label="缩小" disabled={view.zoom <= ZOOM_RANGE[0] + 0.001} onClick={() => zoomAroundCenter(1 / ZOOM_STEP)}>−</button>
        <span className="jm-zoom-level">{Math.round(view.zoom * 100)}%</span>
        <button type="button" onClick={() => animateTo(DEFAULT_VIEW)}>复位</button>
        {myCell && <button type="button" onClick={locateMe} title="切到我所在的层，放大并居中">◎ 我</button>}
      </div>
      <span className="jm-map-hint">拖动旋转 · 滚轮或双指缩放 · 右键或 Shift 拖动平移 · 点其他层切换</span>
    </div>
  );
}

export default Mine3D;
