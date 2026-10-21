import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listSessions: vi.fn(), listWorkspaces: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks }));
vi.mock("@/lib/backend/channel", () => ({ onSync: vi.fn() }));
vi.mock("@/stores/chat-store", async () => {
  const { create } = await import("zustand");
  return {
    useChatStore: create(() => ({ sessionId: null })),
    clearChatSession: vi.fn(),
    loadChatSession: vi.fn(),
  };
});

import { refreshWorkspaces, useAppStore } from "../src/stores/app-store";
import { refreshSessions, useSessionStore } from "../src/stores/session-store";

function pending() {
  let resolve!: (value: { items: never[] }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ items: never[] }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.listSessions.mockReset();
  mocks.listWorkspaces.mockReset();
  useSessionStore.setState({ sessions: [], listLoaded: false });
  useAppStore.setState({ workspaces: [] });
});
for (const [label, refresh, mock] of [
  ["sessions", refreshSessions, mocks.listSessions],
  ["workspaces", refreshWorkspaces, mocks.listWorkspaces],
] as const) {
  test(`${label}: startup caller waits for a newer pending refresh instead of observing empty state`, async () => {
    const first = pending(),
      latest = pending();
    mock.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    let done = false;
    const original = refresh().then(() => {
      done = true;
    });
    const newer = refresh();
    first.resolve({ items: [] });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const completedBeforeLatest = done;
    latest.resolve({ items: [{ id: "known", workspaceId: "ws", lastSeq: 1 }] as never[] });
    await Promise.all([original, newer]);
    expect(completedBeforeLatest).toBe(false);
    expect(done).toBe(true);
  });
  test(`${label}: a superseded read failure does not fail startup after a newer successful refresh`, async () => {
    const first = pending();
    mock.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ items: [] });
    const original = refresh();
    const checked = expect(original).resolves.toEqual([]);
    await refresh();
    first.reject(new Error("stale read failed"));
    await checked;
  });
}
