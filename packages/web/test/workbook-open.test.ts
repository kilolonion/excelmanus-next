import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDoc: vi.fn(),
  loadSurface: vi.fn(),
  toast: vi.fn(),
  getDocSnapshot: vi.fn(),
  resolveDocExternal: vi.fn(),
  importLegacy: vi.fn(),
  confirmAction: vi.fn(),
  loadDir: vi.fn(),
  moveEntry: vi.fn(),
  moveEntries: vi.fn(),
  sendSync: vi.fn(),
  sync: [] as Array<(message: never) => void>,
  connection: null as ((connected: boolean) => void) | null,
}));
vi.mock("@/lib/workbook/load-surface", () => ({ loadWorkbookSurface: mocks.loadSurface }));
vi.mock("@/lib/backend/api", () => ({
  api: () => mocks,
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/lib/backend/channel", () => ({
  onSync: (listener: (message: never) => void) => {
    mocks.sync.push(listener);
  },
  onConnection: (listener: (connected: boolean) => void) => {
    mocks.connection = listener;
  },
  sendSync: mocks.sendSync,
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
  syncConnectionId: vi.fn(),
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmAction: mocks.confirmAction }));
vi.mock("@/stores/files-store", () => ({
  loadDir: mocks.loadDir,
  moveEntry: mocks.moveEntry,
  moveEntries: mocks.moveEntries,
  useFilesStore: { getState: () => ({ workspaceId: "ws" }) },
}));
vi.mock("@/stores/session-store", async () => {
  const { create } = await import("zustand");
  return { useSessionStore: create(() => ({ activeWorkspaceId: "ws" })) };
});
vi.mock("@/stores/chat-store", async () => {
  const { create } = await import("zustand");
  return { useChatStore: create(() => ({ sessionId: null, session: { cursor: 0 } })) };
});

import { activateTab, openWorkbook, useWorkbookStore } from "../src/stores/workbook-store.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.loadSurface.mockResolvedValue({ default: () => null });
  useWorkbookStore.setState({ workspaceId: "ws", doc: null, tabs: [], activePath: null });
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  mocks.openDoc.mockResolvedValue({ document: { id: "doc" } });
  mocks.getDocSnapshot.mockResolvedValue({
    document: { id: "doc", path: "reports/a.xlsx", kind: "xlsx", rev: 1 },
    snapshot: {},
  });
  mocks.loadDir.mockResolvedValue([]);
  mocks.confirmAction.mockResolvedValue(true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("opening a workbook refreshes its parent directory metadata", async () => {
  await openWorkbook("reports/a.xlsx");
  expect(mocks.loadDir).toHaveBeenCalledWith("reports");
  expect(useWorkbookStore.getState().doc?.docId).toBe("doc");
});

test("activating a saved document tab records a fresh open before reading its snapshot", async () => {
  useWorkbookStore.setState({ tabs: [{ path: "reports/a.xlsx", docId: "doc" }] });
  await activateTab("reports/a.xlsx");
  expect(mocks.openDoc).toHaveBeenCalledWith("ws", { path: "reports/a.xlsx" });
  expect(mocks.loadDir).toHaveBeenCalledWith("reports");
});

test("moving a workbook keeps all open tabs, active document and selection", async () => {
  const store = await import("../src/stores/workbook-store.ts");
  await openWorkbook("reports/a.xlsx");
  const selection = { docId: "doc", rev: 1, range: "Sheet1!B2" };
  useWorkbookStore.setState({
    tabs: [
      { path: "reports/a.xlsx", docId: "doc" },
      { path: "other.xlsx", docId: "other" },
    ],
    selection,
  });
  expect(store.relocateWorkbook).toBeTypeOf("function");
  store.relocateWorkbook("reports/a.xlsx", "归档/新名称.xlsx");
  const state = useWorkbookStore.getState();
  expect(state.tabs).toEqual([
    { path: "归档/新名称.xlsx", docId: "doc" },
    { path: "other.xlsx", docId: "other" },
  ]);
  expect(state.activePath).toBe("归档/新名称.xlsx");
  expect(state.doc).toMatchObject({ path: "归档/新名称.xlsx", docId: "doc", rev: 1 });
  expect(state.selection).toEqual(selection);
});

test("the workbook store marks unacknowledged edits uncertain on disconnect and does not resend on reconnect", async () => {
  const store = await import("../src/stores/workbook-store.ts");
  await openWorkbook("reports/a.xlsx");
  mocks.sendSync.mockReturnValue(true);
  const mutation = { id: "sheet.mutation.insert-row", params: { at: 3 } };
  expect(store.submitDocumentMutations("doc", [mutation])).toBe(true);
  expect(Object.values(useWorkbookStore.getState().docSync.pending)[0]?.status).toBe("pending");
  mocks.connection!(false);
  expect(Object.values(useWorkbookStore.getState().docSync.pending)[0]).toMatchObject({
    status: "rejected",
    conflict: { code: "connection_lost" },
    submitted: { mutation },
  });
  const calls = mocks.sendSync.mock.calls.length;
  mocks.connection!(true);
  expect(mocks.sendSync).toHaveBeenCalledTimes(calls);
});

test("reopening restores cell drafts and uncertain operations, while dismissal removes recovery data", async () => {
  const store = await import("../src/stores/workbook-store.ts");
  await openWorkbook("reports/a.xlsx");
  store.setInputDraft("doc", { sheetId: "s1", row: 1, col: 2, text: "刷新前的输入", baseRev: 1 });
  mocks.sendSync.mockReturnValue(true);
  store.submitDocumentMutations("doc", [{ id: "sheet.mutation.insert-row", params: { at: 3 } }]);
  const count = mocks.sendSync.mock.calls.length;
  store.closeAllWorkbooks();
  await openWorkbook("reports/a.xlsx");
  const state = useWorkbookStore.getState();
  expect(state.recoveredDrafts[0]).toMatchObject({
    docId: "doc",
    text: "刷新前的输入",
    source: "recovery",
  });
  expect(Object.values(state.docSync.pending)[0]).toMatchObject({
    conflict: { code: "connection_lost" },
  });
  expect(mocks.sendSync).toHaveBeenCalledTimes(count);
  store.dismissRecoveredDraft(state.recoveredDrafts[0]);
  store.dismissDocConflict(Object.keys(state.docSync.pending)[0]);
  store.closeAllWorkbooks();
  await openWorkbook("reports/a.xlsx");
  expect(useWorkbookStore.getState().recoveredDrafts).toEqual([]);
  expect(useWorkbookStore.getState().docSync.pending).toEqual({});
});

function deferredSnapshot() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const snapshotFor = (path: string) => ({
  document: { id: path, path, kind: "xlsx", rev: 1 },
  snapshot: { sheets: { s1: { name: "Sheet1" } } },
});

test("late docId lookup cannot reopen an old workbook after the user opens another", async () => {
  const { openWorkbookById } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) =>
    id === "slow-id" ? pending.promise : snapshotFor(id),
  );
  const old = openWorkbookById("slow-id");
  await openWorkbook("new.xlsx");
  pending.resolve(snapshotFor("old.xlsx"));
  await old;
  expect(useWorkbookStore.getState().doc?.path).toBe("new.xlsx");
  expect(mocks.openDoc).not.toHaveBeenCalledWith("ws", { path: "old.xlsx" });
});

test("a superseded open cannot focus its range in the newly opened workbook", async () => {
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) =>
    id === "old.xlsx" ? pending.promise : snapshotFor(id),
  );
  useWorkbookStore.setState({ rangeFocus: null });
  const old = openWorkbook("old.xlsx", { focus: "Sheet1!B2" });
  await openWorkbook("new.xlsx");
  pending.resolve(snapshotFor("old.xlsx"));
  await old;
  expect(useWorkbookStore.getState().doc?.path).toBe("new.xlsx");
  expect(useWorkbookStore.getState().rangeFocus).toBeNull();
});

test("reference navigation never highlights its range in a different document", async () => {
  const { focusRange } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) =>
    id === "old.xlsx" ? pending.promise : snapshotFor(id),
  );
  useWorkbookStore.setState({ rangeFocus: null });
  const locating = focusRange("Sheet1!C3", { path: "old.xlsx" });
  await openWorkbook("new.xlsx");
  pending.resolve(snapshotFor("old.xlsx"));
  await locating;
  expect(useWorkbookStore.getState().rangeFocus).toBeNull();
});

test("a stale docId lookup failure does not show an error on the new workbook", async () => {
  const { focusRange } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) =>
    id === "old-id" ? pending.promise : snapshotFor(id),
  );
  const locating = focusRange("Sheet1!C3", { docId: "old-id" });
  await openWorkbook("new.xlsx");
  pending.reject(new Error("old lookup failed"));
  await locating;
  expect(useWorkbookStore.getState().referenceError).toBeNull();
  expect(mocks.toast).not.toHaveBeenCalledWith(
    expect.objectContaining({ title: "工作簿打开失败" }),
  );
});

test("range question cannot highlight a different workbook after a late open", async () => {
  const { startRangeQuestion } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) =>
    id === "old.xlsx" ? pending.promise : snapshotFor(id),
  );
  const question = startRangeQuestion({
    questionId: "q",
    mode: "confirm",
    prompt: "确认区域",
    path: "old.xlsx",
    suggested: "Sheet1!C3",
  });
  await openWorkbook("new.xlsx");
  pending.resolve(snapshotFor("old.xlsx"));
  await question;
  expect(useWorkbookStore.getState().rangeFocus).toBeNull();
  expect(useWorkbookStore.getState().rangeQuestion).toBeNull();
});

test("a cancelled range question cannot restore its highlight when loading finishes", async () => {
  const { startRangeQuestion, endRangeQuestion } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockReturnValueOnce(pending.promise);
  const question = startRangeQuestion({
    questionId: "q",
    mode: "confirm",
    prompt: "确认区域",
    path: "old.xlsx",
    suggested: "Sheet1!C3",
  });
  endRangeQuestion("q");
  pending.resolve(snapshotFor("old.xlsx"));
  await question;
  expect(useWorkbookStore.getState().rangeFocus).toBeNull();
  expect(useWorkbookStore.getState().rangeQuestion).toBeNull();
});

test("an active range question still focuses its intended document", async () => {
  const { startRangeQuestion } = await import("../src/stores/workbook-store.ts");
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  await startRangeQuestion({
    questionId: "q",
    mode: "confirm",
    prompt: "确认区域",
    path: "target.xlsx",
    suggested: "Sheet1!C3",
  });
  expect(useWorkbookStore.getState().rangeQuestion?.questionId).toBe("q");
  expect(useWorkbookStore.getState().rangeFocus?.range).toBe("Sheet1!C3");
});

test("a failed obsolete reload is ignored after switching workbooks", async () => {
  const { reloadDocument } = await import("../src/stores/workbook-store.ts");
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  await openWorkbook("old.xlsx");
  const pending = deferredSnapshot();
  mocks.getDocSnapshot.mockReturnValueOnce(pending.promise);
  const reloading = reloadDocument();
  const settled = expect(reloading).resolves.toBeUndefined();
  await openWorkbook("new.xlsx");
  pending.reject(new Error("old refresh failed"));
  await settled;
  expect(useWorkbookStore.getState().doc?.path).toBe("new.xlsx");
});

test("resolving an old external conflict cannot reload or clear the new workbook selection", async () => {
  const { resolveExternal, setSelection } = await import("../src/stores/workbook-store.ts");
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  await openWorkbook("old.xlsx");
  const pending = deferredSnapshot();
  mocks.resolveDocExternal.mockReturnValueOnce(pending.promise);
  const resolving = resolveExternal("keepApp");
  await openWorkbook("new.xlsx");
  setSelection("Sheet1!D4");
  const reads = mocks.getDocSnapshot.mock.calls.length;
  pending.resolve({ backupPath: "old-backup.xlsx" });
  expect(await resolving).toBe("old-backup.xlsx");
  expect(mocks.getDocSnapshot).toHaveBeenCalledTimes(reads);
  expect(useWorkbookStore.getState().selection?.range).toBe("Sheet1!D4");
});

test("a current workbook reload failure is still reported", async () => {
  const { reloadDocument } = await import("../src/stores/workbook-store.ts");
  await openWorkbook("reports/a.xlsx");
  mocks.getDocSnapshot.mockRejectedValueOnce(new Error("current refresh failed"));
  await expect(reloadDocument()).rejects.toThrow("current refresh failed");
});

test("a completed legacy import does not take focus back from a newly opened workbook", async () => {
  const pending = deferredSnapshot();
  mocks.importLegacy.mockReturnValueOnce(pending.promise);
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  const importing = openWorkbook("old.xls");
  await Promise.resolve();
  await openWorkbook("new.xlsx");
  pending.resolve({ path: "converted.xlsx", warnings: [] });
  await importing;
  expect(useWorkbookStore.getState().doc?.path).toBe("new.xlsx");
  expect(mocks.openDoc).not.toHaveBeenCalledWith("ws", { path: "converted.xlsx" });
});

test("navigation during the post-import file refresh also cancels automatic opening", async () => {
  const pending = deferredSnapshot();
  mocks.importLegacy.mockResolvedValue({ path: "converted.xlsx", warnings: [] });
  mocks.loadDir.mockImplementation((path) => (path === "" ? pending.promise : Promise.resolve([])));
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  const importing = openWorkbook("old.xlsb");
  await Promise.resolve();
  await Promise.resolve();
  await openWorkbook("reports/new.xlsx");
  pending.resolve([]);
  await importing;
  expect(useWorkbookStore.getState().doc?.path).toBe("reports/new.xlsx");
});

test("an uninterrupted legacy import still opens the converted workbook", async () => {
  mocks.importLegacy.mockResolvedValue({ path: "converted.xlsx", warnings: [] });
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  await openWorkbook("old.xls");
  expect(mocks.importLegacy).toHaveBeenCalledWith(
    "ws",
    expect.objectContaining({ source: "old.xls" }),
  );
  expect(useWorkbookStore.getState().doc?.path).toBe("converted.xlsx");
});

test("background snapshot refresh does not cancel an otherwise current legacy import", async () => {
  const { reloadDocument } = await import("../src/stores/workbook-store.ts");
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  await openWorkbook("current.xlsx");
  const pending = deferredSnapshot();
  mocks.importLegacy.mockReturnValueOnce(pending.promise);
  const importing = openWorkbook("old.xls");
  await Promise.resolve();
  await reloadDocument();
  pending.resolve({ path: "converted.xlsx", warnings: [] });
  await importing;
  expect(useWorkbookStore.getState().doc?.path).toBe("converted.xlsx");
});

test("closing the panel during a docId lookup prevents reopening it", async () => {
  const { openWorkbookById, setPanelOpen } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  mocks.getDocSnapshot.mockReturnValueOnce(pending.promise);
  const opening = openWorkbookById("old-id");
  setPanelOpen(false);
  pending.resolve(snapshotFor("old.xlsx"));
  await opening;
  expect(useWorkbookStore.getState().panelOpen).toBe(false);
  expect(mocks.openDoc).not.toHaveBeenCalled();
});

test("closing the panel during reference loading prevents late focus from reopening it", async () => {
  const { focusRange, setPanelOpen } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockReturnValueOnce(pending.promise);
  const locating = focusRange("Sheet1!C3", { path: "old.xlsx" });
  setPanelOpen(false);
  pending.resolve(snapshotFor("old.xlsx"));
  await locating;
  expect(useWorkbookStore.getState().panelOpen).toBe(false);
  expect(useWorkbookStore.getState().rangeFocus).toBeNull();
});

test("late automatic tool-follow cannot focus its range on a manually opened workbook", async () => {
  const { useChatStore } = await import("../src/stores/chat-store");
  useChatStore.setState({ sessionId: "s", viewAgentId: "main" });
  useWorkbookStore.setState({ followAgent: true, rangeFocus: null });
  const { noteManualView } = await import("../src/stores/workbook-store.ts");
  noteManualView();
  await vi.advanceTimersByTimeAsync(6000);
  const pending = deferredSnapshot();
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) =>
    id === "old.xlsx" ? pending.promise : snapshotFor(id),
  );
  for (const listener of mocks.sync)
    listener({
      type: "rec",
      topic: "session:s",
      record: {
        type: "tool.intent",
        agentId: "main",
        createdAt: new Date().toISOString(),
        data: {
          toolName: "workbook_read",
          args: { path: "old.xlsx", sheet: "Sheet1", range: "C3" },
        },
      },
    } as never);
  await Promise.resolve();
  await openWorkbook("new.xlsx");
  pending.resolve(snapshotFor("old.xlsx"));
  await vi.advanceTimersByTimeAsync(0);
  expect(useWorkbookStore.getState().doc?.path).toBe("new.xlsx");
  expect(useWorkbookStore.getState().rangeFocus).toBeNull();
});

test("uninterrupted automatic tool-follow still opens and focuses its target", async () => {
  const { useChatStore } = await import("../src/stores/chat-store");
  useChatStore.setState({ sessionId: "s", viewAgentId: "main" });
  useWorkbookStore.setState({ followAgent: true, rangeFocus: null });
  const { noteManualView } = await import("../src/stores/workbook-store.ts");
  noteManualView();
  await vi.advanceTimersByTimeAsync(6000);
  mocks.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  mocks.getDocSnapshot.mockImplementation(async (_ws, id) => snapshotFor(id));
  for (const listener of mocks.sync)
    listener({
      type: "rec",
      topic: "session:s",
      record: {
        type: "tool.intent",
        agentId: "main",
        createdAt: new Date().toISOString(),
        data: {
          toolName: "workbook_read",
          args: { path: "auto.xlsx", sheet: "Sheet1", range: "C3" },
        },
      },
    } as never);
  await vi.advanceTimersByTimeAsync(0);
  expect(useWorkbookStore.getState().doc?.path).toBe("auto.xlsx");
  expect(useWorkbookStore.getState().rangeFocus?.range).toBe("Sheet1!C3");
});

test("late file rename cannot rename a same-path tab in another workspace", async () => {
  const { renameItem } = await import("../src/components/sidebar/file-actions");
  let finish!: () => void;
  mocks.moveEntry.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = renameItem("reports/a.xlsx", "renamed.xlsx");
  useWorkbookStore.setState({
    workspaceId: "another-workspace",
    tabs: [{ path: "reports/a.xlsx", docId: "other-doc" }],
    activePath: "reports/a.xlsx",
  });
  finish();
  expect(await pending).toBe(true);
  expect(useWorkbookStore.getState().tabs).toEqual([
    { path: "reports/a.xlsx", docId: "other-doc" },
  ]);
  expect(useWorkbookStore.getState().activePath).toBe("reports/a.xlsx");
});

test("late folder move does not relocate another workspace's tabs", async () => {
  const { moveInto } = await import("../src/components/sidebar/file-actions");
  let finish!: () => void;
  mocks.moveEntries.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = moveInto(["reports"], "archive");
  useWorkbookStore.setState({
    workspaceId: "another-workspace",
    tabs: [{ path: "reports/a.xlsx", docId: "other-doc" }],
    activePath: "reports/a.xlsx",
  });
  finish();
  await pending;
  expect(useWorkbookStore.getState().activePath).toBe("reports/a.xlsx");
});

test("successful rename still synchronizes tabs in its original workspace", async () => {
  const { renameItem } = await import("../src/components/sidebar/file-actions");
  mocks.moveEntry.mockResolvedValueOnce(["reports/renamed.xlsx"]);
  useWorkbookStore.setState({
    tabs: [{ path: "reports/a.xlsx", docId: "doc" }],
    activePath: "reports/a.xlsx",
  });
  expect(await renameItem("reports/a.xlsx", "renamed.xlsx")).toBe(true);
  expect(useWorkbookStore.getState().activePath).toBe("reports/renamed.xlsx");
});

test("a legacy import launched by a dismissed picker keeps the converted file without opening it", async () => {
  let current = true;
  let finish!: (value: { path: string; warnings: string[] }) => void;
  mocks.importLegacy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useWorkbookStore.setState({ panelOpen: false });
  const pending = openWorkbook("old.xls", { isCurrent: () => current });
  await vi.waitFor(() => expect(mocks.importLegacy).toHaveBeenCalledTimes(1));
  current = false;
  finish({ path: "old-converted.xlsx", warnings: [] });
  await pending;
  expect(mocks.openDoc).not.toHaveBeenCalled();
  expect(useWorkbookStore.getState().panelOpen).toBe(false);
});

test("declining legacy import reports that no workbook was opened", async () => {
  mocks.confirmAction.mockResolvedValueOnce(false);
  expect(await openWorkbook("old.xls")).toBe(false);
  expect(mocks.importLegacy).not.toHaveBeenCalled();
  expect(mocks.openDoc).not.toHaveBeenCalled();
});

test("a successful workbook open reports success to its picker", async () => {
  expect(await openWorkbook("reports/a.xlsx")).toBe(true);
});

test("a document lookup failure is visible, retains the open workbook, and can be retried", async () => {
  const { openWorkbookById } = await import("../src/stores/workbook-store.ts");
  await openWorkbook("reports/a.xlsx");
  mocks.getDocSnapshot.mockRejectedValueOnce(new Error("读取文档暂时失败"));
  await expect(openWorkbookById("retry-id")).resolves.toBeUndefined();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      tone: "error",
      title: "工作簿打开失败",
      description: "读取文档暂时失败",
    }),
  );
  expect(useWorkbookStore.getState().doc?.path).toBe("reports/a.xlsx");
  mocks.getDocSnapshot.mockResolvedValue(snapshotFor("retry.xlsx"));
  await openWorkbookById("retry-id");
  expect(useWorkbookStore.getState().doc?.path).toBe("retry.xlsx");
});

test("closing a workbook during open avoids downloading its stale snapshot", async () => {
  const { closeAllWorkbooks } = await import("../src/stores/workbook-store.ts");
  let finish!: (value: { document: { id: string } }) => void;
  mocks.openDoc.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const opening = openWorkbook("reports/a.xlsx");
  closeAllWorkbooks();
  finish({ document: { id: "doc" } });
  await opening;
  expect(mocks.getDocSnapshot).not.toHaveBeenCalled();
  expect(useWorkbookStore.getState().doc).toBeNull();
});

test("switching workspaces during open avoids downloading the old snapshot", async () => {
  let finish!: (value: { document: { id: string } }) => void;
  mocks.openDoc.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const opening = openWorkbook("reports/a.xlsx");
  useWorkbookStore.setState({ workspaceId: "other" });
  finish({ document: { id: "doc" } });
  await opening;
  expect(mocks.getDocSnapshot).not.toHaveBeenCalled();
});

test("queued remote edits already included in a refreshed snapshot are not replayed", async () => {
  const { registerDocumentEditor, reloadDocument } = await import(
    "../src/stores/workbook-store.ts"
  );
  registerDocumentEditor(null);
  await openWorkbook("reports/a.xlsx");
  let release!: () => void;
  const oldApply = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  registerDocumentEditor({ docId: "doc", applyRemote: oldApply });
  const emit = (rev: number) =>
    mocks.sync.forEach((listener) =>
      listener({
        type: "doc.op",
        docId: "doc",
        rev,
        source: "agent:main",
        mutations: [{ id: "test.mutation", params: {} }],
      } as never),
    );
  emit(2);
  await Promise.resolve();
  expect(oldApply).toHaveBeenCalledTimes(1);
  emit(3);
  mocks.getDocSnapshot.mockResolvedValueOnce({
    document: { id: "doc", path: "reports/a.xlsx", kind: "xlsx", rev: 3 },
    snapshot: {},
  });
  await reloadDocument();
  const newApply = vi.fn().mockResolvedValue(undefined);
  registerDocumentEditor({ docId: "doc", applyRemote: newApply });
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(newApply).not.toHaveBeenCalled();
  registerDocumentEditor(null);
});

test("remote edits newer than the loaded snapshot still replay in order", async () => {
  const { registerDocumentEditor } = await import("../src/stores/workbook-store.ts");
  registerDocumentEditor(null);
  await openWorkbook("reports/a.xlsx");
  const apply = vi.fn().mockResolvedValue(undefined);
  registerDocumentEditor({ docId: "doc", applyRemote: apply });
  for (const rev of [2, 3])
    mocks.sync.forEach((listener) =>
      listener({
        type: "doc.op",
        docId: "doc",
        rev,
        source: "agent:main",
        mutations: [{ id: `mutation-${rev}`, params: {} }],
      } as never),
    );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(apply.mock.calls.map((args) => args[0][0].id)).toEqual(["mutation-2", "mutation-3"]);
  registerDocumentEditor(null);
});


test("a pending snapshot refresh preserves a workbook rename completed meanwhile", async () => {
  const { reloadDocument, relocateWorkbook } = await import("../src/stores/workbook-store.ts");
  await openWorkbook("reports/a.xlsx");
  const pending = deferredSnapshot();
  mocks.getDocSnapshot.mockReturnValueOnce(pending.promise);
  const reloading = reloadDocument();
  relocateWorkbook("reports/a.xlsx", "reports/renamed.xlsx");
  pending.resolve({
    document: { id: "doc", path: "reports/a.xlsx", kind: "xlsx", rev: 2 },
    snapshot: { refreshed: true },
  });
  await reloading;
  expect(useWorkbookStore.getState().doc).toMatchObject({
    path: "reports/renamed.xlsx",
    rev: 2,
    snapshot: { refreshed: true },
  });
  expect(useWorkbookStore.getState().activePath).toBe("reports/renamed.xlsx");
});

test("opening by id reuses the lookup snapshot when open confirms the same document revision", async () => {
  const { openWorkbookById } = await import("../src/stores/workbook-store.ts");
  const first = snapshotFor("reuse.xlsx");
  mocks.getDocSnapshot.mockResolvedValue(first);
  mocks.openDoc.mockResolvedValue({ document: { ...first.document, checkpointRev: 1 } });
  await openWorkbookById("reuse.xlsx");
  expect(mocks.getDocSnapshot).toHaveBeenCalledTimes(1);
  expect(mocks.openDoc).toHaveBeenCalledWith("ws", { path: "reuse.xlsx" });
  expect(useWorkbookStore.getState().doc?.snapshot).toBe(first.snapshot);
  expect(useWorkbookStore.getState().doc?.checkpointRev).toBe(1);
});

test("opening by id rereads the snapshot if the revision advanced during open", async () => {
  const { openWorkbookById } = await import("../src/stores/workbook-store.ts");
  const first = snapshotFor("newer.xlsx");
  const newer = { document: { ...first.document, rev: 2 }, snapshot: { latest: true } };
  mocks.getDocSnapshot.mockResolvedValueOnce(first).mockResolvedValueOnce(newer);
  mocks.openDoc.mockResolvedValue({ document: newer.document });
  await openWorkbookById("newer.xlsx");
  expect(mocks.getDocSnapshot).toHaveBeenCalledTimes(2);
  expect(useWorkbookStore.getState().doc?.snapshot).toEqual({ latest: true });
  expect(useWorkbookStore.getState().doc?.rev).toBe(2);
});

test("opening by id never reuses the lookup snapshot for a different document id", async () => {
  const { openWorkbookById } = await import("../src/stores/workbook-store.ts");
  const first = snapshotFor("replaced.xlsx");
  const replacement = {
    document: { ...first.document, id: "replacement" },
    snapshot: { replacement: true },
  };
  mocks.getDocSnapshot.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
  mocks.openDoc.mockResolvedValue({ document: replacement.document });
  await openWorkbookById("replaced.xlsx");
  expect(mocks.getDocSnapshot).toHaveBeenLastCalledWith("ws", "replacement");
  expect(useWorkbookStore.getState().doc?.snapshot).toEqual({ replacement: true });
});

test("docId lookup overlaps workbook resources without opening the panel early or failing on preload error", async () => {
  const { openWorkbookById } = await import("../src/stores/workbook-store.ts");
  const pending = deferredSnapshot();
  useWorkbookStore.setState({ panelOpen: false });
  mocks.loadSurface.mockRejectedValueOnce(new Error("optional preload unavailable"));
  mocks.getDocSnapshot.mockReturnValueOnce(pending.promise);
  const opening = openWorkbookById("resource.xlsx");
  const startedEarly = mocks.loadSurface.mock.calls.length;
  const panelOpenedEarly = useWorkbookStore.getState().panelOpen;
  pending.resolve(snapshotFor("resource.xlsx"));
  mocks.openDoc.mockResolvedValue({ document: snapshotFor("resource.xlsx").document });
  await opening;
  expect(startedEarly).toBe(1);
  expect(panelOpenedEarly).toBe(false);
  expect(useWorkbookStore.getState().doc?.path).toBe("resource.xlsx");
});

