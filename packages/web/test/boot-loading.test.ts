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
  preferredWorkspaceId: () => "ws",
}));
vi.mock("@/stores/files-store", () => ({ refreshFiles: vi.fn() }));
vi.mock("@/stores/workbook-store", () => ({}));

import { bootApp } from "../src/lib/boot";

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
  const booting = bootApp();
  await vi.waitFor(() => expect(mocks.workspaces).toHaveBeenCalled());
  expect(mocks.sessions).toHaveBeenCalledOnce();
  expect(mocks.open).not.toHaveBeenCalled();
  finish();
  await booting;
  expect(mocks.open).toHaveBeenCalledWith("ws");
  expect(mocks.set).toHaveBeenLastCalledWith({ status: "ready" });
});
