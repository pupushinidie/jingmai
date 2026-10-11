/**
 * 晶脉的新手教程：在浏览器里按剧本走一局（packages/game/src/tutorial.ts），
 * 牌桌就是真正对局的 GameBoard，咕噜嘎的对话框叠在上面；剧本走完接练习局，对手咕噜一号交给人机。
 * 不连服务器，不占房间；首页、等候房间都能进来（从等候房间进来时，房主开局会自动回到牌桌，见 App.tsx）。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyTutorial,
  botCommand,
  createPracticeGame,
  createTutorialGame,
  DEFAULT_ROOM_ACCESS,
  redactGameForViewer,
  sameCommand,
  tutorialActor,
  TUTORIAL_RIVAL,
  TUTORIAL_RIVAL_NAME,
  TUTORIAL_SELF,
  TUTORIAL_STEPS,
  type GameCommand,
  type GameState,
  type LobbyMember,
  type LobbyRoomSnapshot,
  type TutorialStep,
} from "@jingmai/game";
import GameBoard from "./GameBoard.js";
import { Coach, isTouchDevice, StepPips, type CoachView } from "./tutorial/Coach.js";
import { writeTutorial } from "./tutorial/storage.js";
import { useTutorial } from "./tutorial/useTutorial.js";
import { GAME_ID } from "./tutorialGame.js";

const SELF_MEMBER = "tutorial-self";
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

/** 格子菜单开着没有：剧本里指着地图格子的步骤，菜单打开后改成高亮菜单（菜单在格子旁边，压暗层会挡住它）。 */
function useMenuOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      return;
    }
    const check = () => setOpen(document.querySelector(".jm-cell-menu") !== null);
    check();
    const timer = window.setInterval(check, 120);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return open;
}

export default function TutorialMode({ name, brand, waitingRoom, onExit }: {
  /** 首页填过的昵称；没填叫「新玩家」。 */
  name: string;
  brand: ReactNode;
  /** 从等候房间点进来的：那个房间的房间码。 */
  waitingRoom?: string | undefined;
  onExit: () => void;
}) {
  const selfName = name.trim().length >= 2 ? name.trim() : "新玩家";

  const tutorial = useTutorial<GameState, GameCommand, TutorialStep>({
    steps: TUTORIAL_STEPS,
    self: TUTORIAL_SELF,
    start: () => createTutorialGame(selfName),
    restart: () => createPracticeGame(selfName, randomSeed()),
    apply: applyTutorial,
    same: sameCommand,
    actor: (state) => tutorialActor(state),
    canAct: (state, playerId) => tutorialActor(state) === playerId,
    bot: (state, playerId) => botCommand(redactGameForViewer(state, playerId), playerId),
    botDelay: () => 700,
    watchDelay: () => 1100,
  });
  const { game, step, index, practice, flash } = tutorial;

  // 走到最后一步就算学完（之后首页不再邀请）
  useEffect(() => {
    if (practice || (step?.kind === "info" && step.finale)) writeTutorial(GAME_ID, "done");
  }, [practice, step?.id]);

  function leave() {
    writeTutorial(GAME_ID, "skipped");
    onExit();
  }

  const members = useMemo<LobbyMember[]>(() => [
    { id: SELF_MEMBER, playerId: TUTORIAL_SELF, name: selfName, isHost: true, connected: true },
    { id: "tutorial-bot", playerId: TUTORIAL_RIVAL, name: TUTORIAL_RIVAL_NAME, isHost: false, connected: true, bot: true },
  ], [selfName]);
  const room = useMemo<LobbyRoomSnapshot>(() => ({
    code: "",
    spectators: [],
    access: DEFAULT_ROOM_ACCESS,
    capacity: 2,
    status: "playing",
    members,
    chat: [],
    voice: [],
    turnSeconds: 90,
    game: redactGameForViewer(game, TUTORIAL_SELF),
  }), [game, members]);

  const cellStep = !practice && !!step?.anchor?.startsWith("cell:") && step.kind === "do";
  const menuOpen = useMenuOpen(cellStep);
  const anchor = step ? (cellStep && menuOpen ? "cell-menu" : step.anchor) : null;

  let view: CoachView | null = null;
  if (step) {
    const note = isTouchDevice() && step.noteTouch ? step.noteTouch : step.note;
    const finale = step.kind === "info" && step.finale === true;
    const lessons = TUTORIAL_STEPS.map((entry) => entry.lesson).filter((lesson, at, all) => lesson && all.indexOf(lesson) === at);
    view = {
      key: step.id,
      say: step.say,
      ...(note ? { note } : {}),
      ...(flash ? { flash } : {}),
      anchor,
      focus: step.kind !== "watch",
      face: flash ? "surprised" : step.face ?? "base",
      footer: (
        <>
          <StepPips index={index} total={TUTORIAL_STEPS.length} />
          {step.lesson && <span className="tut-lesson">{step.lesson} · {lessons.indexOf(step.lesson) + 1}/{lessons.length}</span>}
          {!finale && <button className="tut-link" type="button" onClick={leave}>跳过教程</button>}
        </>
      ),
      actions: step.kind !== "info" ? null : finale ? (
        <>
          <button className="quiet-button" type="button" onClick={onExit}>结束教程</button>
          <button className="primary-button tut-main" type="button" onClick={tutorial.startPractice}>打完这局</button>
        </>
      ) : (
        <button className="primary-button tut-main" type="button" onClick={tutorial.next}>下一步 ▶</button>
      ),
    };
  }

  return (
    <div className={practice ? "tut-practice" : "tut-script"} style={{ display: "contents" }}>
      <GameBoard
        room={room}
        busy={false}
        error=""
        notice=""
        brand={brand}
        connection={
          <span className="tut-top">
            <span className="tut-top-label">{practice ? "练习局" : "新手教程"}{waitingRoom ? ` · 房间 ${waitingRoom} 开局会自动回去` : ""}</span>
            <button className="quiet-button" type="button" onClick={practice ? onExit : leave}>退出教程</button>
          </span>
        }
        chat={null}
        onCommand={tutorial.onCommand}
        onRematch={() => undefined}
        onAuto={() => undefined}
        onDissolve={() => undefined}
        watchId={TUTORIAL_SELF}
        onWatch={() => undefined}
        onLeave={onExit}
        selfMemberId={SELF_MEMBER}
        mode={practice ? "practice" : "tutorial"}
        tutorialAnchor={practice ? null : step?.anchor ?? null}
        finalActions={
          <>
            <button className="quiet-button" type="button" onClick={onExit}>结束教程</button>
            <button className="primary-button" type="button" onClick={tutorial.newPractice}>再练一局</button>
          </>
        }
      />
      {view && <Coach view={view} />}
    </div>
  );
}
