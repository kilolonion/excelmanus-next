import type { LogRecord, ServerMessage } from "@excelmanus/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionHistoryWindow: vi.fn(),
  getSessionLog: vi.fn(),
  sync: null as null | ((message: ServerMessage) => void),
}));
vi.mock("@/lib/backend/api", () => ({ api: () => m, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({
  onSync: (fn: (message: ServerMessage) => void) => {
    m.sync = fn;
  },
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
}));

import {
  clearChatSession,
  loadChatSession,
  loadOlderChat,
  useChatStore,
} from "../src/stores/chat-store";

function record(seq: number): LogRecord {
  return {
    seq,
    type: "model.output",
    sessionId: "old",
    agentId: "main",
    createdAt: "2026-10-18T00:00:00Z",
    data: { stepId: `step${seq}`, text: `text${seq}` },
  };
}
function sliced() {
  vi.useFakeTimers();
  let time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (time += 9));
}
async function reachReplay() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
}
beforeEach(() => {
  clearChatSession();
  m.getSessionLog.mockReset();
  m.getSessionHistoryWindow.mockResolvedValue({
    kind: "overflow",
    headSeq: 128,
    reason: "records",
  });
  m.getSession.mockReset().mockResolvedValue({
    session: { workspaceId: "ws", permissionMode: "standard", title: "old" },
    headSeq: 128,
    agents: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearChatSession();
});
test("switching during initial replay cannot publish the old session", async () => {
  sliced();
  m.getSessionLog
    .mockResolvedValueOnce({ items: Array.from({ length: 128 }, (_, i) => record(i + 1)) })
    .mockResolvedValue({ items: [] });
  const loading = loadChatSession("old");
  await reachReplay();
  m.getSession.mockResolvedValue({
    session: { workspaceId: "new-ws", permissionMode: "standard", title: "new" },
    headSeq: 0,
    agents: [],
  });
  m.getSessionHistoryWindow.mockResolvedValue({
    kind: "overflow",
    headSeq: 0,
    reason: "records",
  });
  await loadChatSession("new");
  await vi.runAllTimersAsync();
  await loading;
  expect(useChatStore.getState()).toMatchObject({
    sessionId: "new",
    workspaceId: "new-ws",
    loading: false,
    session: { cursor: 0, title: "new" },
  });
});
async function older() {
  const recent = [
    { ...record(128), type: "user.message" as const, data: { dispatchId: "d", text: "question" } },
    { ...record(129), type: "turn.started" as const, data: { turnId: "turn" } },
  ];
  m.getSessionLog.mockResolvedValueOnce({ items: recent });
  m.getSession.mockResolvedValue({
    session: { workspaceId: "ws", permissionMode: "standard", title: "old" },
    headSeq: 129,
    agents: [],
  });
  m.getSessionHistoryWindow.mockResolvedValue({
    kind: "overflow",
    headSeq: 129,
    reason: "records",
  });
  await loadChatSession("old");
  m.getSessionLog.mockResolvedValueOnce({
    items: Array.from({ length: 127 }, (_, i) => record(i + 1)),
  });
  sliced();
  const loading = loadOlderChat();
  await reachReplay();
  return { loading };
}
test("older replay keeps records received while yielding", async () => {
  const { loading } = await older();
  const latest = record(130);
  m.sync?.({ type: "rec", topic: "session:old", seq: 130, record: latest });
  await vi.runAllTimersAsync();
  await loading;
  const state = useChatStore.getState();
  expect(state.session.cursor).toBe(130);
  expect(state.loadingOlder).toBe(false);
  expect(JSON.stringify(state.session.timelines)).toContain("text130");
});
test("closing while replaying older history leaves the cleared view untouched", async () => {
  const { loading } = await older();
  clearChatSession();
  await vi.runAllTimersAsync();
  await loading;
  expect(useChatStore.getState()).toMatchObject({
    sessionId: null,
    workspaceId: null,
    loadingOlder: false,
    session: { cursor: 0 },
  });
});
