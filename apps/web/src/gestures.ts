import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 指针移动超过这么多像素才算拖动；没超过的松手当作点击。 */
export const DRAG_THRESHOLD = 4;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 一次滚轮事件对应的缩放倍数。触控板双指捏合在浏览器里是带 ctrlKey 的滚轮事件，
 * 步长小得多，所以灵敏度单独给。
 */
export function wheelZoomFactor(event: WheelEvent): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const sensitivity = event.ctrlKey ? 0.01 : 0.0015;
  return Math.exp(-event.deltaY * unit * sensitivity);
}

/** 绑定能 preventDefault 的滚轮监听：React 的 onWheel 是被动监听，拦不住页面滚动和浏览器缩放。 */
export function useWheel(ref: RefObject<HTMLElement | null>, handler: (event: WheelEvent) => void): void {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: WheelEvent) => latest.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [ref]);
}

export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * 用 requestAnimationFrame 把一组数值平滑过渡到目标值。
 * 用户一开始拖动或滚轮就应 cancel，免得动画和手势打架。
 */
export function useTween<T extends Record<string, number>>(apply: (value: T) => void) {
  const frame = useRef<number | null>(null);
  const latestApply = useRef(apply);
  useLayoutEffect(() => {
    latestApply.current = apply;
  });

  const cancel = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  /** zoom 按对数插值，放大缩小的速度才均匀。 */
  const start = (from: T, to: T, duration = 280) => {
    cancel();
    const began = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - began) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const value: Record<string, number> = {};
      for (const key of Object.keys(to)) {
        const a = from[key]!;
        const b = to[key]!;
        value[key] = key === "zoom" ? a * (b / a) ** eased : a + (b - a) * eased;
      }
      latestApply.current(value as T);
      frame.current = progress < 1 ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  };

  useEffect(() => cancel, []);
  return { start, cancel };
}
