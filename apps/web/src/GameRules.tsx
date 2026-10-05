import { useState } from "react";
import { GEM_DEFS, GEM_KINDS, LAYER_DEFS, PARAMS, TOOL_DEFS, TOOL_KINDS, TRAIT_NAMES } from "@jingmai/game";

function GameRules() {
  const [open, setOpen] = useState(false);

  return (
    <section className={open ? "game-rules open" : "game-rules"}>
      <button
        className="game-rules-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="game-rules-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">✦</span> 游戏规则
        <i aria-hidden="true">{open ? "收起 ▴" : "展开 ▾"}</i>
      </button>

      {open && (
        <div className="game-rules-panel" id="game-rules-panel">
          <div className="game-rules-block">
            <h3>目标</h3>
            <p>
              下到三层矿洞挖宝石，带回营地存入。越往下越值钱，也越早塌方。
              塌方进度到 {LAYER_DEFS[2].collapseAt} 晶心塌、{LAYER_DEFS[1].collapseAt} 回廊塌、{LAYER_DEFS[0].collapseAt} 整个矿洞塌毁，游戏结束，总分最高者获胜。
            </p>
            <p>总分 = 存入的宝石价值 + 碎裂保底分 + 公共订单 + 私人订单。</p>
          </div>

          <div className="game-rules-block">
            <h3>每回合</h3>
            <ol>
              <li>所有人同时规划：<b>移动</b>，或者做<b>一个动作</b>（挖掘、拾取、交接、切割、撤离、待命）。</li>
              <li>全部确认后一起结算：移动 → 动作 → 出土 → 电梯 → 环境。</li>
              <li>移动力 = 背包空格 + {PARAMS.moveBonus}（{PARAMS.minMove}–{PARAMS.maxMove}）。背包 {PARAMS.bagSlots} 格，工具和宝石都占格，背得越多走得越慢。</li>
            </ol>
          </div>

          <div className="game-rules-block">
            <h3>矿洞</h3>
            <ul>
              <li>电梯在每层中心，按 1→2→3→2→1 每回合走一站，站在上面的人跟着换层。</li>
              <li>梯子双向：下 1 格，上 {PARAMS.ladderUpCost} 格（带绳索 1 格）；满载又没绳索爬不上去。</li>
              <li>洞口只能往下，跳下随机损坏一件工具（带绳索可免）。</li>
              <li>每回合塌方 +1；每 {PARAMS.vibrationPerCollapse} 点震动再 +1。挖一次震动 1，钻 2，炸药 6。层塌方时，人被困、背包里的宝石全部失去。</li>
            </ul>
          </div>

          <div className="game-rules-block">
            <h3>合作与碎裂</h3>
            <p>
              一颗宝石只要 2 人以上出过力（或同回合被多人同时拾取），出土时就会碎裂，
              按贡献分 {Math.round(PARAMS.shatterShare * 100)}% 的价值，直接计分。测试版还没有契约系统。
            </p>
          </div>

          <div className="game-rules-block">
            <h3>营地</h3>
            <p>站在井口"撤离"，回合结束到营地；下一回合可以存入、卖出、买工具，然后选井口下井、留守或收工。一趟往返至少 2 回合。</p>
          </div>

          <div className="game-rules-block">
            <h3>宝石</h3>
            <ul>
              {GEM_KINDS.map((kind) => {
                const def = GEM_DEFS[kind];
                return (
                  <li key={kind}>
                    <b>{def.name}</b> {def.layers.map((layer) => LAYER_DEFS[layer].name).join("/")} · 值 {def.value} · 硬度 {def.hardness}
                    {def.trait !== "none" ? ` · ${TRAIT_NAMES[def.trait]}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="game-rules-block">
            <h3>工具</h3>
            <ul>
              {TOOL_KINDS.map((kind) => (
                <li key={kind}><b>{TOOL_DEFS[kind].name}</b> {TOOL_DEFS[kind].price} 金：{TOOL_DEFS[kind].description}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

export default GameRules;
