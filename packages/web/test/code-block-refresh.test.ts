import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  load: vi.fn(),
  workers: [] as FakeWorker[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = state.index++;
      if (!(index in state.values)) state.values[index] = initial;
      return [
        state.values[index],
        (value: unknown) => {
          state.values[index] = value;
        },
      ];
    },
    useEffect: (effect: () => void) => {
      state.effects.push(effect);
    },
  };
});
vi.mock("@/lib/hljs-utils", () => ({
  ensureHljs: state.load,
  highlightCode: (code: string) => `<b>${code}</b>`,
}));

import { CodeBlock } from "../src/components/chat/CodeBlock";
import StreamingTextPreview from "../src/components/chat/StreamingTextPreview";

function render(code: string, language = "text", streaming = false) {
  state.index = 0;
  state.effects = [];
  return renderToString(createElement(CodeBlock, { code, language, streaming }));
}
beforeEach(() => {
  state.values = [];
  state.workers = [];
  vi.stubGlobal("Worker", FakeWorker);
  state.load.mockReset().mockResolvedValue(undefined);
});
test("updated code is shown immediately instead of the previous highlighted content", async () => {
  render("old code");
  state.effects[0]();
  await Promise.resolve();
  expect(render("old code")).toContain("<b>old code</b>");
  const next = render("new code");
  expect(next).toContain("new code");
  expect(next).not.toContain("old code");
});
test("changing language does not reuse highlighting from the previous language", async () => {
  render("code", "python");
  state.effects[0]();
  await Promise.resolve();
  expect(render("code", "sql")).not.toContain("<b>code</b>");
});

class FakeWorker {
  onmessage: ((event: MessageEvent<string | null>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    state.workers.push(this);
  }
}
afterEach(() => vi.unstubAllGlobals());

test("large chat code uses a worker and leaves original text visible while pending", async () => {
  const code = "x".repeat(200_000);
  expect(render(code)).toContain(code);
  state.effects[0]();
  await Promise.resolve();
  expect(state.load).not.toHaveBeenCalled();
  expect(state.workers).toHaveLength(1);
  const worker = state.workers[0];
  expect(worker.postMessage).toHaveBeenCalledWith({ code, language: "text", output: "html" });
  worker.onmessage?.({ data: "<b>highlighted</b>\nsecond" } as MessageEvent<string | null>);
  expect(render(code)).toContain("<b>highlighted</b>\nsecond");
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test("replaced large code terminates its worker and ignores its late result", async () => {
  const old = "x".repeat(200_000);
  render(old);
  const cleanup = state.effects[0]() as unknown as () => void;
  expect(state.workers).toHaveLength(1);
  cleanup();
  expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  state.workers[0].onmessage?.({ data: "old result" } as MessageEvent<string | null>);
  expect(render("new code")).not.toContain("old result");
});

test("large code worker failure keeps plain text without main-thread highlighting", async () => {
  const code = "x".repeat(200_000);
  render(code);
  state.effects[0]();
  expect(state.workers).toHaveLength(1);
  state.workers[0].onerror?.();
  expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(render(code)).toContain(code);
  expect(state.load).not.toHaveBeenCalled();
});

test("streaming code skips full highlighting until it becomes final", async () => {
  render("partial", "typescript", true);
  state.effects[0]();
  await Promise.resolve();
  expect(state.load).not.toHaveBeenCalled();
  expect(state.workers).toHaveLength(0);
  render("final", "typescript", false);
  state.effects[0]();
  await Promise.resolve();
  expect(render("final", "typescript")).toContain("<b>final</b>");
});

test("streamed script tool preview forwards the plain-code mode", async () => {
  state.index = 0;
  state.effects = [];
  const html = renderToString(
    createElement(StreamingTextPreview, {
      toolName: "run_script",
      rawArgs: JSON.stringify({ code: "const a = 1;" }),
    }),
  );
  expect(html).toContain("const a = 1;");
  for (const effect of state.effects) effect();
  await Promise.resolve();
  expect(state.load).not.toHaveBeenCalled();
});

test("medium chat code also moves expensive grammar work off the UI thread", async () => {
  const code = "const result = compute(items);\n".repeat(1000);
  expect(code.length).toBeLessThan(200_000);
  expect(render(code, "unknown-language")).toContain(code);
  const cleanup = state.effects[0]() as unknown as () => void;
  await Promise.resolve();
  expect(state.load).not.toHaveBeenCalled();
  expect(state.workers).toHaveLength(1);
  expect(state.workers[0].postMessage).toHaveBeenCalledWith({
    code,
    language: "unknown-language",
    output: "html",
  });
  cleanup();
  expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
});
