import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ status: "ready" }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (s: unknown) => unknown) => select(state),
}));
vi.mock("@/lib/backend/api", () => ({ resumeBrowserSession: vi.fn() }));
vi.mock("@/lib/boot", () => ({ bootApp: vi.fn() }));
vi.mock("@/components/ui/LoadingScreen", () => ({
  LoadingScreen: () => createElement("div", { "data-loading": true }, "loading-fallback"),
}));
beforeEach(() => {
  vi.resetModules();
  state.status = "ready";
  vi.doMock("@/app/client-layout", () => ({
    ClientLayout: () => createElement("div", { "data-layout": true }, "ready-layout"),
  }));
});

test("completed preload renders the first ready layout without a fresh Suspense fallback", async () => {
  const { Root, loadClientLayout } = await import("../src/app/Root");
  await loadClientLayout();
  const html = renderToString(createElement(Root));
  expect(html).toContain("ready-layout");
  expect(html).not.toContain("loading-fallback");
});

test("preload callers share one promise, and pending layout still suspends", async () => {
  const { Root, loadClientLayout } = await import("../src/app/Root");
  const pending = loadClientLayout();
  expect(loadClientLayout()).toBe(pending);
  expect(renderToString(createElement(Root))).toContain("loading-fallback");
  await pending;
  expect(renderToString(createElement(Root))).toContain("ready-layout");
});

test("resolved layout never bypasses boot or failed-auth screens", async () => {
  const { Root, loadClientLayout } = await import("../src/app/Root");
  await loadClientLayout();
  for (const status of ["booting", "signed-out", "auth-failed", "protocol-mismatch"]) {
    state.status = status;
    const html = renderToString(createElement(Root));
    expect(html).toContain("loading-fallback");
    expect(html).not.toContain("ready-layout");
  }
});

test("failed preload remains a rejected lazy resource rather than an import retry loop", async () => {
  const factory = vi.fn(() => {
    throw new Error("test chunk failure");
  });
  vi.doMock("@/app/client-layout", factory);
  const { Root, loadClientLayout } = await import("../src/app/Root");
  const failed = loadClientLayout();
  await expect(failed).rejects.toThrow();
  expect(loadClientLayout()).toBe(failed);
  // First lazy attempt consumes the rejected resource; the following render surfaces its error.
  renderToString(createElement(Root));
  await Promise.resolve();
  // Server Suspense serializes the rejection; on the client the unchanged ErrorBoundary handles it.
  expect(renderToString(createElement(Root))).toContain("error when mocking a module");
  expect(factory).toHaveBeenCalledTimes(1);
});
