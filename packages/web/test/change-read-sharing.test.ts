import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  before: vi.fn(),
  snapshot: vi.fn(),
  workspaceId: "",
  docId: "",
  currentRev: 10,
  activeDoc: true,
  deps: [] as unknown[][],
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  return {
    ...r,
    useState: (v: unknown) => [v === false ? true : v, vi.fn()],
    useEffect: (f: () => void | (() => void), deps: unknown[]) => {
      h.effects.push(f);
      h.deps.push(deps);
    },
  };
});
vi.mock("@/lib/backend/api", () => ({
  api: () => ({ getDocRevBefore: h.before, getDocSnapshot: h.snapshot }),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/stores/workbook-store", () => {
  const getState = () => ({
    workspaceId: h.workspaceId,
    doc: h.activeDoc ? { docId: h.docId, rev: h.currentRev } : null,
  });
  return {
    useWorkbookStore: Object.assign((select: (s: unknown) => unknown) => select(getState()), {
      getState,
    }),
    focusRange: vi.fn(),
    openWorkbook: vi.fn(),
    openWorkbookById: vi.fn(),
  };
});
vi.mock("@/stores/chat-store", () => ({ useChatStore: vi.fn() }));
vi.mock("@/stores/files-store", () => ({ downloadWorkspaceFile: vi.fn() }));

import { WorkbookEditResult } from "../src/components/chat/tool-results";
import { BeforeAfter } from "../src/components/excel/ChangeNavigator";
import type { ChangeEntry } from "../src/lib/session/types";
import { readComparisonSnapshot } from "../src/lib/workbook/change-reads";

let serial = 0;
beforeEach(() => {
  serial++;
  h.workspaceId = `ws-${serial}`;
  h.docId = `doc-${serial}`;
  h.currentRev = 10;
  h.activeDoc = true;
  h.effects = [];
  h.deps = [];
  h.before
    .mockReset()
    .mockResolvedValue({ cells: [{ row: 0, col: 0, sheet: "Sheet1", value: "old" }] });
  h.snapshot.mockReset().mockResolvedValue({ document: { rev: 10 }, snapshot: { sheets: {} } });
});
function showNavigation() {
  h.effects = [];
  renderToString(
    createElement(BeforeAfter, {
      workspaceId: h.workspaceId,
      docId: h.docId,
      rev: 10,
      range: "Sheet1!A1",
    }),
  );
  return h.effects[0]();
}
function showTool(runEffect = true) {
  h.effects = [];
  h.deps = [];
  const change: ChangeEntry = {
    docId: h.docId,
    rev: 10,
    path: "file.xlsx",
    toolCallId: "tool",
    ranges: ["Sheet1!A1"],
    cells: 1,
    structural: [],
    agentId: "main",
    seq: 1,
  };
  renderToString(createElement(WorkbookEditResult, { change }));
  return runEffect ? h.effects[0]() : undefined;
}
function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("tool and navigation comparisons share concurrent before and current reads", async () => {
  const before = deferred(),
    snapshot = deferred();
  h.before.mockReturnValue(before.promise);
  h.snapshot.mockReturnValue(snapshot.promise);
  const closeNav = showNavigation(),
    closeTool = showTool();
  expect(h.before).toHaveBeenCalledTimes(1);
  expect(h.snapshot).toHaveBeenCalledTimes(1);
  closeNav?.();
  closeTool?.();
  before.resolve({ cells: [] });
  snapshot.resolve({ snapshot: {} });
  await Promise.all([before.promise, snapshot.promise]);
});
test("a completed current snapshot is read again on a later opening", async () => {
  showNavigation();
  await Promise.resolve();
  await Promise.resolve();
  showTool();
  expect(h.before).toHaveBeenCalledTimes(1);
  expect(h.snapshot).toHaveBeenCalledTimes(2);
});
test("new revisions never join an older in-flight snapshot", async () => {
  const old = deferred();
  h.snapshot.mockReturnValueOnce(old.promise);
  const close = showNavigation();
  h.currentRev = 11;
  showNavigation();
  expect(h.snapshot).toHaveBeenCalledTimes(2);
  close?.();
  old.resolve({ snapshot: {} });
  await old.promise;
});
test("failed shared reads are released so reopening genuinely retries", async () => {
  h.before.mockRejectedValueOnce(new Error("before unavailable"));
  h.snapshot.mockRejectedValueOnce(new Error("snapshot unavailable"));
  showNavigation();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  showTool();
  expect(h.before).toHaveBeenCalledTimes(2);
  expect(h.snapshot).toHaveBeenCalledTimes(2);
});

test("different workspaces and documents keep separate comparison requests", async () => {
  const pending = deferred();
  h.before.mockReturnValue(pending.promise);
  h.snapshot.mockReturnValue(pending.promise);
  const first = showNavigation();
  h.workspaceId += "-other";
  const second = showTool();
  h.docId += "-other";
  const third = showNavigation();
  expect(h.before).toHaveBeenCalledTimes(3);
  expect(h.snapshot).toHaveBeenCalledTimes(3);
  expect(new Set(h.snapshot.mock.calls.map((args) => JSON.stringify(args))).size).toBe(3);
  first?.();
  second?.();
  third?.();
  pending.resolve({ cells: [], snapshot: {} });
  await pending.promise;
});

test("an explicit retry starts a fresh snapshot and an older completion cannot clear it", async () => {
  const old = deferred(),
    fresh = deferred();
  h.snapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = readComparisonSnapshot(h.workspaceId, h.docId, 10);
  const retry = readComparisonSnapshot(h.workspaceId, h.docId, 10, true);
  expect(h.snapshot).toHaveBeenCalledTimes(2);
  old.resolve({ snapshot: {} });
  await first;
  expect(readComparisonSnapshot(h.workspaceId, h.docId, 10)).toBe(retry);
  expect(h.snapshot).toHaveBeenCalledTimes(2);
  fresh.resolve({ snapshot: {} });
  await retry;
});

test("closing the active workbook does not schedule a redundant tool comparison read", () => {
  showTool(false);
  const deps = h.deps[0];
  h.activeDoc = false;
  showTool(false);
  expect(h.deps[0]).toEqual(deps);
});
