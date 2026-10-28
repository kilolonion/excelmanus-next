import { beforeEach, expect, test, vi } from "vitest";
const h = vi.hoisted(() => ({
  states: [] as any[],
  memos: [] as any[],
  si: 0,
  mi: 0,
  sessions: [] as any[],
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  return {
    ...r,
    useEffect: () => {},
    useRef: (v: unknown) => ({ current: v }),
    useCallback: (fn: unknown) => fn,
    useState: (initial: any) => {
      const i = h.si++;
      if (!(i in h.states)) h.states[i] = typeof initial === "function" ? initial() : initial;
      return [
        h.states[i],
        (v: any) => {
          h.states[i] = typeof v === "function" ? v(h.states[i]) : v;
        },
      ];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.mi++,
        old = h.memos[i];
      if (old && deps.every((v, j) => Object.is(v, old.deps[j]))) return old.value;
      const value = fn();
      h.memos[i] = { deps, value };
      return value;
    },
  };
});
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (s: any) => s({ sessions: h.sessions, activeWorkspaceId: "ws" }),
  selectSession: vi.fn(),
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: (s: any) => s({ doc: { docId: "doc", rev: 50 }, workspaceId: "ws" }),
}));
vi.mock("@/stores/chat-store", () => ({ useChatStore: (s: any) => s({ workspaceId: "ws" }) }));
vi.mock("@/stores/ui-store", () => ({ useUIStore: () => null }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (s: any) => s({ workspaces: [{ id: "ws", name: "QA", isDefault: true }] }),
  onAppEvent: () => () => {},
  removeWorkspace: vi.fn(),
  setDefaultWorkspace: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({
  api: () => ({}),
  desktop: () => null,
  ApiError: class extends Error {},
  errorMessage: String,
}));
vi.mock("../src/components/sidebar/session-file-marks", () => ({
  useSessionFileMarks: () => new Map(),
  SESSION_MARK_LABEL: {},
}));
vi.mock("../src/components/sidebar/file-actions", () => ({
  deleteBackupWithConfirm: vi.fn(),
  listFileBackups: vi.fn(),
  restoreBackupWithConfirm: vi.fn(),
  saveBackupAs: vi.fn(),
}));
import { RevisionHistory } from "../src/components/excel/RevisionHistory";
import { WorkspaceTab } from "../src/components/settings/WorkspaceTab";
import { BackupRow, FileInfoDialog } from "../src/components/sidebar/FileInfoDialog";
function nodes(node: any, p: (n: any) => boolean): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n, p));
  return [...(p(node) ? [node] : []), ...nodes(node.props?.children, p)];
}
function reset() {
  h.si = 0;
  h.mi = 0;
}
function revision() {
  reset();
  h.states[0] = true;
  const root = RevisionHistory();
  const child = nodes(root, (n) => n.props?.docId === "doc")[0];
  return child.type(child.props);
}
function backups() {
  reset();
  const root = WorkspaceTab();
  const child = nodes(root, (n) => n.type?.name === "BackupPanel")[0];
  return child.type(child.props);
}
const stamp = "2026-10-18T00:00:00Z";
function entry(i: number) {
  return {
    id: String(i),
    kind: "backup",
    originalPath: `qa-${i}.xlsx`,
    createdAt: stamp,
    size: 1024,
    sessionId: "last",
    sourceKind: "agent",
  };
}
beforeEach(() => {
  h.states = [];
  h.memos = [];
  h.sessions = [];
  vi.restoreAllMocks();
});
test("revision rows share date formatter and session lookup preparation", () => {
  let reads = 0;
  h.sessions = Array.from({ length: 1000 }, (_, i) => ({
    get id() {
      reads++;
      return i === 999 ? "last" : String(i);
    },
    title: "Title",
  }));
  revision();
  h.states[1] = Array.from({ length: 50 }, (_, i) => ({
    rev: i + 1,
    createdAt: stamp,
    source: { kind: "agent" },
    reverts: null,
    revertedBy: null,
    sessionId: "last",
    changes: { ranges: ["Sheet1!A1"], structural: [], added: [], cellsBySheet: { Sheet1: 1 } },
  }));
  const locale = vi.spyOn(Date.prototype, "toLocaleString"),
    formatter = vi.spyOn(Intl, "DateTimeFormat");
  reads = 0;
  revision();
  expect(locale.mock.calls.length).toBe(0);
  expect(formatter).toHaveBeenCalledTimes(1);
  expect(reads).toBeLessThanOrEqual(1000);
  reads = 0;
  h.states[3] = 3;
  revision();
  expect(reads).toBe(0);
  locale.mockRestore();
  formatter.mockRestore();
});
test("revision summaries skip unused cell totals and reuse unchanged details", () => {
  let reads = 0;
  revision();
  h.states[1] = [
    {
      rev: 1,
      createdAt: stamp,
      source: { kind: "user" },
      reverts: null,
      revertedBy: null,
      changes: {
        ranges: ["Sheet1!A1"],
        structural: [],
        added: [],
        get cellsBySheet() {
          reads++;
          return { Sheet1: 100 };
        },
      },
    },
  ];
  revision();
  expect(reads).toBe(0);
  h.states[3] = 1;
  revision();
  expect(reads).toBe(0);
});
test("workspace backup list creates one formatter for all timestamps", () => {
  backups();
  h.states[2] = Array.from({ length: 100 }, (_, i) => entry(i));
  h.states[3] = false;
  const locale = vi.spyOn(Date.prototype, "toLocaleString"),
    formatter = vi.spyOn(Intl, "DateTimeFormat");
  backups();
  expect(locale.mock.calls.length).toBe(0);
  expect(formatter).toHaveBeenCalledTimes(1);
  locale.mockRestore();
  formatter.mockRestore();
});
test("file backup rows share source-session lookup and the parent date formatter", () => {
  let reads = 0;
  h.sessions = Array.from({ length: 1000 }, (_, i) => ({
    get id() {
      reads++;
      return i === 999 ? "last" : String(i);
    },
    title: "Source",
  }));
  reset();
  h.states[0] = Array.from({ length: 50 }, (_, i) => entry(i));
  const locale = vi.spyOn(Date.prototype, "toLocaleString"),
    formatter = vi.spyOn(Intl, "DateTimeFormat");
  const root = FileInfoDialog({
    entry: { path: "qa.xlsx", name: "qa.xlsx", kind: "file", size: 1, modifiedAt: stamp } as never,
    onOpenChange: vi.fn(),
  });
  for (const row of nodes(root, (n) => n.type === BackupRow)) BackupRow(row.props);
  expect(locale.mock.calls.length).toBe(0);
  expect(formatter).toHaveBeenCalledTimes(1);
  expect(reads).toBeLessThanOrEqual(1000);
  locale.mockRestore();
  formatter.mockRestore();
});

test("refreshed revision rows and source-session titles replace the cached display", () => {
  h.sessions = [{ id: "last", title: "Old title" }];
  revision();
  h.states[1] = [
    {
      rev: 1,
      createdAt: stamp,
      source: { kind: "agent" },
      reverts: null,
      revertedBy: null,
      sessionId: "last",
      changes: { ranges: ["Sheet1!A1"], structural: [], added: [], cellsBySheet: { Sheet1: 1 } },
    },
  ];
  expect(JSON.stringify(revision())).toContain("Old title");
  h.sessions = [{ id: "last", title: "New title" }];
  h.states[1] = [
    {
      ...h.states[1][0],
      rev: 2,
      changes: { ranges: [], structural: [], added: [], cellsBySheet: { Sheet1: 7 } },
    },
  ];
  const output = JSON.stringify(revision());
  expect(output).toContain("New title");
  expect(output).toContain("7 个单元格");
  expect(output).not.toContain("Sheet1!A1");
});
