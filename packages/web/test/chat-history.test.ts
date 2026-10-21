import type { LogRecord } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { loadHistoryWindow, rebuildHistory } from "../src/lib/session/history";
import { initialSessionState, visibleTimeline } from "../src/lib/session/reducer";

function rec(seq: number, type: LogRecord["type"], data: Record<string, unknown>): LogRecord {
  return { sessionId: "s", agentId: "main", seq, type, data, createdAt: "2026-10-12T00:00:00Z" };
}
const records = [
  rec(1, "session.created", {}),
  ...[0, 1, 2].flatMap((i) => [
    rec(i * 5 + 2, "user.message", { dispatchId: `d${i}`, text: `问题${i}` }),
    rec(i * 5 + 3, "dispatch.updated", { dispatchId: `d${i}`, status: "applied" }),
    rec(i * 5 + 4, "turn.started", { turnId: `t${i}` }),
    rec(i * 5 + 5, "model.output", { stepId: `step${i}`, text: `回答${i}` }),
    rec(i * 5 + 6, "turn.completed", { turnId: `t${i}`, usage: {} }),
  ]),
];

test("history starts with a recent complete turn, fetching older pages only when requested", async () => {
  const calls: Array<number | undefined> = [];
  const read = async (before?: number) => {
    calls.push(before);
    return { items: records.filter((r) => before === undefined || r.seq < before).slice(-4) };
  };
  const latest = await loadHistoryWindow(read);
  expect(latest.records[0]?.seq).toBe(12);
  expect(latest.hasMore).toBe(true);
  expect(calls).toEqual([undefined, 13]);
  const older = await loadHistoryWindow(read, 12);
  expect(older.records[0]?.seq).toBe(7);
  expect(older.records.at(-1)?.seq).toBe(11);
});

test("prepending history deduplicates records without discarding current streaming state", () => {
  const latest = rebuildHistory(records.slice(11), initialSessionState());
  latest.live.main = {
    stepId: "live",
    text: "仍在输出",
    reasoning: "",
    reasoningStartedAt: null,
    toolArgs: {},
    activity: [],
    contextUsage: null,
  };
  const result = rebuildHistory([...records, ...records.slice(11)], latest);
  expect(visibleTimeline(result, "main").filter((item) => item.kind === "user")).toHaveLength(3);
  expect(result.cursor).toBe(16);
  expect(result.live.main?.text).toBe("仍在输出");
});

test("long current turns scan each history page once instead of rescanning accumulated records", async () => {
  let scanned = 0;
  const long = Array.from({ length: 2001 }, (_, i) => {
    const record = rec(
      i + 2,
      i === 0 ? "user.message" : i === 1 ? "turn.started" : "model.output",
      {},
    );
    Object.defineProperty(record, "agentId", {
      get: () => {
        scanned++;
        return "main";
      },
    });
    return record;
  });
  const result = await loadHistoryWindow(async (before) => ({
    items: long.filter((r) => before === undefined || r.seq < before).slice(-100),
  }));
  expect(scanned).toBeLessThanOrEqual(long.length * 2);
  expect(result.records.map((r) => r.seq)).toEqual(long.map((r) => r.seq));
  expect(result.hasMore).toBe(true);
});

test("a page boundary does not pair a user message across an intervening model step", async () => {
  const pages = [
    [rec(12, "step.started", {}), rec(13, "turn.started", {})],
    [rec(10, "user.message", {}), rec(11, "dispatch.updated", {})],
    [rec(8, "user.message", {}), rec(9, "turn.started", {})],
  ];
  let read = 0;
  const result = await loadHistoryWindow(async () => ({ items: pages[read++] ?? [] }));
  expect(read).toBe(3);
  expect(result.records.map((r) => r.seq)).toEqual([8, 9, 10, 11, 12, 13]);
});
