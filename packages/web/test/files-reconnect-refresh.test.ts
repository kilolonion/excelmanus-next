import type { FileEntry, ServerMessage } from "@excelmanus/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  files: [] as FileEntry[],
  messages: [] as ((message: ServerMessage) => void)[],
  connections: [] as ((connected: boolean) => void)[],
  listFiles: vi.fn(),
  workspaces: [{ id: "workspace", isDefault: true }],
}));

vi.mock("@/lib/backend/api", () => ({
  connectBackend: async () => "ok",
  errorMessage: (error: Error) => error.message,
  api: () => ({
    bootstrap: async () => ({ protocolVersion: 4, features: {} }),
    listWorkspaces: async () => ({ items: harness.workspaces }),
    listSessions: async () => ({
      items: [{ id: "session", workspaceId: "workspace", lastSeq: 0 }],
    }),
    listModelProfiles: async () => ({ items: [] }),
    listProviders: async () => ({ items: [] }),
    listProviderConnections: async () => ({ items: [] }),
    getSettings: async () => ({ settings: {} }),
    getSessionHistoryWindow: async () => ({ kind: "overflow", headSeq: 0, reason: "records" }),
    getSessionLog: async () => ({ items: [] }),
    getSession: async () => ({
      session: { workspaceId: "workspace", permissionMode: "standard", title: "恢复" },
      headSeq: 0,
      agents: [],
    }),
    listFiles: harness.listFiles,
  }),
}));

vi.mock("@/lib/backend/channel", () => ({
  onSync: (listener: (message: ServerMessage) => void) => harness.messages.push(listener),
  onConnection: (listener: (connected: boolean) => void) => harness.connections.push(listener),
  startChannel: () => {
    for (const listener of harness.connections) listener(true);
  },
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
  sendSync: () => false,
  syncConnectionId: () => null,
}));

function deliver(message: ServerMessage) {
  for (const receive of harness.messages) receive(message);
}

function connection(connected: boolean) {
  for (const receive of harness.connections) receive(connected);
}

function committed(seq: number, type: string, data: Record<string, unknown>) {
  deliver({
    type: "rec",
    topic: "session:session",
    seq,
    record: {
      sessionId: "session",
      agentId: "main",
      seq,
      type,
      data,
      createdAt: "2026-10-21T08:00:00Z",
    },
  });
}

const createdFile: FileEntry = {
  path: "offline-result.txt",
  name: "offline-result.txt",
  kind: "file",
  size: 4,
  modifiedAt: "2026-10-21T08:00:00Z",
};

beforeEach(() => {
  vi.resetModules();
  harness.files = [];
  harness.messages = [];
  harness.connections = [];
  harness.workspaces = [{ id: "workspace", isDefault: true }];
  harness.listFiles.mockReset().mockImplementation(async () => ({ items: [...harness.files] }));
});
afterEach(() => vi.unstubAllGlobals());

async function bootRealStores() {
  const { bootApp } = await import("../src/lib/boot");
  const { useFilesStore } = await import("../src/stores/files-store");
  await bootApp();
  await vi.waitFor(() => expect(useFilesStore.getState().dirs[""]).toEqual([]));
  return useFilesStore;
}

test("reconnection restores a file created while its files.changed event was unavailable", async () => {
  const files = await bootRealStores();
  const { useAppStore } = await import("../src/stores/app-store");
  const { useChatStore } = await import("../src/stores/chat-store");
  connection(false);
  expect(useAppStore.getState().connected).toBe(false);
  // The server's directory changed, but the ephemeral app event could not reach this client.
  harness.files = [createdFile];
  connection(true);
  subscribed();
  deliver({ type: "sub.ok", topic: "session:session", headCursor: 4, cursor: 0 });
  committed(1, "turn.started", { turnId: "turn" });
  committed(2, "tool.intent", {
    toolCallId: "write-result",
    toolName: "write",
    args: { path: createdFile.path, content: "done" },
    targets: [createdFile.path],
    intentMeta: { paths: { [createdFile.path]: null } },
  });
  committed(3, "tool.result", { toolCallId: "write-result", status: "ok" });
  committed(4, "turn.completed", { turnId: "turn" });
  expect(useAppStore.getState().connected).toBe(true);
  expect(useChatStore.getState().session.cursor).toBe(4);
  expect(useChatStore.getState().session.tools["write-result"]).toMatchObject({
    status: "ok",
    newFiles: [createdFile.path],
  });
  await vi.waitFor(() => expect(files.getState().dirs[""]).toEqual([createdFile]));
});

test("a delivered live files.changed event already refreshes the same directory", async () => {
  const files = await bootRealStores();
  harness.files = [createdFile];
  deliver({ type: "app.event", data: { type: "files.changed", workspaceId: "workspace" } });
  await vi.waitFor(() => expect(files.getState().dirs[""]).toEqual([createdFile]));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("reconnect revalidates attempted directories without walking unopened children", async () => {
  const files = await bootRealStores();
  const { loadDir } = await import("../src/stores/files-store");
  harness.listFiles.mockResolvedValueOnce({
    items: [{ path: "unopened", name: "unopened", kind: "dir" }],
  });
  await loadDir();
  await loadDir("loaded");
  harness.listFiles.mockRejectedValueOnce(new Error("offline"));
  await loadDir("failed");
  const pending = deferred<{ items: FileEntry[] }>();
  harness.listFiles.mockReturnValueOnce(pending.promise);
  const loading = loadDir("pending");
  harness.listFiles.mockClear();
  harness.files = [createdFile];
  connection(false);
  connection(true);
  subscribed();
  pending.resolve({ items: [] });
  await loading;
  await vi.waitFor(() =>
    expect(files.getState().dirs).toEqual({
      "": [createdFile],
      loaded: [createdFile],
      failed: [createdFile],
      pending: [createdFile],
    }),
  );
  expect(files.getState().errors).toEqual({});
  expect(harness.listFiles.mock.calls.map(([, path]) => path).sort()).toEqual([
    "",
    "failed",
    "loaded",
    "pending",
  ]);
});

test("repeated online notifications do not reread but a second reconnect coalesces an in-flight refresh", async () => {
  const files = await bootRealStores();
  const first = deferred<{ items: FileEntry[] }>();
  const latest = deferred<{ items: FileEntry[] }>();
  harness.listFiles
    .mockClear()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  connection(false);
  connection(true);
  subscribed();
  connection(true);
  subscribed();
  expect(harness.listFiles).toHaveBeenCalledTimes(1);
  connection(false);
  connection(true);
  subscribed();
  connection(true);
  subscribed();
  expect(harness.listFiles).toHaveBeenCalledTimes(1);
  first.resolve({ items: [createdFile] });
  await vi.waitFor(() => expect(harness.listFiles).toHaveBeenCalledTimes(2));
  expect(files.getState().dirs[""]).toEqual([]);
  const newest = { ...createdFile, size: 8 };
  latest.resolve({ items: [newest] });
  await vi.waitFor(() => expect(files.getState().dirs[""]).toEqual([newest]));
  connection(true);
  subscribed();
  expect(harness.listFiles).toHaveBeenCalledTimes(2);
});

test("a failed reconnect read preserves entries and retries on the next reconnect", async () => {
  const files = await bootRealStores();
  harness.listFiles.mockRejectedValueOnce(new Error("temporary"));
  connection(false);
  connection(true);
  subscribed();
  await vi.waitFor(() => expect(files.getState().errors[""]).toBe("temporary"));
  expect(files.getState().dirs[""]).toEqual([]);
  harness.files = [createdFile];
  connection(false);
  connection(true);
  subscribed();
  await vi.waitFor(() => expect(files.getState().dirs[""]).toEqual([createdFile]));
  expect(files.getState().errors).toEqual({});
});

test("a reconnect response from the old workspace never overwrites the new workspace", async () => {
  const files = await bootRealStores();
  const { useSessionStore } = await import("../src/stores/session-store");
  const { loadDir } = await import("../src/stores/files-store");
  const old = deferred<{ items: FileEntry[] }>();
  harness.listFiles.mockClear().mockReturnValueOnce(old.promise);
  connection(false);
  connection(true);
  subscribed();
  expect(harness.listFiles).toHaveBeenCalledOnce();
  const refreshing = loadDir();
  const newer = { ...createdFile, path: "new-workspace.txt", name: "new-workspace.txt" };
  harness.files = [newer];
  useSessionStore.setState({ activeWorkspaceId: "new-workspace" });
  await vi.waitFor(() => expect(files.getState().dirs[""]).toEqual([newer]));
  old.resolve({ items: [createdFile] });
  await refreshing;
  expect(files.getState()).toMatchObject({
    workspaceId: "new-workspace",
    dirs: { "": [newer] },
    errors: {},
    loading: { "": false },
  });
  expect(harness.listFiles.mock.calls).toEqual([
    ["workspace", ""],
    ["new-workspace", ""],
  ]);
});

test("initial connection and reconnection do not start an unrequested directory listing", async () => {
  harness.workspaces = [];
  const { bootApp } = await import("../src/lib/boot");
  const { useFilesStore } = await import("../src/stores/files-store");
  await bootApp();
  expect(harness.listFiles).not.toHaveBeenCalled();
  connection(false);
  connection(true);
  subscribed();
  expect(harness.listFiles).not.toHaveBeenCalled();
  useFilesStore.setState({ workspaceId: "workspace", dirs: {}, errors: {} });
  connection(false);
  connection(true);
  subscribed();
  expect(harness.listFiles).not.toHaveBeenCalled();
  expect(useFilesStore.getState().dirs).toEqual({});
});

function subscribed() {
  deliver({ type: "sub.ok", topic: "app", headCursor: 0, cursor: 0 });
}

test("reconnect waits for app subscription before reading files changed in the subscription gap", async () => {
  const files = await bootRealStores();
  harness.listFiles.mockClear();
  connection(false);
  connection(true);
  await Promise.resolve();
  expect(harness.listFiles).not.toHaveBeenCalled();
  // This change occurred after socket open but before app events could reach the client.
  harness.files = [createdFile];
  subscribed();
  await vi.waitFor(() => expect(files.getState().dirs[""]).toEqual([createdFile]));
  expect(harness.listFiles).toHaveBeenCalledTimes(1);
  subscribed();
  expect(harness.listFiles).toHaveBeenCalledTimes(1);
});
