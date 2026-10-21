import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ fail: true }));
vi.mock("@/lib/boot", () => ({ bootApp: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ resumeBrowserSession: vi.fn() }));
vi.mock("@/stores/app-store", () => ({ useAppStore: vi.fn() }));
vi.mock("../src/app/client-layout", () => ({
  get ClientLayout() {
    if (state.fail) throw new Error("initial preload failed");
    return function Layout() {
      return null;
    };
  },
}));

import { loadClientLayout } from "../src/app/Root";

test("an unsuccessful preload does not cache a rejected loader promise", async () => {
  await expect(loadClientLayout()).rejects.toThrow("initial preload failed");
  state.fail = false;
  expect((await loadClientLayout()).default).toBeTypeOf("function");
});
