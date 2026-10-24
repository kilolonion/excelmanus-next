/** Fast restore budgets; the legacy paginated fallback has its own lifecycle deadline. */
export const HISTORY_WINDOW_MAX_RECORDS = 2048;
export const HISTORY_WINDOW_MAX_BYTES = 2 * 1024 * 1024;
export const HISTORY_WINDOW_DETAIL_MAX_BYTES = 256 * 1024;
export const HISTORY_WINDOW_DETAIL_MAX_ROWS = 128;
export const HISTORY_WINDOW_PAGE_SIZE = 100;

export interface HistoryBoundaryRecord {
  seq: number;
  agentId: string | null;
  type: string;
}

/** Push complete legacy pages in reverse chronological page order, each page ascending. */
export function createHistoryWindowBoundary() {
  let suffixAcceptsUser = false;
  return {
    push(page: readonly HistoryBoundaryRecord[]): { startIndex: number; hasMore: boolean } | null {
      if (page.length === 0 || page[0]?.seq === 1) return { startIndex: 0, hasMore: false };
      let start = -1;
      let pageAcceptsUser: boolean | undefined;
      for (let i = 0; i < page.length; i++) {
        const record = page[i];
        if (record?.agentId !== "main") continue;
        const isStart = record.type === "turn.started";
        const isBarrier = record.type === "model.output" || record.type === "step.started";
        if (pageAcceptsUser === undefined && (isStart || isBarrier)) pageAcceptsUser = isStart;
        if (record.type === "user.message" && start < 0) start = i;
        if (isStart && start >= 0) return { startIndex: start, hasMore: true };
        if (isBarrier) start = -1;
      }
      if (start >= 0 && suffixAcceptsUser) return { startIndex: start, hasMore: true };
      suffixAcceptsUser = pageAcceptsUser ?? suffixAcceptsUser;
      return null;
    },
  };
}
