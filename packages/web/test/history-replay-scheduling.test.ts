import type { LogRecord } from "@excelmanus/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { rebuildHistory, rebuildHistoryAsync } from "../src/lib/session/history";
import { initialSessionState } from "../src/lib/session/reducer";

const rows: LogRecord[] = Array.from({ length: 128 }, (_, i) => ({
  sessionId: "s",
  agentId: "main",
  seq: i + 1,
  type: "model.output",
  data: { stepId: `s${i}`, text: `line${i}` },
  createdAt: "2026-10-18T00:00:00Z",
}));
function clock() {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += 9));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("historical replay yields between slices and preserves sorted deduplicated output", async () => {
  clock();
  const input = [...rows.toReversed(), rows[10]];
  let finished = false;
  const promise = rebuildHistoryAsync(
    input,
    () => initialSessionState(),
    () => true,
  ).then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  await vi.runAllTimersAsync();
  expect(await promise).toEqual(rebuildHistory(input, initialSessionState()));
});
test("leaving a conversation stops replay without reading the remaining log", async () => {
  clock();
  let active = true,
    reads = 0;
  const input = rows.map((r) => ({
    ...r,
    get data() {
      reads++;
      return r.data;
    },
  }));
  const promise = rebuildHistoryAsync(
    input,
    () => initialSessionState(),
    () => active,
  );
  const before = reads;
  active = false;
  await vi.runAllTimersAsync();
  expect(await promise).toBeNull();
  expect(reads).toBe(before);
  expect(reads).toBeLessThan(input.length);
});
test("older-history replay incorporates new records and the latest live state", async () => {
  clock();
  const current = initialSessionState();
  let tail: LogRecord[] = [];
  const promise = rebuildHistoryAsync(
    rows,
    () => current,
    () => true,
    () => {
      const result = tail;
      tail = [];
      return result;
    },
  );
  tail = [{ ...rows[0], seq: 129, data: { stepId: "latest", text: "received during replay" } }];
  current.title = "latest title";
  current.live.main = {
    stepId: "stream",
    text: "still streaming",
    reasoning: "",
    reasoningStartedAt: null,
    toolArgs: {},
    activity: [],
    contextUsage: null,
  };
  await vi.runAllTimersAsync();
  expect(await promise).toEqual(
    rebuildHistory(
      [
        ...rows,
        { ...rows[0], seq: 129, data: { stepId: "latest", text: "received during replay" } },
      ],
      current,
    ),
  );
});
test("already cancelled history does not begin preparation", async () => {
  let reads = 0;
  const input = [
    {
      ...rows[0],
      get seq() {
        reads++;
        return 1;
      },
    },
  ];
  expect(
    await rebuildHistoryAsync(
      input,
      () => initialSessionState(),
      () => false,
    ),
  ).toBeNull();
  expect(reads).toBe(0);
});
