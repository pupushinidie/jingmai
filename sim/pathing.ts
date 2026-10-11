// 机器人用的寻路：搬进了规则包（packages/game/src/botPathing.ts），服务器上的人机也用它。这里转一下，sim 里的旧代码不用改。

import { botPathing } from "@jingmai/game";

export const { adjacent, WELLS, layerOf, terrainOf, passable, forEachStep, forwardField, homeField, pathTo, pathHome, stepCosts } = botPathing;
export type Terrain = botPathing.Terrain;
export type Mover = botPathing.Mover;
export type Field = botPathing.Field;
