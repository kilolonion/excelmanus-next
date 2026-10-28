import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { status: "booting" } as Record<string, unknown>,
  workspaces: vi.fn(),
  connect: vi.fn(),
  open: vi.fn(),
  incompatible: null as null | (() => void),
}));
vi.mock("@/lib/backend/api", () => ({
  connectBackend: mocks.connect,
  api: () => ({ bootstrap: async () => ({ protocolVersion: 4, features: {} }) }),
}));
vi.mock("@/lib/backend/channel", () => ({
  onConnection: vi.fn(),
  onSync: vi.fn(),
  subscribeTopic: vi.fn(),
  startChannel: ({ onIncompatible }: { onIncompatible: () => void }) => {
    mocks.incompatible = onIncompatible;
  },
}));
vi.mock("@/stores/app-store", () => ({
  useAppStore: {
    getState: () => mocks.state,
    setState: (
      patch:
        | Record<string, unknown>
        | ((state: Record<string, unknown>) => Record<string, unknown>),
    ) => Object.assign(mocks.state, typeof patch === "function" ? patch(mocks.state) : patch),
  },
  refreshWorkspaces: mocks.workspaces,
  refreshProfiles: async () => {},
  refreshSettings: async () => {},
}));
vi.mock("@/stores/session-store", () => ({
  refreshSessions: async () => [],
  restoreSavedWorkspace: async () => false,
  openWorkspace: mocks.open,
  preferredWorkspaceId: () => "ws",
}));
vi.mock("@/stores/files-store", () => ({ refreshFiles: vi.fn() }));
vi.mock("@/stores/workbook-store", () => ({}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.state = { status: "booting" };
  mocks.connect.mockResolvedValue("ok");
  mocks.incompatible = null;
  mocks.workspaces.mockResolvedValue([]);
  mocks.open.mockResolvedValue(undefined);
});
test("an incompatible channel during navigation loading cannot later enter the workspace", async () => {
  let resolve!: () => void;
  mocks.workspaces.mockReturnValueOnce(
    new Promise<void>((yes) => {
      resolve = yes;
    }),
  );
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp();
  await vi.waitFor(() => expect(mocks.incompatible).not.toBeNull());
  mocks.incompatible?.();
  resolve();
  await pending;
  expect(mocks.state.status).toBe("protocol-mismatch");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.workspaces.mock.calls[0][0].signal.aborted).toBe(true);
});
test("an incompatible channel while opening the workspace is not overwritten by ready", async () => {
  let resolve!: () => void;
  mocks.open.mockReturnValueOnce(
    new Promise<void>((yes) => {
      resolve = yes;
    }),
  );
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp();
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
  mocks.incompatible?.();
  resolve();
  await pending;
  expect(mocks.state.status).toBe("protocol-mismatch");
});
test("a later navigation failure preserves the already reported protocol mismatch", async () => {
  let reject!: (error: Error) => void;
  mocks.workspaces.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp();
  await vi.waitFor(() => expect(mocks.incompatible).not.toBeNull());
  mocks.incompatible?.();
  reject(new Error("late list failure"));
  await pending;
  expect(mocks.state.status).toBe("protocol-mismatch");
});

test("the entire JS startup aborts after45s and never publishes late ready", async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  mocks.workspaces.mockReturnValue(
    new Promise<void>((yes) => {
      resolve = yes;
    }),
  );
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp();
  await vi.advanceTimersByTimeAsync(45001);
  expect(mocks.state.status).toBe("auth-failed");
  await pending;
  expect(mocks.workspaces.mock.calls[0][0].signal.aborted).toBe(true);
  resolve();
  await Promise.resolve();
  expect(mocks.state.status).toBe("auth-failed");
  vi.useRealTimers();
});
test("permanent forbidden auth is not retried", async () => {
  vi.useFakeTimers();
  mocks.connect.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp();
  await vi.advanceTimersByTimeAsync(45001);
  await pending;
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  expect(mocks.state.status).toBe("auth-failed");
  vi.useRealTimers();
});
