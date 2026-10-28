import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ slots: [] as unknown[], index: 0, markdown: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const overrides = {
    memo: (fn: unknown) => fn,
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useDeferredValue: (v: unknown) => v,
    useState: (initial: unknown) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = initial;
      return [
        h.slots[i],
        (value: unknown) => {
          h.slots[i] = typeof value === "function" ? value(h.slots[i]) : value;
        },
      ];
    },
  };
  return { ...react, ...overrides, default: { ...react, ...overrides } };
});
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    h.markdown(children);
    return createElement("section", null, children);
  },
}));
vi.mock("@/lib/use-streaming-markdown-text", () => ({
  useStreamingMarkdownText: (content: string) => content,
}));

import { MemoizedMarkdown } from "../src/components/chat/assistant-blocks/MemoizedMarkdown";

type Node = {
  type?: unknown;
  props?: { children?: ReactNode; onClick?: () => void; disabled?: boolean };
};
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function render(content: string, streaming = false) {
  h.index = 0;
  return MemoizedMarkdown({ content, isStreamingText: streaming });
}
const long = "| item | value |\n".repeat(4000) + "END_OF_COMPLETE_RAW";
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.markdown.mockClear();
});
test("long content first renders the complete escaped raw source without Markdown work", () => {
  const tree = render(long + "<script>not executable</script>");
  expect(nodes(tree).find((n) => n.type === "pre")?.props?.children).toBe(
    long + "<script>not executable</script>",
  );
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("END_OF_COMPLETE_RAW");
  expect(html).toContain("&lt;script&gt;");
  expect(h.markdown).not.toHaveBeenCalled();
  expect(nodes(tree).some((n) => n.type === "button" && n.props?.children === "排版阅读")).toBe(
    true,
  );
});
test("ordinary messages retain automatic Markdown at the length boundary", () => {
  const content = "x".repeat(50000),
    tree = render(content);
  renderToStaticMarkup(tree);
  expect(h.markdown).toHaveBeenCalledExactlyOnceWith(content);
  expect(nodes(tree).some((n) => n.type === "pre")).toBe(false);
});
test("explicit formatting uses the whole source and replacing content immediately returns to raw", () => {
  const tree = render(long);
  nodes(tree)
    .find((n) => n.type === "button" && n.props?.children === "排版阅读")
    ?.props?.onClick?.();
  renderToStaticMarkup(render(long));
  expect(h.markdown).toHaveBeenCalledExactlyOnceWith(long);
  h.markdown.mockClear();
  const changed = render(long + "NEW");
  renderToStaticMarkup(changed);
  expect(h.markdown).not.toHaveBeenCalled();
  expect(nodes(changed).find((n) => n.type === "pre")?.props?.children).toBe(long + "NEW");
});
test("streaming stays raw and enables formatted reading only after completion", () => {
  const active = render(long, true);
  renderToStaticMarkup(active);
  expect(
    nodes(active).find((n) => n.type === "button" && n.props?.children === "排版阅读")?.props
      ?.disabled,
  ).toBe(true);
  const final = render(long + "FINAL", false);
  renderToStaticMarkup(final);
  expect(h.markdown).not.toHaveBeenCalled();
  expect(nodes(final).find((n) => n.type === "pre")?.props?.children).toBe(long + "FINAL");
  expect(
    nodes(final).find((n) => n.type === "button" && n.props?.children === "排版阅读")?.props
      ?.disabled,
  ).toBe(false);
});
