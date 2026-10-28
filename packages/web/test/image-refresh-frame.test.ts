import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  effect: undefined as undefined | (() => (() => void) | undefined),
  fetch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: typeof mocks.effect) => {
    mocks.effect = effect;
  },
  useState: (initial: unknown) => [
    mocks.state ?? initial,
    (value: unknown) => {
      mocks.state = value;
    },
  ],
}));
vi.mock("@/stores/files-store", () => ({ fetchWorkspaceFile: mocks.fetch }));
vi.mock("@/lib/backend/api", () => ({ errorMessage: (e: Error) => e.message }));

import { useWorkspaceImage } from "../src/lib/use-workspace-image";

let output: ReturnType<typeof useWorkspaceImage>;
function render(version = 1, attempt = 0) {
  function Probe() {
    output = useWorkspaceImage("picture.png", true, version, attempt);
    return null;
  }
  renderToString(createElement(Probe));
  return output;
}
beforeEach(() => {
  mocks.state = undefined;
  mocks.fetch.mockReset();
});
test("a new image version has loading state before effects, without the prior blob", async () => {
  mocks.fetch.mockResolvedValue(new Blob(["old"]));
  render();
  const close = mocks.effect?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(render().blobUrl).toMatch(/^blob:/);
  expect(render(2)).toMatchObject({ blobUrl: null, loading: true, error: "" });
  close?.();
});
test("retry immediately hides the previous image error and then publishes the new result", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("old failure"));
  render();
  const close = mocks.effect?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(render().error).toBe("old failure");
  expect(render(1, 1)).toMatchObject({ blobUrl: null, loading: true, error: "" });
  close?.();
  mocks.fetch.mockResolvedValue(new Blob(["new"]));
  const closeRetry = mocks.effect?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(render(1, 1).blobUrl).toMatch(/^blob:/);
  closeRetry?.();
});
