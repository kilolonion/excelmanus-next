import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChangeEntry, SessionState } from "../src/lib/session/types";

const hooks = vi.hoisted(() => ({
  memo: [] as Array<{ deps: unknown[]; value: unknown }>,
  memoIndex: 0,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  session: null as unknown as SessionState,
  changesSeenSeq: 0,
  doc: { docId: "doc", path: "a.xlsx", rev: 1 } as {
    docId: string;
    path: string;
    rev: number;
  } | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useRef = (initial: unknown) => (hooks.refs[hooks.refIndex++] ??= { current: initial });
  return {
    ...react,
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const index = hooks.memoIndex++,
        prior = hooks.memo[index];
      if (
        prior &&
        deps.length === prior.deps.length &&
        deps.every((v, i) => Object.is(v, prior.deps[i]))
      )
        return prior.value;
      const value = fn();
      hooks.memo[index] = { deps, value };
      return value;
    },
    useRef,
  };
});
// The externalized Zustand module otherwise keeps React's SSR-only refs.
vi.mock("zustand/react/shallow", async () => {
  const { shallow } = await import("zustand/vanilla/shallow");
  const { useRef } = await import("react");
  return {
    useShallow: (select: (s: unknown) => unknown) => {
      const previous = useRef<unknown>(undefined);
      return (s: unknown) => {
        const next = select(s);
        if (!shallow(previous.current, next)) previous.current = next;
        return previous.current;
      };
    },
  };
});
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: (s: { session: SessionState }) => unknown) =>
    select({ session: hooks.session }),
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: (select: (s: { doc: typeof hooks.doc; changesSeenSeq: number }) => unknown) =>
    select({ doc: hooks.doc, changesSeenSeq: hooks.changesSeenSeq }),
}));
vi.mock("@/lib/workbook/pending-writes", async (original) => {
  const actual = await original<typeof import("../src/lib/workbook/pending-writes")>();
  return { ...actual, pendingWriteTargets: vi.fn(actual.pendingWriteTargets) };
});

import { initialSessionState, reduceSession } from "../src/lib/session/reducer";
import { pendingWriteTargets } from "../src/lib/workbook/pending-writes";
import {
  useChangeNavigation,
  useDocActivity,
  useDocChangeCount,
  usePendingOverlay,
  useRecentChanges,
} from "../src/lib/workbook/use-overlay-data";

let result: {
  pending: ReturnType<typeof usePendingOverlay>;
  activity: ReturnType<typeof useDocActivity>;
};
function Probe() {
  result = { pending: usePendingOverlay(), activity: useDocActivity() };
  return null;
}
function render() {
  hooks.memoIndex = 0;
  hooks.refIndex = 0;
  renderToString(createElement(Probe));
  return result;
}
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  hooks.memo = [];
  hooks.refs = [];
  hooks.session = initialSessionState();
  hooks.changesSeenSeq = 0;
  hooks.doc = { docId: "doc", path: "a.xlsx", rev: 1 };
  vi.mocked(pendingWriteTargets).mockClear();
  hooks.session.approvals.one = {
    status: "pending",
    toolName: "workbook_edit",
    args: { path: "a.xlsx", ops: [{ op: "cells.set", sheet: "S", range: "A1", values: [[7]] }] },
  } as never;
});
test("pending ranges and values share one parse and ignore unrelated document revisions", () => {
  expect(render().pending).toEqual({ ranges: "S!A1", values: '{"S!A1":7}' });
  expect(pendingWriteTargets).toHaveBeenCalledTimes(1);
  hooks.doc = { ...hooks.doc!, rev: 2 };
  render();
  expect(pendingWriteTargets).toHaveBeenCalledTimes(1);
  hooks.session = { ...hooks.session, approvals: {} };
  expect(render().pending).toEqual({ ranges: "", values: "{}" });
});
test("text deltas reuse activity selection while activity and document changes still update", () => {
  hooks.session = reduceSession(hooks.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "a",
  });
  const ranges = vi.fn(() => ["S!A1"]);
  hooks.session.live.main!.activity = [
    {
      toolCallId: "tool",
      kind: "read",
      docId: "doc",
      get ranges() {
        return ranges();
      },
    },
  ];
  expect(render().activity).toEqual([{ kind: "read", ranges: ["S!A1"], label: "正在读取" }]);
  ranges.mockClear();
  hooks.session = reduceSession(hooks.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 2,
    kind: "text",
    payload: "b",
  });
  hooks.doc = { ...hooks.doc!, rev: 2 };
  render();
  expect(ranges).not.toHaveBeenCalled();
  hooks.session = {
    ...hooks.session,
    live: {
      main: {
        ...hooks.session.live.main!,
        activity: [{ toolCallId: "new", kind: "write", docId: "doc", ranges: ["S!B2"] }],
      },
    },
  };
  expect(render().activity).toEqual([{ kind: "write", ranges: ["S!B2"], label: "正在写入" }]);
  hooks.doc = { docId: "other", path: "b.xlsx", rev: 1 };
  expect(render().activity).toEqual([]);
});

test("recent changes reuse filtering on text deltas and update after changes are seen", () => {
  const ranges = vi.fn(() => ["S!A1"]);
  hooks.session.changes = [
    {
      docId: "doc",
      seq: 2,
      at: new Date().toISOString(),
      get ranges() {
        return ranges();
      },
    },
  ] as never;
  let changes: ReturnType<typeof useRecentChanges> = [];
  function RecentProbe() {
    changes = useRecentChanges();
    return null;
  }
  const show = () => {
    hooks.memoIndex = 0;
    hooks.refIndex = 0;
    renderToString(createElement(RecentProbe));
  };
  show();
  expect(changes).toHaveLength(1);
  ranges.mockClear();
  hooks.session = reduceSession(hooks.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "hello",
  });
  show();
  expect(ranges).not.toHaveBeenCalled();
  hooks.changesSeenSeq = 2;
  show();
  expect(changes).toEqual([]);
  hooks.changesSeenSeq = 0;
  hooks.session = { ...hooks.session, changes: [] };
  show();
  expect(changes).toEqual([]);
});

test("change badge and navigation avoid rescanning unchanged changes on text deltas", () => {
  const ranges = vi.fn(() => ["S!A1", "S!B2"]);
  const docId = vi.fn(() => "doc");
  hooks.session.changes = [
    {
      get docId() {
        return docId();
      },
      seq: 2,
      get ranges() {
        return ranges();
      },
    },
  ] as never;
  let count = 0,
    result: ReturnType<typeof useChangeNavigation> | undefined;
  let scope: "turn" | "all" = "turn";
  function ChangesProbe() {
    count = useDocChangeCount();
    result = useChangeNavigation(scope);
    return null;
  }
  const show = () => {
    hooks.memoIndex = 0;
    hooks.refIndex = 0;
    renderToString(createElement(ChangesProbe));
  };
  show();
  expect(count).toBe(1);
  expect(result?.items.map((i) => i.range)).toEqual(["S!A1", "S!B2"]);
  expect(result?.total).toBe(2);
  ranges.mockClear();
  docId.mockClear();
  hooks.session = reduceSession(hooks.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "hello",
  });
  hooks.doc = { docId: "doc", path: "a.xlsx", rev: 2 };
  show();
  expect(ranges).not.toHaveBeenCalled();
  expect(docId).not.toHaveBeenCalled();
  hooks.session = { ...hooks.session, timelines: { main: [{ kind: "user", seq: 3 }] as never } };
  show();
  expect(count).toBe(0);
  expect(result?.items).toEqual([]);
  expect(result?.total).toBe(2);
  scope = "all";
  show();
  expect(result?.items).toHaveLength(2);
  hooks.doc = { docId: "other", path: "b.xlsx", rev: 1 };
  show();
  expect(result?.total).toBe(0);
});

function change(docId: string, seq: number): ChangeEntry {
  return {
    docId,
    seq,
    toolCallId: `tool-${seq}`,
    path: `${docId}.xlsx`,
    rev: seq,
    ranges: ["S!A1"],
    cells: 1,
    structural: [],
    agentId: "main",
    at: new Date().toISOString(),
  };
}
function showAllChanges() {
  let recent: ChangeEntry[] = [],
    count = 0;
  let navigation: ReturnType<typeof useChangeNavigation> | undefined;
  function AllProbe() {
    recent = useRecentChanges();
    count = useDocChangeCount();
    navigation = useChangeNavigation("turn");
    return null;
  }
  hooks.memoIndex = 0;
  hooks.refIndex = 0;
  renderToString(createElement(AllProbe));
  return { recent, count, navigation: navigation! };
}
test("highlight, badge and navigation share one document lookup across a long history", () => {
  const reads = vi.fn();
  hooks.session.changes = Array.from({ length: 1000 }, (_, i) => ({
    ...change(i % 2 ? "other" : "doc", i + 1),
    get docId() {
      reads();
      return i % 2 ? "other" : "doc";
    },
  }));
  const result = showAllChanges();
  expect(result.count).toBe(500);
  expect(result.recent).toHaveLength(500);
  expect(result.navigation.total).toBe(500);
  expect(reads.mock.calls.length).toBeLessThanOrEqual(1000);
});
test("recent highlights do not serialize unrelated metadata or clone change records", () => {
  const path = vi.fn(() => "a.xlsx");
  const entry = {
    ...change("doc", 2),
    get path() {
      return path();
    },
  };
  hooks.session.changes = [entry];
  const result = showAllChanges();
  expect(path).not.toHaveBeenCalled();
  expect(result.recent[0]).toBe(entry);
});
test("other-document edits preserve current highlight and navigation arrays", () => {
  hooks.session.changes = [change("doc", 2)];
  const first = showAllChanges();
  hooks.session = { ...hooks.session, changes: [...hooks.session.changes, change("other", 3)] };
  const second = showAllChanges();
  expect(second.recent).toBe(first.recent);
  expect(second.navigation.items).toBe(first.navigation.items);
  hooks.session = { ...hooks.session, changes: [...hooks.session.changes, change("doc", 4)] };
  const third = showAllChanges();
  expect(third.count).toBe(2);
  expect(third.recent).toHaveLength(2);
  expect(third.navigation.items).toHaveLength(2);
});
test("document selection still respects turn, seen, expiry and structural-only changes", () => {
  const expired = { ...change("doc", 3), at: "2000-01-01T00:00:00.000Z" };
  hooks.session.changes = [
    change("doc", 1),
    expired,
    { ...change("doc", 4), ranges: [] },
    change("doc", 5),
  ];
  hooks.session = { ...hooks.session, timelines: { main: [{ kind: "user", seq: 2 }] as never } };
  hooks.changesSeenSeq = 2;
  let result = showAllChanges();
  expect(result.count).toBe(3);
  expect(result.recent.map((c) => c.seq)).toEqual([5]);
  expect(result.navigation.items.map((c) => c.entry.seq)).toEqual([3, 5]);
  expect(result.navigation.total).toBe(3);
  hooks.doc = { docId: "other", path: "other.xlsx", rev: 1 };
  result = showAllChanges();
  expect(result.count).toBe(0);
  expect(result.recent).toEqual([]);
  expect(result.navigation.total).toBe(0);
  hooks.doc = null;
  expect(showAllChanges().recent).toEqual([]);
});
