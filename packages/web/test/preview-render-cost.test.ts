import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  highlight: vi.fn(() => "highlighted"),
  plain: vi.fn((code: string) => code.split("\n")),
  content: "const a = 1;",
  effects: [] as Array<() => undefined | (() => void)>,
  setState: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => [react.useState(initial)[0], mocks.setState],
    useEffect: (effect: () => undefined | (() => void)) => mocks.effects.push(effect),
  };
});
vi.mock("@/lib/hljs-utils", () => ({
  ensureHljs: () => Promise.resolve(),
  highlightCode: mocks.highlight,
  highlightCodeLines: mocks.highlight,
  plainCodeLines: mocks.plain,
}));
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children: import("react").ReactNode }) => children;
  return { Dialog: pass, DialogContent: pass, DialogTitle: pass };
});
vi.mock("@/stores/files-store", () => ({
  useFilesStore: (select: (state: unknown) => unknown) => select({ workspaceId: "ws", version: 0 }),
  downloadWorkspaceFile: vi.fn(),
}));
vi.mock("@/stores/preview-store", () => ({
  usePreviewStore: (select: (state: unknown) => unknown) =>
    select({
      recent: [],
      textContent: {
        workspaceId: "ws",
        path: "sample.ts",
        content: mocks.content,
        loading: false,
        error: "",
      },
    }),
  loadTextPreview: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 100,
    getVirtualItems: () => [{ index: 0, key: 0, start: 0 }],
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.content = "const a = 1;";
  mocks.effects = [];
});

import { CodePreviewModal } from "../src/components/chat/CodePreviewModal";

test("the preview render does not synchronously run the optional highlighter", () => {
  renderToString(
    createElement(CodePreviewModal, { filePath: "sample.ts", filename: "sample.ts", open: true }),
  );
  expect(mocks.highlight).not.toHaveBeenCalled();
});

test("plain preview escapes only visible lines rather than the entire file", () => {
  mocks.content = "visible <tag>\nhidden line\nlast line";
  renderToString(
    createElement(CodePreviewModal, { filePath: "sample.ts", filename: "sample.ts", open: true }),
  );
  expect(mocks.plain).toHaveBeenCalledWith("visible <tag>");
  expect(mocks.plain).not.toHaveBeenCalledWith(mocks.content);
});

afterEach(() => vi.unstubAllGlobals());
test("large preview highlighting runs in an owned worker and terminates on unmount", async () => {
  const postMessage = vi.fn(),
    terminate = vi.fn();
  const workers: Array<{
    onmessage: null | ((e: MessageEvent) => void);
    onerror: null | ((e: ErrorEvent) => void);
  }> = [];
  vi.stubGlobal(
    "Worker",
    class {
      onmessage = null;
      onerror = null;
      postMessage = postMessage;
      terminate = terminate;
      constructor() {
        workers.push(this);
      }
    },
  );
  mocks.content = "const item = { value: 1 };\n".repeat(12000);
  renderToString(
    createElement(CodePreviewModal, { filePath: "sample.ts", filename: "sample.ts", open: true }),
  );
  const cleanup = mocks.effects[1]();
  await Promise.resolve();
  expect(workers).toHaveLength(1);
  expect(postMessage).toHaveBeenCalledWith({
    code: mocks.content,
    language: "typescript",
    output: "html",
  });
  expect(mocks.highlight).not.toHaveBeenCalled();
  cleanup?.();
  expect(terminate).toHaveBeenCalledTimes(1);
});

test("worker completion updates highlighted lines and failure keeps plain text retryable", () => {
  const workers: Array<{
    onmessage: null | ((e: MessageEvent<string | null>) => void);
    onerror: null | (() => void);
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal(
    "Worker",
    class {
      onmessage = null;
      onerror = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        workers.push(this);
      }
    },
  );
  mocks.content = "const item = 1;\n".repeat(20000);
  const start = () => {
    mocks.effects = [];
    renderToString(
      createElement(CodePreviewModal, { filePath: "sample.ts", filename: "sample.ts", open: true }),
    );
    return mocks.effects[1]();
  };
  const cancelFailed = start();
  workers[0].onerror?.();
  expect(mocks.setState).not.toHaveBeenCalled();
  expect(mocks.highlight).not.toHaveBeenCalled();
  cancelFailed?.();
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  const cancelDone = start();
  workers[1].onmessage?.({ data: "highlighted result" } as MessageEvent<string | null>);
  expect(mocks.setState).toHaveBeenCalledWith({
    content: mocks.content,
    filename: "sample.ts",
    lines: expect.objectContaining({ length: 1, get: expect.any(Function) }),
  });
  cancelDone?.();
  expect(workers[1].terminate).toHaveBeenCalledTimes(1);
});

test("medium file previews do not synchronously highlight after their module loads", async () => {
  const postMessage = vi.fn(),
    terminate = vi.fn();
  vi.stubGlobal(
    "Worker",
    class {
      onmessage = null;
      onerror = null;
      postMessage = postMessage;
      terminate = terminate;
    },
  );
  mocks.content = "const item = { value: 1 };\n".repeat(1000);
  expect(mocks.content.length).toBeLessThan(200_000);
  renderToString(
    createElement(CodePreviewModal, { filePath: "sample.ts", filename: "sample.ts", open: true }),
  );
  const cleanup = mocks.effects[1]();
  await Promise.resolve();
  expect(mocks.highlight).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({
    code: mocks.content,
    language: "typescript",
    output: "html",
  });
  cleanup?.();
  expect(terminate).toHaveBeenCalledTimes(1);
});

function workerPreview() {
  const workers: Array<{
    onmessage: null | ((e: MessageEvent<string | null>) => void);
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal(
    "Worker",
    class {
      onmessage = null;
      onerror = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        workers.push(this);
      }
    },
  );
  mocks.content = "sample\n".repeat(200000);
  renderToString(
    createElement(CodePreviewModal, { filePath: "sample.ts", filename: "sample.ts", open: true }),
  );
  const cleanup = mocks.effects[1]();
  return { worker: workers[0], cleanup };
}
test("large highlighted output uses offsets rather than materializing every HTML line", () => {
  const { worker, cleanup } = workerPreview();
  const html = '<span class="hljs-keyword">const</span> item = 1;\n'.repeat(200000);
  const split = vi.spyOn(String.prototype, "split");
  worker.onmessage?.({ data: html } as MessageEvent<string>);
  const result = mocks.setState.mock.calls.at(-1)?.[0];
  expect(result.lines.length).toBe(200001);
  expect(result.lines.get(199999)).toBe('<span class="hljs-keyword">const</span> item = 1;');
  expect(result.lines.get(200000)).toBe("");
  expect(split.mock.contexts.some((value) => value === html)).toBe(false);
  split.mockRestore();
  cleanup?.();
});
test("null optional highlight results retain original text", () => {
  const { worker, cleanup } = workerPreview();
  worker.onmessage?.({ data: null } as MessageEvent<null>);
  expect(mocks.setState).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  cleanup?.();
});
test("closed previews do not index or publish a late HTML response", () => {
  const { worker, cleanup } = workerPreview();
  cleanup?.();
  worker.onmessage?.({ data: "late\n".repeat(200000) } as MessageEvent<string>);
  expect(mocks.setState).not.toHaveBeenCalled();
});
