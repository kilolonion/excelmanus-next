import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  html: vi.fn((): string | null => "<b>code</b>\nnext"),
  lines: vi.fn(() => ["<b>code</b>", "next"]),
  post: vi.fn(),
}));
vi.mock("../src/lib/hljs-utils", () => ({
  ensureHljs: () => Promise.resolve(),
  highlightCode: mocks.html,
  highlightCodeLines: mocks.lines,
}));
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.html.mockReturnValue("<b>code</b>\nnext");
  vi.stubGlobal("postMessage", mocks.post);
  vi.stubGlobal("onmessage", null);
  await import("../src/lib/preview-highlight.worker");
});
afterEach(() => vi.unstubAllGlobals());

async function send(output?: "html") {
  const handler = globalThis.onmessage as unknown as (event: MessageEvent) => Promise<void>;
  await handler({
    data: { code: "code\nnext", language: "typescript", output },
  } as MessageEvent);
}

test("chat output transfers one HTML string without splitting it into lines", async () => {
  await send("html");
  expect(mocks.post).toHaveBeenCalledWith("<b>code</b>\nnext");
  expect(mocks.html).toHaveBeenCalledWith("code\nnext", "typescript");
  expect(mocks.lines).not.toHaveBeenCalled();
});
test("legacy line-output callers retain their output format", async () => {
  await send();
  expect(mocks.post).toHaveBeenCalledWith(["<b>code</b>", "next"]);
  expect(mocks.lines).toHaveBeenCalledWith("code\nnext", "typescript");
  expect(mocks.html).not.toHaveBeenCalled();
});
test("optional highlighting failure leaves chat callers on their original-text fallback", async () => {
  mocks.html.mockReturnValue(null);
  await send("html");
  expect(mocks.post).toHaveBeenCalledWith(null);
  expect(mocks.lines).not.toHaveBeenCalled();
});
