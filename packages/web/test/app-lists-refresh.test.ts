import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listModelProfiles: vi.fn(),
  listProviders: vi.fn(),
  listProviderConnections: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks }));
vi.mock("@/lib/backend/channel", () => ({ onSync: vi.fn() }));

import { refreshProfiles, refreshWorkspaces, useAppStore } from "../src/stores/app-store";

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState(useAppStore.getInitialState());
  mocks.listProviders.mockResolvedValue({ items: [] });
  mocks.listProviderConnections.mockResolvedValue({ items: [] });
});
test("old workspace reads cannot replace the latest workspace list", async () => {
  let resolve!: (value: unknown) => void;
  mocks.listWorkspaces.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const old = refreshWorkspaces();
  const current = [{ id: "new-workspace" }];
  mocks.listWorkspaces.mockResolvedValueOnce({ items: current });
  await refreshWorkspaces();
  resolve({ items: [{ id: "old-workspace" }] });
  await old;
  expect(useAppStore.getState().workspaces).toEqual(current);
});
test("old model reads cannot roll back profiles, connections, providers or model readiness", async () => {
  let resolve!: (value: unknown) => void;
  mocks.listModelProfiles.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  mocks.listProviders.mockResolvedValueOnce({ items: [{ id: "old-provider" }] });
  mocks.listProviderConnections.mockResolvedValueOnce({ items: [{ id: "old-connection" }] });
  const old = refreshProfiles();
  mocks.listModelProfiles.mockResolvedValueOnce({ items: [{ id: "current-model" }] });
  mocks.listProviders.mockResolvedValueOnce({ items: [{ id: "current-provider" }] });
  mocks.listProviderConnections.mockResolvedValueOnce({ items: [{ id: "current-connection" }] });
  await refreshProfiles();
  resolve({ items: [] });
  await old;
  expect(useAppStore.getState()).toMatchObject({
    profiles: [{ id: "current-model" }],
    providers: [{ id: "current-provider" }],
    connections: [{ id: "current-connection" }],
    hasModelProfile: true,
  });
});
test("a failed list read keeps known state and the next refresh can recover", async () => {
  mocks.listWorkspaces.mockResolvedValueOnce({ items: [{ id: "known" }] });
  await refreshWorkspaces();
  mocks.listWorkspaces.mockRejectedValueOnce(new Error("temporary failure"));
  await expect(refreshWorkspaces()).rejects.toThrow("temporary failure");
  expect(useAppStore.getState().workspaces).toEqual([{ id: "known" }]);
  mocks.listWorkspaces.mockResolvedValueOnce({ items: [{ id: "fresh" }] });
  await refreshWorkspaces();
  expect(useAppStore.getState().workspaces).toEqual([{ id: "fresh" }]);
});

test("model reads distinguish initial loading, failure and a confirmed empty list", async () => {
  let reject!: (error: Error) => void;
  mocks.listModelProfiles.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const reading = refreshProfiles();
  const failed = expect(reading).rejects.toThrow("catalog unavailable");
  expect(useAppStore.getState()).toMatchObject({ profilesLoaded: false, profilesLoading: true });
  reject(new Error("catalog unavailable"));
  await failed;
  expect(useAppStore.getState()).toMatchObject({
    profilesLoaded: false,
    profilesLoading: false,
    profilesError: "catalog unavailable",
  });
  mocks.listModelProfiles.mockResolvedValueOnce({ items: [] });
  await refreshProfiles();
  expect(useAppStore.getState()).toMatchObject({
    profilesLoaded: true,
    profilesLoading: false,
    profilesError: null,
    hasModelProfile: false,
  });
});
