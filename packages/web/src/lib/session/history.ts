import type { LogRecord } from "@excelmanus/protocol";
import { createHistoryReplay, MAIN_AGENT, type RosterSnapshot } from "./reducer";
import type { SessionState } from "./types";

export async function loadHistoryWindow(
  read: (before?: number) => Promise<{ items: LogRecord[] }>,
  before?: number,
): Promise<{ records: LogRecord[]; hasMore: boolean }> {
  // Keep pages separate while searching backward, then flatten only the final window.
  const pages: LogRecord[][] = [];
  const finish = (hasMore: boolean, start = 0) => {
    const ordered = pages.toReversed();
    if (start > 0) ordered[0] = ordered[0].slice(start);
    return { records: ordered.flat(), hasMore };
  };
  let cursor = before;
  // Would a pending user message at the end of the next page match the loaded suffix?
  let suffixAcceptsUser = false;
  for (;;) {
    const page = (await read(cursor)).items;
    if (page.length === 0) return finish(false);
    pages.push(page);
    if (page[0].seq === 1) return finish(false);
    // 不把一轮执行从中间截断，否则补载前文会改变其标识与滚动锚点。
    let start = -1;
    let pageAcceptsUser: boolean | undefined;
    for (let i = 0; i < page.length; i++) {
      const record = page[i];
      if (record.agentId !== MAIN_AGENT) continue;
      const isStart = record.type === "turn.started";
      const isBarrier = record.type === "model.output" || record.type === "step.started";
      if (pageAcceptsUser === undefined && (isStart || isBarrier)) pageAcceptsUser = isStart;
      if (record.type === "user.message" && start < 0) start = i;
      if (isStart && start >= 0) return finish(true, start);
      if (isBarrier) start = -1;
    }
    if (start >= 0 && suffixAcceptsUser) return finish(true, start);
    suffixAcceptsUser = pageAcceptsUser ?? suffixAcceptsUser;
    cursor = page[0].seq;
  }
}

function orderedHistory(records: LogRecord[]): LogRecord[] {
  return [...new Map(records.map((r) => [r.seq, r])).values()].sort((a, b) => a.seq - b.seq);
}

function withCurrentState(state: SessionState, current: SessionState): SessionState {
  return {
    ...state,
    title: current.title ?? state.title,
    permissionMode: current.permissionMode ?? state.permissionMode,
    roster: { ...state.roster, ...current.roster },
    ...(current.pendingInteractions ? { pendingInteractions: current.pendingInteractions } : {}),
    live: { ...state.live, ...current.live },
  };
}

export function rebuildHistory(records: LogRecord[], current: SessionState): SessionState {
  const replay = createHistoryReplay();
  for (const record of orderedHistory(records)) replay.push(record);
  return withCurrentState(replay.finish(), current);
}

/** Replay privately in time slices; publish only a complete view of a still-active session. */
export async function rebuildHistoryAsync(
  records: LogRecord[],
  current: () => SessionState,
  isCurrent: () => boolean,
  // Older-history loading keeps receiving records. Each call drains only the newly arrived tail.
  takeTail: () => LogRecord[] = () => [],
  rosterSnapshot?: RosterSnapshot,
): Promise<SessionState | null> {
  if (!isCurrent()) return null;
  const replay = createHistoryReplay(rosterSnapshot);
  let batch = orderedHistory(records);
  let started = performance.now();
  while (batch.length) {
    for (const record of batch) {
      replay.push(record);
      if (performance.now() - started >= 8) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!isCurrent()) return null;
        started = performance.now();
      }
    }
    batch = orderedHistory(takeTail());
  }
  return isCurrent() ? withCurrentState(replay.finish(), current()) : null;
}
