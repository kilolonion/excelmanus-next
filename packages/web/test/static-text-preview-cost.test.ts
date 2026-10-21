import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ slots: [] as any[], index: 0 }));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i];
    if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.value;
    const value = fn();
    h.slots[i] = { deps, value };
    return value;
  };
  return {
    ...r,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value: unknown) => (h.slots[h.index++] ??= { current: value }),
    useState: (initial: any) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        h.slots[i],
        (next: any) => {
          h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next;
        },
      ];
    },
  };
});

import StreamingTextPreview from "../src/components/chat/StreamingTextPreview";
import { TextDiffView } from "../src/components/chat/TextDiffView";
import { ThinkingBlock } from "../src/components/chat/ThinkingBlock";
import { TextChange } from "../src/components/chat/tool-results";
import * as textDiff from "../src/lib/text-diff";
import * as thinking from "../src/lib/thinking";

function render(fn: () => unknown) {
  h.index = 0;
  return fn();
}
function nodes(node: any, type: string): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  vi.restoreAllMocks();
});

test("thinking clock updates reuse parsed lines and body nodes until text changes", () => {
  const parse = vi.fn(thinking.createThinkingLineReader());
  vi.spyOn(thinking, "createThinkingLineReader").mockReturnValue(parse);
  const content = "**heading**\n" + "reason\n".repeat(200);
  const first = render(() => ThinkingBlock({ content, isActive: true }));
  const strong = nodes(first, "strong")[0];
  expect(parse).toHaveBeenCalledTimes(1);
  h.slots[1] = 3;
  const next = render(() => ThinkingBlock({ content, isActive: true }));
  expect(parse).toHaveBeenCalledTimes(1);
  expect(nodes(next, "strong")[0]).toBe(strong);
  expect(JSON.stringify(next)).toContain("3s");
  render(() => ThinkingBlock({ content: content + "new", isActive: true }));
  expect(parse).toHaveBeenCalledTimes(2);
});

test("collapsed thinking reuses its preview but expanding still renders the full body", () => {
  const preview = vi.spyOn(thinking, "thinkingPreview");
  const content = "**heading** text";
  render(() => ThinkingBlock({ content }));
  const next = render(() => ThinkingBlock({ content }));
  expect(preview).toHaveBeenCalledTimes(1);
  nodes(next, "button")[0].props.onClick();
  expect(
    nodes(
      render(() => ThinkingBlock({ content })),
      "strong",
    )[0].props.children,
  ).toBe("heading");
});

test("streaming edits reuse unchanged deletion rows while new text keeps updating", () => {
  const root = StreamingTextPreview({
    toolName: "edit",
    rawArgs: JSON.stringify({ path: "a.txt", oldText: "old\n".repeat(200), newText: "first" }),
  }) as any;
  h.slots = [];
  const first = render(() => root.type(root.props));
  const oldRow = nodes(first, "tr")[0];
  const next = render(() => root.type({ ...root.props, newString: "second" }));
  expect(nodes(next, "tr")[0]).toBe(oldRow);
  expect(JSON.stringify(next)).toContain("second");
  const changed = render(() =>
    root.type({ ...root.props, oldString: "replacement", newString: "third" }),
  );
  expect(nodes(changed, "tr")[0]).not.toBe(oldRow);
  expect(JSON.stringify(changed)).toContain("replacement");
});

test("collapsed text diff does not parse hunks until opened and still supports full expansion", () => {
  let reads = 0;
  const hunks = new Proxy(
    Array.from({ length: 200 }, (_, i) => `+line${i}`),
    {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const data = { path: "a.txt", hunks, additions: 200, deletions: 0 };
  const first = render(() => TextDiffView({ data }));
  expect(reads).toBe(0);
  expect(nodes(first, "tr")).toHaveLength(0);
  nodes(first, "button")[0].props.onClick();
  const preview = render(() => TextDiffView({ data }));
  expect(reads).toBe(9);
  expect(nodes(preview, "tr")).toHaveLength(8);
  nodes(preview, "button")[1].props.onClick();
  expect(
    nodes(
      render(() => TextDiffView({ data })),
      "tr",
    ),
  ).toHaveLength(200);
  expect(reads).toBe(209);
});

test("short default-open diffs stay visible and reopening shows replacement data", () => {
  const data = { path: "a.txt", hunks: ["+first"], additions: 1, deletions: 0 };
  const opened = render(() => TextDiffView({ data, defaultOpen: true }));
  expect(nodes(opened, "tr")).toHaveLength(1);
  expect(nodes(opened, "button")).toHaveLength(1);
  nodes(opened, "button")[0].props.onClick();
  const replacement = { ...data, hunks: ["+second"] };
  const closed = render(() => TextDiffView({ data: replacement, defaultOpen: true }));
  expect(nodes(closed, "tr")).toHaveLength(0);
  nodes(closed, "button")[0].props.onClick();
  const next = render(() => TextDiffView({ data: replacement, defaultOpen: true }));
  expect(JSON.stringify(next)).toContain("second");
  expect(JSON.stringify(next)).not.toContain("first");
});

test("streaming writes reuse complete rows and move the cursor only when a new line arrives", () => {
  const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const root = StreamingTextPreview({
    toolName: "write",
    rawArgs: JSON.stringify({ path: "qa.txt", content }),
  }) as any;
  h.slots = [];
  const first = nodes(
    render(() => root.type(root.props)),
    "tr",
  );
  const second = nodes(
    render(() => root.type({ ...root.props, content: content + "!" })),
    "tr",
  );
  expect(second.filter((row, i) => row === first[i])).toHaveLength(99);
  expect(second[99]).not.toBe(first[99]);
  const third = nodes(
    render(() => root.type({ ...root.props, content: content + "!\nlast" })),
    "tr",
  );
  expect(third[98]).toBe(second[98]);
  expect(third[99]).not.toBe(second[99]);
  expect(JSON.stringify(third[99])).not.toContain("animate-pulse");
  expect(JSON.stringify(third[100])).toContain("animate-pulse");
});

test("streaming added diff rows reuse unchanged content but replacements remain visible", () => {
  const root = StreamingTextPreview({
    toolName: "edit",
    rawArgs: JSON.stringify({ path: "qa.txt", oldText: "old", newText: "first\nsecond" }),
  }) as any;
  h.slots = [];
  const first = nodes(
    render(() => root.type(root.props)),
    "tr",
  );
  const next = nodes(
    render(() => root.type({ ...root.props, newString: "first\nsecond!" })),
    "tr",
  );
  expect(next[0]).toBe(first[0]);
  expect(next[1]).toBe(first[1]);
  expect(next[2]).not.toBe(first[2]);
  const replaced = nodes(
    render(() => root.type({ ...root.props, newString: "changed" })),
    "tr",
  );
  expect(replaced).toHaveLength(2);
  expect(JSON.stringify(replaced[1])).toContain("changed");
  expect(JSON.stringify(replaced)).not.toContain("second!");
});

test("diff preview stops after enough display items and retains context folding", () => {
  const hunks = [
    "--- a",
    "+++ b",
    "@@ -10,12 +20,12 @@",
    ...Array.from({ length: 10 }, (_, i) => ` old${i}`),
    "+new",
    "-deleted",
  ];
  const data = { path: "qa.txt", hunks, additions: 1, deletions: 1 };
  const preview = render(() => TextDiffView({ data, defaultOpen: true }));
  expect(nodes(preview, "tr")).toHaveLength(6);
  expect(JSON.stringify(preview)).toContain("省略 ");
  expect(JSON.stringify(preview)).toContain("old0");
  expect(JSON.stringify(preview)).toContain("old9");
  expect(JSON.stringify(preview)).not.toContain("old5");
});

test("text-change rerenders reuse the same lazy diff until arguments change", () => {
  const build = vi.spyOn(textDiff, "writeDiff");
  const tool = {
    name: "write",
    args: { path: "qa.txt", content: "a\nb" },
    phase: "done",
    status: "ok",
  } as any;
  const first = render(() => TextChange({ tool })) as any;
  const next = render(() => TextChange({ tool: { ...tool, status: "partial" } })) as any;
  expect(build).toHaveBeenCalledTimes(1);
  expect(next.props.data).toBe(first.props.data);
  const replaced = render(() =>
    TextChange({ tool: { ...tool, args: { ...tool.args, content: "new" } } }),
  ) as any;
  expect(build).toHaveBeenCalledTimes(2);
  expect([...replaced.props.data.hunks]).toEqual(["@@ -0,0 +1,1 @@", "+new"]);
});

test("streamed thinking reuses completed line nodes while its unfinished tail grows", () => {
  const content = "**completed**\n" + "reason\n".repeat(200) + "tail";
  const first = render(() => ThinkingBlock({ content, isActive: true }));
  const strong = nodes(first, "strong")[0];
  const next = render(() => ThinkingBlock({ content: content + " **new", isActive: true }));
  expect(nodes(next, "strong")[0]).toBe(strong);
  expect(JSON.stringify(next)).toContain("new");
  const replacement = render(() => ThinkingBlock({ content: "**replacement**", isActive: true }));
  expect(JSON.stringify(replacement)).not.toContain("completed");
  expect(nodes(replacement, "strong")[0].props.children).toBe("replacement");
});

test("closing completed thinking releases the incremental reader until reopened", () => {
  const factory = vi.spyOn(thinking, "createThinkingLineReader");
  const content = "**saved**\nbody";
  const first = render(() => ThinkingBlock({ content, defaultExpanded: true }));
  expect(factory).toHaveBeenCalledTimes(1);
  nodes(first, "button")[0].props.onClick();
  const closed = render(() => ThinkingBlock({ content, defaultExpanded: true }));
  expect(nodes(closed, "strong")).toHaveLength(0);
  expect(factory).toHaveBeenCalledTimes(1);
  nodes(closed, "button")[0].props.onClick();
  render(() => ThinkingBlock({ content, defaultExpanded: true }));
  expect(factory).toHaveBeenCalledTimes(2);
});
