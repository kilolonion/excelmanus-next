import { createHistoryWindowBoundary, type LogRecord } from "@excelmanus/protocol";
import { createHistoryReplay, type RosterSnapshot } from "./reducer";
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
  const boundary = createHistoryWindowBoundary();
  for (;;) {
    const page = (await read(cursor)).items;
    if (page.length === 0) return finish(false);
    pages.push(page);
    if (cursor !== undefined && page[0].seq >= cursor) throw new Error("历史分页游标未前进");
    const match = boundary.push(page);
    if (match) return finish(match.hasMore, match.startIndex);
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
