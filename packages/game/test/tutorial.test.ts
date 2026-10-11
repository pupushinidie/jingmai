import { describe, expect, it } from "vitest";
import {
  anchorVisible,
  applyTutorial,
  botCommand,
  createPracticeGame,
  createTutorialGame,
  pathTo,
  reachableCells,
  redactGameForViewer,
  sameCommand,
  tutorialActor,
  TUTORIAL_RIVAL,
  TUTORIAL_SELF,
  TUTORIAL_STEPS,
  type GameCommand,
  type GameState,
} from "../src/index.js";

const me = (state: GameState) => state.players.find((player) => player.id === TUTORIAL_SELF)!;

/** 玩家在界面上实际会发出的指令：订单放弃第一张、走路用界面同样的寻路。 */
function realCommand(state: GameState, expected: GameCommand): GameCommand {
  if (expected.type === "keepOrders") return { type: "keepOrders", discardId: me(state).orderChoices[0]!.id };
  if (expected.type === "plan" && expected.plan.kind === "move") {
    const reach = reachableCells(state, me(state));
    const path = pathTo(reach, expected.plan.path.at(-1)!);
    expect(path, "剧本里的目标格这回合走得到").not.toBeNull();
    return { type: "plan", plan: { kind: "move", path: path! } };
  }
  return expected;
}

/** 按剧本走到某一步之前（不含），返回局面。 */
function playTo(stepId: string | null): GameState {
  let state = createTutorialGame("新玩家");
  for (const step of TUTORIAL_STEPS) {
    if (step.id === stepId) return state;
    if (step.kind === "do") state = applyTutorial(state, TUTORIAL_SELF, realCommand(state, step.expect!));
  }
  return state;
}

describe("新手教程剧本", () => {
  it("从头走到尾：每个锚点那时看得见，每个 do 的指令合法且符合剧本", () => {
    let state = createTutorialGame("新玩家");
    for (const step of TUTORIAL_STEPS) {
      expect(anchorVisible(state, step.anchor), `${step.id} 的锚点 ${step.anchor}`).toBe(true);
      if (step.kind !== "do") continue;
      const command = realCommand(state, step.expect!);
      expect(sameCommand(command, step.expect!), step.id).toBe(true);
      state = applyTutorial(state, TUTORIAL_SELF, command);
      // 对手总是先确认好，玩家确认后马上结算、回到玩家规划。
      expect(tutorialActor(state), `${step.id} 之后轮到玩家`).toBe(TUTORIAL_SELF);
    }
    expect(state.phase).toBe("play");
  });

  it("关键几幕一定发生：挖两回合出土、撤离回营地、存入计分；对手不碰这颗宝石", () => {
    const afterMove = playTo("dig-1");
    expect(me(afterMove).cell).toBe("0:7:-1");
    expect(afterMove.turn).toBe(2);
    const afterFirstDig = playTo("dig-2");
    expect(afterFirstDig.gems.g3!.progress).toBe(2);
    const inBag = playTo("in-bag");
    expect(me(inBag).bag).toContain("g3");
    expect(Object.keys(inBag.gems.g3!.contributions)).toEqual([TUTORIAL_SELF]);
    expect(inBag.collapse).toBeGreaterThan(0);
    const camp = playTo("deposit");
    expect(me(camp).status).toBe("camp");
    const deposited = playTo("scoring");
    expect(deposited.gems.g3!.location).toEqual({ type: "vault", playerId: TUTORIAL_SELF });
    // 对手这几回合一直在自己挖，没有塌方预警来打断剧本。
    expect(deposited.collapse).toBeLessThan(21);
    expect(deposited.players.find((player) => player.id === TUTORIAL_RIVAL)!.status).not.toBe("retired");
  });

  it("每次打开都一样（固定地图 + 人机没有随机）", () => {
    expect(JSON.stringify(playTo(null))).toBe(JSON.stringify(playTo(null)));
  });

  it("剧本自身：id 不重复，finale 唯一且在最后，每句话不空、不太长", () => {
    const ids = TUTORIAL_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TUTORIAL_STEPS.filter((step) => step.finale)).toHaveLength(1);
    expect(TUTORIAL_STEPS.at(-1)!.finale).toBe(true);
    for (const step of TUTORIAL_STEPS) {
      expect(step.say.length).toBeGreaterThan(0);
      expect(step.say.length, step.id).toBeLessThanOrEqual(34);
      expect((step.note ?? "").length, step.id).toBeLessThanOrEqual(64);
      if (step.kind === "do") expect(step.expect).toBeDefined();
    }
  });

  it("剧本走完接练习局：两边都交给人机，能打完", () => {
    let state = playTo(null);
    for (let guard = 0; guard < 2000 && state.phase !== "finished"; guard += 1) {
      const actor = tutorialActor(state)!;
      state = applyTutorial(state, actor, botCommand(redactGameForViewer(state, actor), actor));
    }
    expect(state.phase).toBe("finished");
  });

  it("「再练一局」的随机地图：120 局都能打完", () => {
    let stuck = 0;
    for (let seed = 0; seed < 120; seed += 1) {
      let state = createPracticeGame("新玩家", 5000 + seed);
      for (let guard = 0; guard < 3000 && state.phase !== "finished"; guard += 1) {
        const actor = tutorialActor(state)!;
        state = applyTutorial(state, actor, botCommand(redactGameForViewer(state, actor), actor));
      }
      if (state.phase !== "finished") stuck += 1;
    }
    expect(stuck).toBe(0);
  }, 60_000);
});
