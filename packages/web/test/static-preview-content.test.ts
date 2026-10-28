import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  content: "visible <tag>&value",
  mode: "code" as "code" | "markdown",
  index: 0,
  state: 0,
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  plain: vi.fn(),
  highlighted: null as string[] | null,
  matches: [] as number[] | Uint32Array,
  renderer: (() => null) as (props: { children: string }) => ReactNode,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.index++,
        old = h.memos[i];
      if (old && deps.length === old.deps.length && deps.every((d, j) => Object.is(d, old.deps[j])))
        return old.value;
      const value = fn();
      h.memos[i] = { deps, value };
      return value;
    },
    useState: (initial: unknown) => {
      if (h.mode === "markdown") return [[h.renderer, false, 0][h.state++], vi.fn()];
      const value =
        h.highlighted && initial && typeof initial === "object" && "lines" in initial
          ? {
              content: h.content,
              filename: "qa.txt",
              lines: { length: h.highlighted.length, get: (i: number) => h.highlighted?.[i] },
            }
          : typeof initial === "function"
            ? initial()
            : initial;
      return [value, vi.fn()];
    },
    useEffect: () => {},
  };
});
vi.mock("@/lib/use-preview-search", () => ({
  usePreviewSearch: () => ({ matches: h.matches, pending: false }),
}));
vi.mock("@/lib/hljs-utils", async (original) => {
  const actual = await original<typeof import("../src/lib/hljs-utils")>();
  h.plain.mockImplementation(actual.plainCodeLines);
  return { ...actual, plainCodeLines: h.plain };
});
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children: ReactNode }) => children;
  return { Dialog: pass, DialogContent: pass, DialogTitle: pass };
});
vi.mock("@/stores/files-store", () => ({
  useFilesStore: (select: (s: unknown) => unknown) => select({ workspaceId: "ws", version: 1 }),
  downloadWorkspaceFile: vi.fn(),
}));
vi.mock("@/stores/preview-store", () => ({
  usePreviewStore: (select: (s: unknown) => unknown) =>
    select({
      recent: [],
      textContent: {
        workspaceId: "ws",
        path: "qa.txt",
        content: h.content,
        loading: false,
        error: "",
      },
    }),
  loadTextPreview: vi.fn(),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 20,
    getVirtualItems: () => [{ index: 0, key: 0, start: 0 }],
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

import { CodePreviewModal, MarkdownPreview } from "../src/components/chat/CodePreviewModal";

function code() {
  h.index = 0;
  h.state = 0;
  return renderToString(
    createElement(CodePreviewModal, { filePath: "qa.txt", filename: "qa.txt", open: true }),
  );
}
function markdown(content: string) {
  h.mode = "markdown";
  h.index = 0;
  h.state = 0;
  return MarkdownPreview({ content });
}
function child(node: unknown, type: unknown): { props: { children: string } } | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map((n) => child(n, type)).find(Boolean);
  const el = node as { type?: unknown; props?: { children: unknown } };
  if (el.type === type) return node as { props: { children: string } };
  return child(el.props?.children, type);
}
beforeEach(() => {
  h.memos = [];
  h.index = 0;
  h.state = 0;
  h.mode = "code";
  h.content = "visible <tag>&value";
  h.plain.mockClear();
  h.highlighted = null;
  h.matches = [];
});
test("unchanged visible code lines reuse escaped markup across parent renders", () => {
  const first = code();
  const second = code();
  expect(first).toBe(second);
  expect(second).toContain("visible &lt;tag&gt;&amp;value");
  expect(h.plain).toHaveBeenCalledTimes(1);
  h.content = "replacement <b>";
  expect(code()).toContain("replacement &lt;b&gt;");
  expect(h.plain).toHaveBeenCalledTimes(2);
});
test("unchanged Markdown source keeps the same renderer element for React reconciliation", () => {
  const a = child(markdown("# A"), h.renderer),
    b = child(markdown("# A"), h.renderer);
  expect(a).toBeDefined();
  expect(b).toBe(a);
  const changed = child(markdown("# B"), h.renderer);
  expect(changed).not.toBe(a);
  expect(changed?.props.children).toBe("# B");
  h.renderer = () => null;
  expect(child(markdown("# B"), h.renderer)).not.toBe(changed);
});

test("a completed highlight replaces plain markup and changed source does not retain old colors", () => {
  expect(code()).toContain("visible &lt;tag&gt;&amp;value");
  h.highlighted = ['<span class="hljs-keyword">colored</span>'];
  expect(code()).toContain('<span class="hljs-keyword">colored</span>');
  expect(h.plain).toHaveBeenCalledTimes(1);
  h.highlighted = null;
  h.matches = [];
  h.content = "new <source>";
  const changed = code();
  expect(changed).toContain("new &lt;source&gt;");
  expect(changed).not.toContain("colored");
  expect(h.plain).toHaveBeenCalledTimes(2);
});

test("large plain previews do not split every line into strings before showing the viewport", () => {
  h.content = "large preview line\n".repeat(60000);
  const split = vi.spyOn(String.prototype, "split");
  try {
    const html = code();
    expect(html).toContain("large preview line");
    expect(split.mock.contexts.filter((value) => String(value) === h.content)).toHaveLength(0);
  } finally {
    split.mockRestore();
  }
});

test("displaying search hits does not copy the entire match list into a Set", () => {
  h.content = "visible line\n".repeat(50000);
  h.matches = Uint32Array.from({ length: 50000 }, (_, i) => i);
  let copies = 0;
  const OriginalSet = Set;
  class TrackingSet extends OriginalSet<unknown> {
    constructor(values?: Iterable<unknown> | null) {
      super(values);
      if (values === h.matches) copies++;
    }
  }
  vi.stubGlobal("Set", TrackingSet);
  try {
    expect(code()).toContain("visible line");
    expect(copies).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
