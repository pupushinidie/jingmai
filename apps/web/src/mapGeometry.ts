import { LAYER_DEFS, cellKey, hexToPixel, inLayer, parseCell, type CellKey, type LayerIndex } from "@jingmai/game";

/** 地图里六边形的边长（SVG 单位）。 */
export const HEX_SIZE = 10;

/** 地图 viewBox 的半宽（SVG 单位），能容纳半径为 radius 的一层。 */
export function mapExtent(radius: number): number {
  return (Math.sqrt(3) * radius + 1.2) * HEX_SIZE;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 格子中心的 SVG 坐标。 */
export function cellPoint(cell: CellKey): Point {
  const p = hexToPixel(parseCell(cell));
  return { x: p.x * HEX_SIZE, y: p.y * HEX_SIZE };
}

/** 尖顶六边形：像素（以边长为单位）→ 轴向坐标，立方坐标取整。 */
export function pixelToHex(x: number, y: number): { q: number; r: number } {
  const r = y / 1.5;
  const q = x / Math.sqrt(3) - r / 2;
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 };
}

// ---------- 立体视图的投影 ----------

const LAYERS: LayerIndex[] = [0, 1, 2];
/** 立体视图三层共用浅脉的画幅，上下才对得齐。 */
export const STACK_RADIUS = LAYER_DEFS[0].radius;
const STACK_EXTENT = mapExtent(STACK_RADIUS);
/**
 * 层间距占地图边长的比例。要大到在默认倾角下三层在屏幕上错开，
 * 否则最上面最大的浅脉会把下面两层挡住。
 */
export const GAP_RATIO = 0.38;
/** 透视距离占地图边长的比例。 */
export const PERSPECTIVE_RATIO = 5;

export interface StackAngles {
  /** 绕竖轴旋转（度），对应 CSS rotateZ。 */
  readonly spin: number;
  /** 倾角（度），对应 CSS rotateX。 */
  readonly tilt: number;
}

/**
 * 缩放 1 倍时的几何。缩放时场景边长和透视距离一起乘 zoom，等价于屏幕上整体放大，
 * 所以投影只按 1 倍算，再乘 zoom、加平移。
 */
export interface StackGeometry {
  readonly size: number;
  readonly perspective: number;
  readonly gap: number;
  readonly sinT: number;
  readonly cosT: number;
  readonly sinS: number;
  readonly cosS: number;
}

export function stackGeometry(size: number, angles: StackAngles): StackGeometry {
  const tilt = (angles.tilt * Math.PI) / 180;
  const spin = (angles.spin * Math.PI) / 180;
  return {
    size,
    perspective: size * PERSPECTIVE_RATIO,
    gap: size * GAP_RATIO,
    sinT: Math.sin(tilt),
    cosT: Math.cos(tilt),
    sinS: Math.sin(spin),
    cosS: Math.cos(spin),
  };
}

/** 浅脉在最上（z 最大），晶心在最下。 */
export function layerZ(g: StackGeometry, layer: LayerIndex): number {
  return (1 - layer) * g.gap;
}

/**
 * 层上一点（SVG 坐标）投到屏幕，返回相对视图中心的偏移（1 倍、未平移）。
 * 与 CSS 的 perspective + rotateX(倾角) rotateZ(旋转) + translateZ(层高) 一致。
 */
export function projectToScreen(g: StackGeometry, layer: LayerIndex, svgX: number, svgY: number): Point {
  const scale = g.size / (2 * STACK_EXTENT);
  const px = svgX * scale;
  const py = svgY * scale;
  const pz = layerZ(g, layer);
  const x1 = px * g.cosS - py * g.sinS;
  const y1 = px * g.sinS + py * g.cosS;
  const y2 = y1 * g.cosT - pz * g.sinT;
  const z2 = y1 * g.sinT + pz * g.cosT;
  const w = 1 - z2 / g.perspective;
  return { x: x1 / w, y: y2 / w };
}

export interface StackHit {
  readonly layer: LayerIndex;
  readonly cell: CellKey;
  /** 离观察者越近越大。 */
  readonly depth: number;
}

/**
 * 屏幕偏移（1 倍、未平移）反推到每一层：从观察点经过该像素的射线与层平面求交，
 * 再换算成六边形格子。只返回落在该层范围内的结果，按离观察者由近到远排序。
 */
export function hitTestStack(g: StackGeometry, sx: number, sy: number): StackHit[] {
  const hits: StackHit[] = [];
  const scale = (2 * STACK_EXTENT) / g.size;
  for (const layer of LAYERS) {
    const denominator = g.cosT + (sy * g.sinT) / g.perspective;
    if (Math.abs(denominator) < 1e-9) continue;
    const t = (layerZ(g, layer) + sy * g.sinT) / denominator;
    if (t >= g.perspective) continue;
    const f = 1 - t / g.perspective;
    const qx = sx * f;
    const qy = sy * f;
    // 先逆 rotateX，再逆 rotateZ。
    const y1 = qy * g.cosT + t * g.sinT;
    const px = qx * g.cosS + y1 * g.sinS;
    const py = -qx * g.sinS + y1 * g.cosS;
    const hex = pixelToHex((px * scale) / HEX_SIZE, (py * scale) / HEX_SIZE);
    if (inLayer(layer, hex)) hits.push({ layer, cell: cellKey(layer, hex.q, hex.r), depth: t });
  }
  return hits.sort((a, b) => b.depth - a.depth);
}
