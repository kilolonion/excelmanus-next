import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaces: vi.fn(),
  profiles: vi.fn(),
  settings: vi.fn(),
  sessions: vi.fn(),
  open: vi.fn(),
  restore: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({
  connectBackend: async () => "ok",
  api: () => ({ bootstrap: async () => ({ protocolVersion: 4, features: {} }) }),
}));
vi.mock("@/lib/backend/channel", () => ({
  onConnection: vi.fn(),
  onSync: vi.fn(),
  startChannel: vi.fn(),
  subscribeTopic: vi.fn(),
}));
vi.mock("@/stores/app-store", () => ({
  useAppStore: { setState: mocks.set, getState: () => ({ status: "booting" }) },
  refreshWorkspaces: mocks.workspaces,
  refreshProfiles: mocks.profiles,
  refreshSettings: mocks.settings,
}));
vi.mock("@/stores/session-store", () => ({
  refreshSessions: mocks.sessions,
  openWorkspace: mocks.open,
  restoreSavedWorkspace: mocks.restore,
  preferredWorkspaceId: () => "ws",
}));
vi.mock("@/stores/files-store", () => ({ refreshFiles: vi.fn() }));
vi.mock("@/stores/workbook-store", () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

test("startup loads independent navigation data in parallel before opening the selected workspace", async () => {
  let finish!: () => void;
  mocks.workspaces.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  mocks.profiles.mockResolvedValue(undefined);
  mocks.settings.mockResolvedValue(undefined);
  mocks.sessions.mockResolvedValue([]);
  mocks.open.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(false);
  const { bootApp } = await import("../src/lib/boot");
  const booting = bootApp();
  await vi.waitFor(() => expect(mocks.workspaces).toHaveBeenCalled());
  expect(mocks.sessions).toHaveBeenCalledOnce();
  expect(mocks.open).not.toHaveBeenCalled();
  finish();
  await booting;
  expect(mocks.open).toHaveBeenCalledWith("ws", expect.objectContaining({ timeoutMs: 15000 }));
  expect(mocks.set).toHaveBeenLastCalledWith({ status: "ready" });
});

test("saved restoration overlaps pagination but ready waits for both", async () => {
  let finish!: () => void;
  mocks.workspaces.mockResolvedValue([]);
  mocks.profiles.mockResolvedValue(undefined);
  mocks.settings.mockResolvedValue(undefined);
  mocks.sessions.mockReturnValue(
    new Promise((resolve) => {
      finish = () => resolve([]);
    }),
  );
  mocks.restore.mockResolvedValue(true);
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp();
  await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalled());
  expect(mocks.set).not.toHaveBeenCalledWith({ status: "ready" });
  finish();
  await pending;
  expect(mocks.set).toHaveBeenLastCalledWith({ status: "ready" });
  expect(mocks.open).not.toHaveBeenCalled();
});
test("sidebar failure aborts sibling restoration and never enters ready", async () => {
  let reject!: (e: Error) => void;
  mocks.workspaces.mockResolvedValue([]);
  mocks.profiles.mockResolvedValue(undefined);
  mocks.settings.mockResolvedValue(undefined);
  mocks.sessions.mockReturnValue(
    new Promise((_, no) => {
      reject = no;
    }),
  );
  mocks.restore.mockImplementation(
    (_ws, opts) =>
      new Promise((_, no) =>
        opts.signal.addEventListener("abort", () => no(opts.signal.reason), { once: true }),
      ),
  );
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp();
  await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalled());
  reject(new Error("page2 failed"));
  await pending;
  expect(mocks.restore.mock.calls[0][1].signal.aborted).toBe(true);
  expect(mocks.set).not.toHaveBeenCalledWith({ status: "ready" });
  expect(mocks.set).toHaveBeenLastCalledWith({ status: "auth-failed" });
});
