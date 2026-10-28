import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  version: 4,
  signedOut: false,
  workspaces: vi.fn(),
  open: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({
  connectBackend: async () => (mocks.signedOut ? "signed-out" : "ok"),
  api: () => ({ bootstrap: async () => ({ protocolVersion: mocks.version, features: {} }) }),
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
  refreshProfiles: async () => {},
  refreshSettings: async () => {},
}));
vi.mock("@/stores/session-store", () => ({
  refreshSessions: async () => [],
  openWorkspace: mocks.open,
  restoreSavedWorkspace: async () => false,
  preferredWorkspaceId: () => "ws",
}));
vi.mock("@/stores/files-store", () => ({ refreshFiles: vi.fn() }));
vi.mock("@/stores/workbook-store", () => ({}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.version = 4;
  mocks.signedOut = false;
  mocks.workspaces.mockResolvedValue([]);
  mocks.open.mockResolvedValue(undefined);
});
test("preloads after protocol validation while workspace restoration is still pending", async () => {
  let finish!: () => void;
  mocks.workspaces.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const preload = vi.fn();
  const { bootApp } = await import("../src/lib/boot");
  const pending = bootApp(preload);
  try {
    await vi.waitFor(() => expect(mocks.workspaces).toHaveBeenCalled());
    expect(preload).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
  } finally {
    finish();
    await pending;
  }
  expect(mocks.set).toHaveBeenLastCalledWith({ status: "ready" });
});
test.each(["signed-out", "protocol-mismatch"])(
  "%s never preloads the workspace",
  async (failure) => {
    mocks.signedOut = failure === "signed-out";
    mocks.version = failure === "protocol-mismatch" ? 999 : 4;
    const preload = vi.fn();
    const { bootApp } = await import("../src/lib/boot");
    await bootApp(preload);
    expect(preload).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenLastCalledWith({ status: failure });
  },
);
