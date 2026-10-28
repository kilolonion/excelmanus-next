import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ApprovalState, SessionState, ToolState } from "../src/lib/session/types";

const h = vi.hoisted(() => ({
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  mi: 0,
  effects: [] as Array<{ run: () => void | (() => void); deps: unknown[] }>,
  states: [] as unknown[],
  si: 0,
  session: null as unknown as SessionState,
  viewAgentId: "main",
  selectors: [] as Array<
    (state: {
      session: SessionState;
      viewAgentId: string;
      sessionId: string;
      compacting: Record<string, boolean>;
    }) => unknown
  >,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const override = {
    memo: (fn: unknown) => fn,
    useId: () => "details",
    useCallback: (fn: unknown) => fn,
    useEffect: (run: () => void | (() => void), deps: unknown[]) => {
      h.effects.push({ run, deps });
    },
    useRef: (value: unknown) => ({ current: value }),
    useState: (initial: unknown) => {
      const i = h.si++;
      if (!(i in h.states)) h.states[i] = typeof initial === "function" ? initial() : initial;
      return [
        h.states[i],
        (value: unknown) => {
          h.states[i] = typeof value === "function" ? value(h.states[i]) : value;
        },
      ];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.mi++,
        old = h.memos[i];
      if (old && deps.length === old.deps.length && deps.every((d, j) => Object.is(d, old.deps[j])))
        return old.value;
      const value = fn();
      h.memos[i] = { deps, value };
      return value;
    },
  };
  return { ...react, ...override, default: { ...react, ...override } };
});
vi.mock("@/hooks/use-mobile", async (original) => ({
  ...(await original<typeof import("../src/hooks/use-mobile")>()),
  useIsMobile: () => false,
}));
vi.mock("@/stores/chat-store", async (original) => {
  const actual = await original<typeof import("../src/stores/chat-store")>();
  return {
    ...actual,
    useChatStore: Object.assign(
      (
        select: (state: {
          session: SessionState;
          viewAgentId: string;
          sessionId: string;
          compacting: Record<string, boolean>;
        }) => unknown,
      ) => {
        h.selectors.push(select);
        return select({
          session: h.session,
          viewAgentId: h.viewAgentId,
          sessionId: "s",
          compacting: {},
        });
      },
      actual.useChatStore,
    ),
  };
});

import { ApprovalInline } from "../src/components/chat/ApprovalInline";
import { CodeBlock } from "../src/components/chat/CodeBlock";
import { ContextUsageButton } from "../src/components/chat/ContextUsageButton";
import { ToolCallCard } from "../src/components/chat/ToolCallCard";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";

function render(fn: () => ReactNode) {
  h.mi = 0;
  h.si = 0;
  h.effects = [];
  return fn();
}
function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text((node as { props?: { children?: unknown } }).props?.children);
}
beforeEach(() => {
  h.memos = [];
  h.states = [];
  h.selectors = [];
  h.viewAgentId = "main";
  h.session = initialSessionState();
});

test("tool timer and collapse reuse JSON detail strings, new result stays current", () => {
  let reads = 0;
  const args = {
    get payload() {
      reads++;
      return "argument";
    },
  };
  const data = {
    get payload() {
      reads++;
      return "result";
    },
  };
  h.session.tools.t = {
    id: "t",
    name: "custom",
    phase: "running",
    agentId: "main",
    args,
    result: { data },
  } as ToolState;
  const show = () => render(() => ToolCallCard({ toolId: "t" }));
  show();
  expect(reads).toBe(0);
  h.states[0] = true;
  h.states[1] = true;
  expect(text(show())).toContain('"payload": "result"');
  expect(reads).toBe(2);
  reads = 0;
  h.states[2] = 3;
  show();
  h.states[0] = false;
  show();
  h.states[0] = true;
  show();
  expect(reads).toBe(0);
  h.session.tools.t = {
    ...h.session.tools.t!,
    phase: "done",
    result: { data: { payload: "new result" } },
  } as ToolState;
  expect(text(show())).toContain('"payload": "new result"');
});

test("running tool timer does not rescan unchanged workbook operations for labels", () => {
  let reads = 0;
  const args = {
    ops: Array.from({ length: 200 }, () => ({
      get op() {
        reads++;
        return "cells.set";
      },
      get range() {
        reads++;
        return "A1";
      },
    })),
  };
  h.session.tools.t = {
    id: "t",
    name: "workbook_edit",
    phase: "running",
    agentId: "main",
    args,
  } as ToolState;
  const show = () => render(() => ToolCallCard({ toolId: "t" }));
  show();
  expect(reads).toBeGreaterThan(0);
  reads = 0;
  h.states[2] = 2;
  show();
  expect(reads).toBe(0);
  h.session.tools.t = {
    ...h.session.tools.t!,
    args: { path: "changed.xlsx", ops: [{ op: "cells.set", range: "B2" }] },
  };
  expect(text(show())).toContain("changed.xlsx");
  expect(text(show())).toContain("B2");
});

test("approval reason edits reuse target plan, labels and visible JSON without changing decisions", () => {
  let reads = 0;
  const args = {
    ops: Array.from({ length: 200 }, () => ({
      get op() {
        reads++;
        return "cells.set";
      },
      range: "A1",
      values: [[1]],
    })),
  };
  let approval = {
    id: "a",
    toolName: "workbook_edit",
    args,
    effect: "write",
    status: "pending",
    targets: [],
  } as unknown as ApprovalState;
  const show = () => render(() => ApprovalInline({ approval }));
  show();
  h.states[4] = true;
  show();
  expect(reads).toBeGreaterThan(0);
  reads = 0;
  h.states[2] = true;
  h.states[3] = "reason";
  show();
  h.states[1] = true;
  show();
  expect(reads).toBe(0);
  approval = { ...approval, args: { ops: [{ op: "cells.set", range: "B2", values: [[2]] }] } };
  expect(text(show())).toContain("B2");
});

function nextTextState() {
  return {
    session: reduceSession(h.session, {
      type: "delta",
      topic: "session:s",
      agentId: "main",
      stepId: "step",
      part: 1,
      kind: "text",
      payload: "token",
    }),
    viewAgentId: "main",
    sessionId: "s",
    compacting: {},
  };
}

test("context usage subscriptions do not scan unchanged compaction history on text deltas", () => {
  let reads = 0;
  h.session.timelines.main = Array.from({ length: 200 }, (_, i) => ({
    get kind() {
      reads++;
      return i === 0 ? "compaction" : "notice";
    },
    seq: i,
  })) as never;
  render(() => ContextUsageButton());
  expect(reads).toBe(200);
  reads = 0;
  const next = nextTextState();
  for (const select of h.selectors) select(next);
  expect(reads).toBe(0);
});

function findComponent(
  node: unknown,
  name: string | typeof CodeBlock,
): { type: (props: { tool: ToolState }) => ReactNode; props: { tool: ToolState } } | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findComponent(item, name);
      if (found) return found;
    }
    return;
  }
  const el = node as {
    type?: { name?: string; type?: { name?: string } };
    props?: { children?: unknown };
  };
  if (typeof name === "string" ? (el.type?.name ?? el.type?.type?.name) === name : el.type === name)
    return node as ReturnType<typeof findComponent>;
  return findComponent(el.props?.children, name);
}

test("inline result subscriptions do not search unchanged change history on text deltas", () => {
  let reads = 0;
  h.session.changes = Array.from({ length: 200 }, (_, i) => ({
    get toolCallId() {
      reads++;
      return `t${i}`;
    },
    path: `p${i}`,
    ranges: [],
  })) as never;
  const tool = {
    id: "t199",
    name: "workbook_edit",
    phase: "done",
    status: "ok",
    agentId: "main",
    args: {},
  } as ToolState;
  h.session.tools[tool.id] = tool;
  h.states[0] = true;
  h.states[1] = true;
  const inline = findComponent(
    render(() => ToolCallCard({ toolId: tool.id })),
    "InlineResult",
  );
  expect(inline).toBeDefined();
  if (!inline) throw Error("missing inline result");
  h.memos = [];
  h.selectors = [];
  const first = render(() => inline.type(inline.props));
  expect(reads).toBe(200);
  reads = 0;
  for (const select of h.selectors) select(nextTextState());
  expect(reads).toBe(0);
  const changed = { ...h.session.changes[199], path: "changed.xlsx" };
  h.session.changes = [changed];
  const latest = render(() => inline.type(inline.props));
  expect((first as { props: { change: unknown } }).props.change).not.toBe(changed);
  expect((latest as { props: { change: unknown } }).props.change).toBe(changed);
});

test("context usage counts refresh with new history and agent view", () => {
  h.session.live.main = { contextUsage: { tokens: 1, window: 100 } } as never;
  h.session.live.child = { contextUsage: { tokens: 2, window: 100 } } as never;
  h.session.timelines.main = [{ kind: "compaction", seq: 1 }] as never;
  expect(text(render(() => ContextUsageButton()))).toContain("已压缩: 1 次");
  h.session.timelines.main = [...h.session.timelines.main, { kind: "compaction", seq: 2 }] as never;
  expect(text(render(() => ContextUsageButton()))).toContain("已压缩: 2 次");
  h.viewAgentId = "child";
  expect(text(render(() => ContextUsageButton()))).not.toContain("已压缩:");
});

function detailHarness() {
  let mounted: Array<{ deps: unknown[]; cleanup: void | (() => void) }> = [];
  const show = () => {
    const tree = render(() => ToolCallCard({ toolId: "t" }));
    h.effects.forEach((effect, i) => {
      if (mounted[i] && effect.deps.every((dep, j) => Object.is(dep, mounted[i].deps[j]))) return;
      mounted[i]?.cleanup?.();
      mounted[i] = { deps: effect.deps, cleanup: effect.run() };
    });
    return tree;
  };
  return {
    show,
    close: () => {
      for (const effect of mounted) effect.cleanup?.();
      mounted = [];
    },
  };
}
function prepareFinishedTool() {
  h.session.tools.t = {
    id: "t",
    name: "custom",
    phase: "done",
    status: "ok",
    agentId: "main",
    args: { payload: "large argument" },
    result: { data: { payload: "large result" } },
  } as ToolState;
}
test("closed tool details release content after collapse and ignore later hidden results", () => {
  vi.useFakeTimers();
  prepareFinishedTool();
  const page = detailHarness();
  try {
    h.states[0] = true;
    h.states[1] = true;
    expect(text(page.show())).toContain("large result");
    h.states[0] = false;
    page.show();
    vi.advanceTimersByTime(219);
    expect(text(page.show())).toContain("large result");
    vi.advanceTimersByTime(1);
    expect(text(page.show())).not.toContain("large result");
    let reads = 0;
    h.session.tools.t = {
      ...h.session.tools.t!,
      result: {
        data: {
          get payload() {
            reads++;
            return "latest result";
          },
        },
      },
    } as ToolState;
    page.show();
    expect(reads).toBe(0);
    h.states[0] = true;
    h.states[1] = true;
    expect(text(page.show())).toContain("latest result");
    expect(reads).toBe(1);
  } finally {
    page.close();
    vi.useRealTimers();
  }
});
test("reopening during collapse cancels the pending detail release", () => {
  vi.useFakeTimers();
  prepareFinishedTool();
  const page = detailHarness();
  try {
    h.states[0] = true;
    h.states[1] = true;
    page.show();
    h.states[0] = false;
    page.show();
    vi.advanceTimersByTime(100);
    h.states[0] = true;
    page.show();
    vi.advanceTimersByTime(500);
    expect(text(page.show())).toContain("large result");
    expect(h.states[1]).toBe(true);
  } finally {
    page.close();
    vi.useRealTimers();
  }
});
test("unmounting cancels the pending tool detail release", () => {
  vi.useFakeTimers();
  prepareFinishedTool();
  const page = detailHarness();
  try {
    h.states[0] = false;
    h.states[1] = true;
    page.show();
    expect(vi.getTimerCount()).toBe(1);
    page.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(h.states[1]).toBe(true);
  } finally {
    page.close();
    vi.useRealTimers();
  }
});

test("collapsed script details unmount the code block that owns its highlighter worker", () => {
  vi.useFakeTimers();
  prepareFinishedTool();
  h.session.tools.t = {
    ...h.session.tools.t!,
    name: "run_script",
    args: { code: "const x = 1;\n".repeat(4000) },
  };
  const page = detailHarness();
  try {
    h.states[0] = true;
    h.states[1] = true;
    expect(findComponent(page.show(), CodeBlock)).toBeDefined();
    h.states[0] = false;
    expect(findComponent(page.show(), CodeBlock)).toBeDefined();
    vi.advanceTimersByTime(220);
    expect(findComponent(page.show(), CodeBlock)).toBeUndefined();
  } finally {
    page.close();
    vi.useRealTimers();
  }
});
