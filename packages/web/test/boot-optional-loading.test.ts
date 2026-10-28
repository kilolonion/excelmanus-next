import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaces: vi.fn(),
  profiles: vi.fn(),
  settings: vi.fn(),
  sessions: vi.fn(),
  open: vi.fn(),
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
  restoreSavedWorkspace: async () => false,
  preferredWorkspaceId: () => "ws",
}));
vi.mock("@/stores/files-store", () => ({ refreshFiles: vi.fn() }));
vi.mock("@/stores/workbook-store", () => ({}));

import { bootApp } from "../src/lib/boot";

test("workspace entry does not wait for model and preference reads", async () => {
  let finishProfiles!: () => void;
  let finishSettings!: () => void;
  mocks.workspaces.mockResolvedValue([]);
  mocks.profiles.mockReturnValue(
    new Promise<void>((resolve) => {
      finishProfiles = resolve;
    }),
  );
  mocks.settings.mockReturnValue(
    new Promise<void>((resolve) => {
      finishSettings = resolve;
    }),
  );
  mocks.sessions.mockResolvedValue([]);
  mocks.open.mockResolvedValue(undefined);
  const booting = bootApp();
  try {
    await vi.waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith(
        "ws",
        expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 15000 }),
      ),
    );
    await booting;
    expect(mocks.set).toHaveBeenLastCalledWith({ status: "ready" });
  } finally {
    finishProfiles();
    finishSettings();
    await booting;
  }
});
