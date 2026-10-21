import type { AppSettings } from "@excelmanus/protocol";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks }));
vi.mock("@/lib/backend/channel", () => ({ onSync: vi.fn() }));

import { refreshSettings, updateSettings, useAppStore } from "../src/stores/app-store";

const initial: AppSettings = {
  defaultPermissionMode: "standard",
  defaultDispatchMode: "queue",
  subAgentProfileId: null,
  compactionProfileId: null,
  autoCompact: true,
  maxConcurrentSubAgents: 4,
  httpProxy: null,
  noProxy: null,
  memoryInjection: true,
  autoTitle: true,
};
function pendingRead() {
  let resolve!: (response: { settings: AppSettings }) => void;
  mocks.getSettings.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const promise = refreshSettings();
  return { promise, resolve: (settings: AppSettings) => resolve({ settings }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ settings: initial });
});
test("a read started before a successful save cannot restore old settings", async () => {
  const old = pendingRead();
  const saved = { ...initial, autoTitle: false };
  mocks.updateSettings.mockResolvedValueOnce({ settings: saved, restartRequired: [] });
  await updateSettings({ autoTitle: false });
  old.resolve(initial);
  await old.promise;
  expect(useAppStore.getState().settings).toEqual(saved);
});
test("an older refresh finishing after a newer refresh cannot replace its result", async () => {
  const old = pendingRead();
  const latest = pendingRead();
  const current = { ...initial, autoTitle: false };
  latest.resolve(current);
  await latest.promise;
  old.resolve(initial);
  await old.promise;
  expect(useAppStore.getState().settings).toEqual(current);
});
test("a fresh read after a save still requests and publishes current settings", async () => {
  mocks.updateSettings.mockResolvedValueOnce({
    settings: { ...initial, autoTitle: false },
    restartRequired: [],
  });
  await updateSettings({ autoTitle: false });
  mocks.getSettings.mockResolvedValueOnce({ settings: initial });
  await refreshSettings();
  expect(mocks.getSettings).toHaveBeenCalledTimes(1);
  expect(useAppStore.getState().settings).toEqual(initial);
});
