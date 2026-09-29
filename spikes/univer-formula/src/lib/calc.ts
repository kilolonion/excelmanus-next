// 公式计算结束检测。
// 机制（源码依据）：
//  - engine-formula 的 CalculateController 在每个阶段发
//    `formula.mutation.set-formula-calculation-notification`（onlyLocal），
//    params.stageInfo.stage === 8 = CALCULATION_COMPLETED，0 = IDLE。
//  - FormulaCalculationSessionService.state$ 中 state.id 每轮计算自增，
//    completed=true 且 resultApplied=true 表示"算完且结果已写回 sheet"。
// 采用 session.id 增量 + completed+resultApplied 双重确认——只看 stage8 不够：
// 上一轮的 completed 状态会残留，必须确认"本次触发的这一轮"已应用。

import { FormulaCalculationSessionService } from "@univerjs/engine-formula";
import type { Booted } from "./univer-node.ts";

export interface CalcWaitResult {
  outcome: "done" | "idle" | "timeout";
  ms: number;
}

interface SessionState {
  id: number;
  started: boolean;
  completed: boolean;
  resultApplied: boolean;
}

export function getSessionService(boot: Booted) {
  return (boot.injector as { get(t: unknown): unknown }).get(FormulaCalculationSessionService) as {
    state: SessionState;
    state$: { subscribe(cb: (s: SessionState) => void): { unsubscribe(): void } };
  };
}

const NOTIF_ID = "formula.mutation.set-formula-calculation-notification";

// 在触发命令**之前**调用 subscribeCalcDone()，拿到 promise；再执行命令并 await。
// outcome:
//   done    —— 出现了新的一轮计算（session.id 递增）且 completed+resultApplied
//   idle    —— 120ms 内没有新计算会话启动（本次写入未触发重算）
//   timeout —— 超过 timeoutMs 未结束
export function subscribeCalcDone(
  boot: Booted,
  timeoutMs = 30000,
  idleMs = 120,
): { promise: Promise<CalcWaitResult>; cancel(): void } {
  const t0 = performance.now();
  const session = getSessionService(boot);
  const id0 = session.state.id;
  let done = false;
  let resolveFn: (r: CalcWaitResult) => void = () => {};
  const promise = new Promise<CalcWaitResult>((res) => {
    resolveFn = res;
  });
  let subSession: { unsubscribe(): void } | undefined;
  let sub: { dispose(): void } | undefined;
  const finish = (outcome: CalcWaitResult["outcome"]) => {
    if (done) return;
    done = true;
    sub?.dispose();
    subSession?.unsubscribe();
    clearTimeout(timer);
    clearTimeout(idleTimer);
    resolveFn({ outcome, ms: performance.now() - t0 });
  };
  const timer = setTimeout(() => finish("timeout"), timeoutMs);
  const idleTimer = setTimeout(() => {
    const s = session.state;
    if (s.id > id0 && s.completed && s.resultApplied) finish("done");
    else if (s.id === id0) finish("idle");
    // 有会话在跑但未结束：继续等（notification/超时兜底）
  }, idleMs);
  const check = () => {
    const s = session.state;
    if (s.id > id0 && s.completed && s.resultApplied) finish("done");
  };
  subSession = session.state$.subscribe(check);
  if (done) {
    subSession.unsubscribe();
    return { promise, cancel: () => {} };
  }
  const listener = (info: unknown) => {
    const i = info as { id: string; params?: { stageInfo?: { stage?: number } } };
    if (i.id !== NOTIF_ID) return;
    const stage = i.params?.stageInfo?.stage;
    if (stage === 8 || stage === 0) check();
  };
  sub = boot.commandService.onCommandExecuted(listener) as { dispose(): void };
  return {
    promise,
    cancel: () => {
      done = true;
      sub?.dispose();
      subSession?.unsubscribe();
      clearTimeout(timer);
      clearTimeout(idleTimer);
    },
  };
}
