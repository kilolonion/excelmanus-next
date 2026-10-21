import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSessionLog: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({
  onSync: vi.fn(),
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
}));

import { loadChatSession, useChatStore } from "../src/stores/chat-store";

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState(useChatStore.getInitialState());
});
test("session detail starts alongside history instead of waiting for slow log pagination", async () => {
  let finish!: (value: { items: never[] }) => void;
  mocks.getSessionLog.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mocks.getSession.mockResolvedValue({
    session: { workspaceId: "ws", permissionMode: "standard", title: "test" },
    headSeq: 0,
    agents: [],
  });
  const loading = loadChatSession("session");
  expect(mocks.getSession).toHaveBeenCalledWith("session");
  finish({ items: [] });
  await loading;
  expect(useChatStore.getState()).toMatchObject({ workspaceId: "ws", loading: false });
});

test("switching conversations clears the previous workspace until the new detail is ready", async () => {
  useChatStore.setState({ sessionId: "old", workspaceId: "old-workspace" });
  let finish!: (value: { items: never[] }) => void;
  mocks.getSessionLog.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mocks.getSession.mockResolvedValue({
    session: { workspaceId: "new-workspace", permissionMode: "standard", title: "new" },
    headSeq: 0,
    agents: [],
  });
  const loading = loadChatSession("new");
  expect(useChatStore.getState().workspaceId).toBeNull();
  finish({ items: [] });
  await loading;
  expect(useChatStore.getState().workspaceId).toBe("new-workspace");
});

test("switching conversations stops the old history from requesting another page", async () => {
  let finish!: (value: { items: { seq: number; type: string; agentId: string }[] }) => void;
  mocks.getSessionLog
    .mockReset()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ items: [] });
  mocks.getSession.mockResolvedValue({
    session: { workspaceId: "ws", permissionMode: "standard", title: "test" },
    headSeq: 0,
    agents: [],
  });
  const old = loadChatSession("old");
  await loadChatSession("new");
  finish({ items: [{ seq: 20, type: "session.created", agentId: "main" }] });
  await old;
  expect(mocks.getSessionLog).toHaveBeenCalledTimes(2);
  expect(useChatStore.getState().sessionId).toBe("new");
});

test("clearing the conversation cancels subsequent history pages", async () => {
  const { clearChatSession } = await import("../src/stores/chat-store");
  let finish!: (value: { items: { seq: number; type: string; agentId: string }[] }) => void;
  mocks.getSessionLog
    .mockReset()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ items: [] });
  mocks.getSession.mockResolvedValue({
    session: { workspaceId: "ws", permissionMode: "standard", title: "test" },
    headSeq: 0,
    agents: [],
  });
  const old = loadChatSession("old");
  clearChatSession();
  finish({ items: [{ seq: 20, type: "session.created", agentId: "main" }] });
  await old;
  expect(mocks.getSessionLog).toHaveBeenCalledTimes(1);
  expect(useChatStore.getState().sessionId).toBeNull();
});

test("loading older history stops pagination after leaving the conversation", async () => {
  const { clearChatSession, loadOlderChat } = await import("../src/stores/chat-store");
  mocks.getSessionLog.mockReset().mockResolvedValueOnce({
    items: [
      {
        sessionId: "old",
        agentId: "main",
        seq: 20,
        type: "user.message",
        data: { dispatchId: "d", text: "hello" },
        createdAt: "2026-10-17T00:00:00Z",
      },
      {
        sessionId: "old",
        agentId: "main",
        seq: 21,
        type: "turn.started",
        data: { turnId: "t" },
        createdAt: "2026-10-17T00:00:00Z",
      },
    ],
  });
  mocks.getSession.mockResolvedValue({
    session: { workspaceId: "ws", permissionMode: "standard", title: "test" },
    headSeq: 21,
    agents: [],
  });
  await loadChatSession("old");
  expect(useChatStore.getState().hasOlder).toBe(true);
  let finish!: (value: { items: { seq: number; type: string; agentId: string }[] }) => void;
  mocks.getSessionLog
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ items: [] });
  const loading = loadOlderChat();
  clearChatSession();
  finish({ items: [{ seq: 10, type: "session.created", agentId: "main" }] });
  await loading;
  expect(mocks.getSessionLog).toHaveBeenCalledTimes(2);
  expect(useChatStore.getState().sessionId).toBeNull();
});
