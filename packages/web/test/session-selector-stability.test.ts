import { expect, test, vi } from "vitest";
import {
  changeForTool,
  compactionCount,
  initialSessionState,
  lastUserSeq,
  pendingDispatches,
  reduceSession,
  visibleTimeline,
} from "../src/lib/session/reducer";
import type { UserItem } from "../src/lib/session/types";

const user = (id: string, seq: number, agentId = "main"): UserItem => ({
  kind: "user",
  id,
  seq,
  agentId,
  at: "2026-01-01T00:00:00Z",
  text: id,
  mode: "queue",
  status: "queued",
  clientMessageId: id,
  attachments: [],
  context: [],
});

test("live text does not invalidate unchanged history and dispatch selections", () => {
  const state = initialSessionState();
  state.timelines.main = [user("old", 1), user("visible", 3)];
  state.rewinds.main = [{ fromSeq: 1, seq: 2 }];
  state.dispatches.next = user("next", 4);
  const history = visibleTimeline(state, "main");
  const queue = pendingDispatches(state, "main");
  const next = reduceSession(state, {
    type: "delta",
    topic: "session:x",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "next token",
  });
  expect(next.live.main?.text).toBe("next token");
  expect(visibleTimeline(next, "main")).toBe(history);
  expect(pendingDispatches(next, "main")).toBe(queue);
});

test("changed rewinds and dispatch status still invalidate selections", () => {
  const state = initialSessionState();
  const item = user("one", 1);
  state.timelines.main = [item];
  state.dispatches.one = item;
  const previous = pendingDispatches(state, "main");
  expect(visibleTimeline(state, "main")).toEqual([item]);
  const next = {
    ...state,
    rewinds: { main: [{ fromSeq: 1, seq: 2 }] },
    dispatches: { one: { ...item, status: "applied" as const } },
  };
  expect(visibleTimeline(next, "main")).toEqual([]);
  expect(pendingDispatches(next, "main")).toEqual([]);
  expect(pendingDispatches(next, "main")).not.toBe(previous);
  expect(visibleTimeline(state, "main")).toEqual([item]);
});

test("dispatch caches stay separate by agent and preserve sequence order", () => {
  const state = initialSessionState();
  state.dispatches = {
    later: user("later", 8),
    earlier: user("earlier", 2),
    child: user("child", 3, "child"),
  };
  expect(pendingDispatches(state, "main").map((d) => d.id)).toEqual(["earlier", "later"]);
  expect(pendingDispatches(state, "child").map((d) => d.id)).toEqual(["child"]);
  expect(pendingDispatches(state, "main")).toBe(pendingDispatches(state, "main"));
});

test("last-user lookup reuses unchanged timelines during streamed text and invalidates on new history", () => {
  const state = initialSessionState();
  const item = user("one", 3);
  const kind = vi.fn(() => "user");
  Object.defineProperty(item, "kind", { get: kind });
  state.timelines.main = [item];
  expect(lastUserSeq(state)).toBe(3);
  const next = reduceSession(state, {
    type: "delta",
    topic: "session:x",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "token",
  });
  kind.mockClear();
  expect(lastUserSeq(next)).toBe(3);
  expect(kind).not.toHaveBeenCalled();
  next.timelines = {
    ...next.timelines,
    main: [...next.timelines.main!, user("two", 7)],
    child: [user("child", 9, "child")],
  };
  expect(lastUserSeq(next)).toBe(7);
  expect(lastUserSeq(next, "child")).toBe(9);
});

test("rewind floor scans each immutable timeline once, including no-compaction histories", async () => {
  const { rewindableFrom } = await import("../src/lib/session/reducer");
  const state = initialSessionState();
  const item = user("one", 1);
  const kind = vi.fn(() => "user");
  Object.defineProperty(item, "kind", { get: kind });
  state.timelines.main = [item];
  expect(rewindableFrom(state, "main")).toBe(0);
  kind.mockClear();
  expect(rewindableFrom({ ...state, live: {} }, "main")).toBe(0);
  expect(kind).not.toHaveBeenCalled();
  const next = {
    ...state,
    timelines: {
      ...state.timelines,
      main: [...state.timelines.main, { kind: "compaction", seq: 5 } as never],
    },
  };
  expect(rewindableFrom(next, "main")).toBe(5);
  expect(rewindableFrom(next, "child")).toBe(0);
  expect(rewindableFrom(state, "main")).toBe(0);
});

test.each(["approvals", "questions"] as const)(
  "pending %s selection reuses streamed state but updates status and order",
  async (field) => {
    const { pendingApprovals, pendingQuestions } = await import("../src/lib/session/reducer");
    const select = field === "approvals" ? pendingApprovals : pendingQuestions;
    const state = initialSessionState();
    const status = vi.fn(() => "pending");
    Object.assign(state, {
      [field]: {
        later: {
          id: "later",
          seq: 8,
          get status() {
            return status();
          },
        },
        earlier: { id: "earlier", seq: 2, status: "pending" },
      },
    });
    const selected = select(state);
    expect(selected.map((i) => i.id)).toEqual(["earlier", "later"]);
    status.mockClear();
    expect(select({ ...state, live: {} })).toBe(selected);
    expect(status).not.toHaveBeenCalled();
    const next = {
      ...state,
      [field]: {
        ...state[field],
        later: { ...state[field].later, status: field === "approvals" ? "approved" : "answered" },
      },
    };
    expect(select(next).map((i) => i.id)).toEqual(["earlier"]);
    expect(select(state)).toBe(selected);
    expect(select({ ...state, [field]: {} })).toEqual([]);
  },
);

test("compaction cache retains zero and separates agent histories", () => {
  const state = initialSessionState();
  const kind = vi.fn(() => "user");
  state.timelines.main = [
    {
      get kind() {
        return kind();
      },
      seq: 1,
    },
  ] as never;
  expect(compactionCount(state, "main")).toBe(0);
  expect(compactionCount(state, "main")).toBe(0);
  expect(kind).toHaveBeenCalledTimes(1);
  state.timelines.child = [{ kind: "compaction", seq: 2 }] as never;
  expect(compactionCount(state, "child")).toBe(1);
  expect(compactionCount(state, "missing")).toBe(0);
  expect(compactionCount(state, "main")).toBe(0);
});

test("tool change index keeps first match and stable selection when unrelated changes arrive", () => {
  const state = initialSessionState();
  const first = { toolCallId: "t", path: "first" };
  state.changes = [first, { toolCallId: "t", path: "second" }] as never;
  expect(changeForTool(state, "t")).toBe(first);
  expect(changeForTool(state, "missing")).toBeUndefined();
  state.changes = [...state.changes, { toolCallId: "other", path: "other" }] as never;
  expect(changeForTool(state, "t")).toBe(first);
  state.changes = [];
  expect(changeForTool(state, "t")).toBeUndefined();
});
