import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => (() => void) | void)[],
  renderer: vi.fn(),
  retry: null as null | (() => void),
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
          state.values[index] = typeof value === "function" ? value(state.values[index]) : value;
        },
      ];
    },
    useEffect: (effect: () => (() => void) | void) => {
      state.effects.push(effect);
    },
  };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: (props: { onClick: () => void; children: string }) => {
      state.retry = props.onClick;
      return createElement("button", props);
    },
  };
});
vi.mock("react-markdown", () => ({
  get default() {
    return state.renderer();
  },
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("@/stores/files-store", () => ({ useFilesStore: vi.fn(), downloadWorkspaceFile: vi.fn() }));
vi.mock("@/stores/preview-store", () => ({ usePreviewStore: vi.fn(), loadTextPreview: vi.fn() }));

import { MarkdownPreview } from "../src/components/chat/CodePreviewModal";

function render() {
  state.index = 0;
  state.effects = [];
  return renderToString(createElement(MarkdownPreview, { content: "# retained source" }));
}
beforeEach(() => {
  state.values = [];
  state.renderer.mockReset().mockImplementation(() => () => null);
});
test("markdown renderer failure keeps source readable and exposes local retry", async () => {
  state.renderer.mockImplementationOnce(() => {
    throw new Error("renderer unavailable");
  });
  render();
  state.effects[0]();
  await vi.waitFor(() => expect(render()).toContain("重新加载预览"));
  expect(render()).toContain("# retained source");
  state.retry?.();
  render();
  state.effects[0]();
  await vi.waitFor(() => expect(render()).not.toContain("重新加载预览"));
});
test("closing markdown preview suppresses a late initialization error", async () => {
  state.renderer.mockImplementation(() => {
    throw new Error("renderer unavailable");
  });
  render();
  const cancel = state.effects[0]();
  cancel?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(render()).not.toContain("重新加载预览");
});
