import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LAYER_DEFS, parseCell, type CellKey, type GameState, type LayerIndex } from "@jingmai/game";
import { DRAG_THRESHOLD, clamp, distance, midpoint, useTween, useWheel, wheelZoomFactor } from "./gestures.js";
import { cellPoint, mapExtent, type Point } from "./mapGeometry.js";
import MineMap, { type MapHighlights, type MapView } from "./MineMap.js";

/**
 * 平面视图：一次看一层，可缩放、平移。
 * 鼠标滚轮 / 触控板捏合 / 双指捏合缩放；放大后拖动平移。拖动不会被当成点格子。
 */
interface FlatMapProps {
  readonly game: GameState;
  readonly layer: LayerIndex;
  readonly myId: string;
  readonly highlights: MapHighlights;
  readonly onCellClick: (cell: CellKey, point: Point) => void;
  readonly onSelectLayer: (layer: LayerIndex) => void;
  /** 我在矿洞里时所在的格子，用于「定位到我」。 */
  readonly myCell: CellKey | undefined;
}

const FIT: MapView = { cx: 0, cy: 0, zoom: 1 };
const ZOOM_STEP = 1.5;
const LOCATE_ZOOM = 2.4;

/** 越大的层允许放得越大：浅脉约 4.8 倍，晶心 2 倍。 */
function maxZoomFor(layer: LayerIndex): number {
  return Math.max(2, LAYER_DEFS[layer].radius * 0.6);
}

type Gesture =
  | { kind: "pan"; start: Point; view: MapView; moved: boolean }
  | { kind: "pinch"; startDistance: number; anchor: Point; view: MapView };

function FlatMap({ game, layer, myId, highlights, onCellClick, onSelectLayer, myCell }: FlatMapProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<MapView>(FIT);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  /** 「定位到我」要先切到我所在的层，切过去以后再居中。 */
  const pendingCenter = useRef<CellKey | null>(null);
  const tween = useTween<{ cx: number; cy: number; zoom: number }>((value) => setView(value));

  const extent = mapExtent(LAYER_DEFS[layer].radius);
  const maxZoom = maxZoomFor(layer);

  // 平移范围：刚放大时很小（不会把地图拖跑），放大到两倍以上时视图中心可以到达地图边缘，
  // 所以边上的格子（比如井口）也能居中。
  const limit = (next: MapView): MapView => {
    const zoom = clamp(next.zoom, 1, maxZoom);
    const room = extent * Math.min(1 - 0.5 / zoom, 2 * (1 - 1 / zoom));
    return { zoom, cx: clamp(next.cx, -room, room), cy: clamp(next.cy, -room, room) };
  };

  /** 屏幕像素与 SVG 坐标的换算：k 为缩放 1 倍时每像素对应的 SVG 单位。 */
  const geometry = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return { k: (2 * extent) / Math.min(rect.width, rect.height), center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  };

  const animateTo = (target: MapView) => tween.start({ ...view }, { ...limit(target) });

  // 换层时回到整层视图；如果是「定位到我」触发的换层，就直接居中到我。
  useEffect(() => {
    const pending = pendingCenter.current;
    tween.cancel();
    if (pending && parseCell(pending).layer === layer) {
      pendingCenter.current = null;
      const p = cellPoint(pending);
      setView(limit({ cx: p.x, cy: p.y, zoom: LOCATE_ZOOM }));
    } else {
      setView(FIT);
    }
  }, [layer]);

  function locateMe() {
    if (!myCell) return;
    const myLayer = parseCell(myCell).layer;
    if (myLayer !== layer) {
      pendingCenter.current = myCell;
      onSelectLayer(myLayer);
      return;
    }
    const p = cellPoint(myCell);
    animateTo({ cx: p.x, cy: p.y, zoom: Math.max(view.zoom, LOCATE_ZOOM) });
  }

  useWheel(frameRef, (event) => {
    event.preventDefault();
    tween.cancel();
    const geo = geometry();
    if (!geo) return;
    setView((current) => {
      const dx = event.clientX - geo.center.x;
      const dy = event.clientY - geo.center.y;
      // 缩放前后，光标下的那一点保持不动。
      const px = current.cx + (dx * geo.k) / current.zoom;
      const py = current.cy + (dy * geo.k) / current.zoom;
      const zoom = clamp(current.zoom * wheelZoomFactor(event), 1, maxZoom);
      return limit({ zoom, cx: px - (dx * geo.k) / zoom, cy: py - (dy * geo.k) / zoom });
    });
  });

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest(".jm-map-controls")) return;
    tween.cancel();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      suppressClick.current = false;
      gesture.current = { kind: "pan", start: { x: event.clientX, y: event.clientY }, view, moved: false };
    } else if (pointers.current.size === 2) {
      const geo = geometry();
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      if (!geo) return;
      const mid = midpoint(a, b);
      gesture.current = {
        kind: "pinch",
        startDistance: Math.max(1, distance(a, b)),
        // 双指中点下的地图坐标，捏合过程中让它始终跟着中点走。
        anchor: { x: view.cx + ((mid.x - geo.center.x) * geo.k) / view.zoom, y: view.cy + ((mid.y - geo.center.y) * geo.k) / view.zoom },
        view,
      };
      for (const id of pointers.current.keys()) frameRef.current?.setPointerCapture(id);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture.current;
    const geo = geometry();
    if (!current || !geo) return;
    if (current.kind === "pan") {
      const dx = event.clientX - current.start.x;
      const dy = event.clientY - current.start.y;
      if (!current.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        current.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (current.view.zoom <= 1) return;
      setView(limit({ zoom: current.view.zoom, cx: current.view.cx - (dx * geo.k) / current.view.zoom, cy: current.view.cy - (dy * geo.k) / current.view.zoom }));
      return;
    }
    const [a, b] = [...pointers.current.values()] as [Point, Point];
    const mid = midpoint(a, b);
    const zoom = clamp((current.view.zoom * distance(a, b)) / current.startDistance, 1, maxZoom);
    setView(limit({ zoom, cx: current.anchor.x - ((mid.x - geo.center.x) * geo.k) / zoom, cy: current.anchor.y - ((mid.y - geo.center.y) * geo.k) / zoom }));
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current;
    if (current && (current.kind === "pinch" || current.moved)) suppressClick.current = true;
    // 捏合时先抬起一根手指，剩下那根不接着平移，等全部抬起再开始新手势。
    if (pointers.current.size === 0 || current?.kind === "pinch") gesture.current = null;
  }

  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest(".jm-map-controls")) return;
    if (suppressClick.current) {
      event.stopPropagation();
      suppressClick.current = false;
    }
  }

  const zoomed = view.zoom > 1.001;
  return (
    <div
      ref={frameRef}
      className={zoomed ? "jm-flat-frame zoomed" : "jm-flat-frame"}
      // 地图占满整屏，页面本身不滚动，触摸手势全部交给地图。
      style={{ touchAction: "none" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClickCapture={handleClickCapture}
    >
      <MineMap game={game} layer={layer} myId={myId} highlights={highlights} onCellClick={onCellClick} view={view} svgRef={svgRef} />
      <div className="jm-map-controls">
        <button type="button" aria-label="放大" disabled={view.zoom >= maxZoom - 0.001} onClick={() => animateTo({ ...view, zoom: view.zoom * ZOOM_STEP })}>＋</button>
        <button type="button" aria-label="缩小" disabled={!zoomed} onClick={() => animateTo({ ...view, zoom: view.zoom / ZOOM_STEP })}>−</button>
        <span className="jm-zoom-level">{Math.round(view.zoom * 100)}%</span>
        <button type="button" disabled={!zoomed} onClick={() => animateTo(FIT)}>适应</button>
        {myCell && <button type="button" onClick={locateMe} title="放大并居中到我所在的格子">◎ 我</button>}
      </div>
      <span className="jm-map-hint">滚轮或双指缩放{zoomed ? " · 拖动平移" : ""}</span>
    </div>
  );
}

export default FlatMap;
