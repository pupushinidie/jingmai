import { describe, expect, it } from "vitest";
import { layerCells, type LayerIndex } from "@jingmai/game";
import { HEX_SIZE, cellPoint, hitTestStack, pixelToHex, projectToScreen, stackGeometry } from "./mapGeometry.js";

describe("六边形坐标", () => {
  it("格子中心和中心附近的点都换算回同一格", () => {
    for (const layer of [0, 1, 2] as LayerIndex[]) {
      for (const cell of layerCells(layer)) {
        const p = cellPoint(cell);
        const [, q, r] = cell.split(":").map(Number);
        for (const [dx, dy] of [[0, 0], [3, 0], [-3, 2], [0, -4], [2.5, 3.5]] as const) {
          expect(pixelToHex((p.x + dx) / HEX_SIZE, (p.y + dy) / HEX_SIZE)).toEqual({ q, r });
        }
      }
    }
  });
});

describe("立体视图投影", () => {
  const views = [
    { spin: -18, tilt: 64 },
    { spin: 0, tilt: 20 },
    { spin: 75, tilt: 80 },
    { spin: -140, tilt: 45 },
  ];

  it.each(views)("投到屏幕再反推，回到同一格（%o）", (angles) => {
    const g = stackGeometry(420, angles);
    for (const layer of [0, 1, 2] as LayerIndex[]) {
      for (const cell of layerCells(layer)) {
        const p = cellPoint(cell);
        const s = projectToScreen(g, layer, p.x, p.y);
        const hit = hitTestStack(g, s.x, s.y).find((candidate) => candidate.layer === layer);
        expect(hit?.cell).toBe(cell);
      }
    }
  });

  it("越靠上的层离观察者越近，排在前面", () => {
    // 接近俯视时，晶心中心这一点往上穿过回廊、浅脉也都在范围内：三层都命中，浅脉在最前。
    const g = stackGeometry(420, { spin: 0, tilt: 20 });
    const s = projectToScreen(g, 2, 0, 0);
    expect(hitTestStack(g, s.x, s.y).map((hit) => hit.layer)).toEqual([0, 1, 2]);
  });

  it("落在层外的点不算命中", () => {
    const g = stackGeometry(420, { spin: -18, tilt: 64 });
    expect(hitTestStack(g, 5000, 5000)).toEqual([]);
  });
});
