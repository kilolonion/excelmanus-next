import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  loadChatSession: vi.fn(),
  listSessions: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({
  onSync: vi.fn(),
  onConnection: vi.fn(),
  sendSync: vi.fn(),
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
  syncConnectionId: vi.fn(),
}));
vi.mock("@/stores/files-store", () => ({ loadDir: vi.fn() }));
vi.mock("@/stores/chat-store", async () => {
  const { create } = await import("zustand");
  return {
    clearChatSession: vi.fn(),
    loadChatSession: mocks.loadChatSession,
    useChatStore: create(() => ({
      sessionId: "old",
      loading: false,
      optimistic: [],
      session: { cursor: 0, timelines: {} },
    })),
  };
});

import { useChatStore } from "../src/stores/chat-store";
import {
  createSession,
  ensureActiveSession,
  openWorkspace,
  selectSession,
  useSessionStore,
} from "../src/stores/session-store";
import { composerMessageContext, useWorkbookStore } from "../src/stores/workbook-store";

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({
    activeSessionId: "old",
    activeWorkspaceId: "ws",
    sessions: [
      { id: "old", workspaceId: "ws", title: "空白", createdAt: "2026-10-16T00:00:00Z" } as never,
    ],
  });
  useChatStore.setState({
    sessionId: "old",
    loading: false,
    optimistic: [],
    session: { cursor: 0, timelines: {} } as never,
  });
  useWorkbookStore.setState({
    workspaceId: "ws",
    activePath: "a.xlsx",
    tabs: [{ path: "a.xlsx", docId: "a" }],
    doc: { path: "a.xlsx", docId: "a", rev: 3, snapshotRev: 3, kind: "xlsx", snapshot: {} },
    selection: { docId: "a", rev: 3, range: "Sheet1!A1" },
    pinnedSelection: { docId: "a", rev: 3, range: "Sheet1!B2" },
    panelOpen: true,
    fullView: true,
  });
  mocks.createSession.mockResolvedValue({ session: { id: "new", workspaceId: "ws" } });
  mocks.loadChatSession.mockResolvedValue({ workspaceId: "ws" });
});
afterEach(() => useWorkbookStore.setState(useWorkbookStore.getInitialState()));

function expectClean() {
  expect(useSessionStore.getState().activeWorkspaceId).toBe("ws");
  expect(useWorkbookStore.getState()).toMatchObject({
    activePath: null,
    doc: null,
    tabs: [],
    panelOpen: false,
    fullView: false,
    selection: null,
    pinnedSelection: null,
  });
  expect(composerMessageContext()).toEqual([]);
}

test("new conversation reusing an empty session still clears the previous workbook", async () => {
  expect(await createSession()).toBe("old");
  expect(mocks.createSession).not.toHaveBeenCalled();
  expectClean();
});

test("creating a session retains the workspace but clears selected, pinned and fullscreen workbook state", async () => {
  useChatStore.setState({ optimistic: [{ text: "已有消息" }] as never });
  expect(await createSession()).toBe("new");
  expect(mocks.createSession).toHaveBeenCalledWith({ workspaceId: "ws" });
  expectClean();
});

test("failed session creation does not discard the current workbook view", async () => {
  useChatStore.setState({ optimistic: [{ text: "已有消息" }] as never });
  mocks.createSession.mockRejectedValue(new Error("offline"));
  await expect(createSession()).rejects.toThrow("offline");
  expect(useWorkbookStore.getState().activePath).toBe("a.xlsx");
  expect(composerMessageContext()).toHaveLength(1);
});

test("switching to a known session updates the workspace before history finishes", async () => {
  let finish!: (value: { workspaceId: string }) => void;
  mocks.loadChatSession.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  useSessionStore.setState({ sessions: [{ id: "other", workspaceId: "next" } as never] });
  const loading = selectSession("other");
  expect(useSessionStore.getState().activeWorkspaceId).toBe("next");
  expect(useWorkbookStore.getState().doc).toBeNull();
  finish({ workspaceId: "next" });
  await loading;
});

test("a late new-session response does not take navigation back from a newer selection", async () => {
  useChatStore.setState({ optimistic: [{ text: "已有消息" }] as never });
  let finish!: (value: unknown) => void;
  mocks.createSession.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const creating = createSession();
  await selectSession("chosen");
  finish({ session: { id: "late", workspaceId: "ws" } });
  await creating;
  expect(useSessionStore.getState().activeSessionId).toBe("chosen");
  expect(mocks.loadChatSession).not.toHaveBeenCalledWith("late");
});

test("reusing a blank session cannot clear a workbook after navigation changes", async () => {
  useSessionStore.setState((s) => ({
    sessions: [...s.sessions, { id: "chosen", workspaceId: "ws" } as never],
  }));
  const creating = createSession();
  const selecting = selectSession("chosen");
  useWorkbookStore.setState({
    activePath: "chosen.xlsx",
    tabs: [{ path: "chosen.xlsx", docId: "chosen" }],
  });
  await Promise.all([creating, selecting]);
  expect(useWorkbookStore.getState().activePath).toBe("chosen.xlsx");
});

test("a slow empty-workspace creation cannot override a newer conversation", async () => {
  let finish!: (value: unknown) => void;
  mocks.createSession.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mocks.listSessions.mockResolvedValue({ items: [] });
  const opening = openWorkspace("empty");
  await selectSession("chosen");
  finish({ session: { id: "late", workspaceId: "empty" } });
  await opening;
  expect(useSessionStore.getState().activeSessionId).toBe("chosen");
  expect(mocks.loadChatSession).not.toHaveBeenCalledWith("late");
});

test("implicit session creation is cancelled if the user navigates before sending", async () => {
  useSessionStore.setState({ activeSessionId: null });
  let finish!: (value: unknown) => void;
  mocks.createSession.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const creating = ensureActiveSession();
  const rejected = expect(creating).rejects.toThrow("已切换对话");
  await selectSession("chosen");
  finish({ session: { id: "late", workspaceId: "ws" } });
  await rejected;
  expect(useSessionStore.getState().activeSessionId).toBe("chosen");
});
