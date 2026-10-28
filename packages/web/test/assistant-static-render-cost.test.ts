import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { SessionState, TurnSegment } from "../src/lib/session/types";

const h = vi.hoisted(() => ({
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  index: 0,
  session: null as unknown as SessionState,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const overrides = {
    memo: (fn: unknown) => fn,
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.index++,
        old = h.memos[i];
      if (old && deps.length === old.deps.length && deps.every((d, j) => Object.is(d, old.deps[j])))
        return old.value;
      const value = fn();
      h.memos[i] = { deps, value };
      return value;
    },
  };
  return { ...react, ...overrides, default: { ...react, ...overrides } };
});
vi.mock("@/stores/chat-store", async (original) => {
  const actual = await original<typeof import("../src/stores/chat-store")>();
  return {
    ...actual,
    useChatStore: Object.assign(
      (select: (state: { session: SessionState }) => unknown) => select({ session: h.session }),
      actual.useChatStore,
    ),
  };
});

import { ActivityGroup } from "../src/components/chat/ActivityGroup";
import { AssistantMessage } from "../src/components/chat/AssistantMessage";
import { MessageActions } from "../src/components/chat/MessageActions";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";

function render(segment: TurnSegment) {
  h.index = 0;
  return AssistantMessage({ segment, isLatest: true });
}
function delta() {
  h.session = reduceSession(h.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "token",
  });
}
function segment(): TurnSegment {
  return {
    kind: "turn",
    id: "t:0",
    turnId: "t",
    segment: 0,
    seq: 1,
    at: "2026-01-01T00:00:00Z",
    agentId: "main",
    status: "running",
    steps: 1,
    blocks: [],
  };
}
function components(node: unknown, type: unknown): Array<{ props: Record<string, unknown> }> {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => components(n, type));
  const el = node as {
    type?: { name?: string; type?: { name?: string } };
    props?: { children?: ReactNode };
  };
  return [
    ...(el.type === type ? [node as { props: Record<string, unknown> }] : []),
    ...components(el.props?.children, type),
  ];
}
beforeEach(() => {
  h.memos = [];
  h.index = 0;
  h.session = initialSessionState();
  h.session.openSegments.main = { segmentId: "t:0", turnId: "t", segment: 0 } as never;
});

test("text deltas reuse historical block nodes, copy text and clock formatting", () => {
  let reads = 0;
  const s = segment();
  s.blocks = Array.from({ length: 200 }, (_, i) => ({
    get type() {
      reads++;
      return "text" as const;
    },
    key: `b${i}`,
    seq: i,
    get text() {
      reads++;
      return `saved${i}`;
    },
  }));
  const clock = vi.spyOn(Date.prototype, "toLocaleTimeString");
  try {
    render(s);
    expect(reads).toBeGreaterThan(0);
    const firstClock = clock.mock.calls.length;
    reads = 0;
    delta();
    render(s);
    delta();
    const last = render(s);
    expect(reads).toBe(0);
    expect(clock).toHaveBeenCalledTimes(firstClock);
    expect(JSON.stringify(last)).toContain("tokentoken");
  } finally {
    clock.mockRestore();
  }
});

test("plain text increments do not re-enumerate unchanged pending tool arguments", () => {
  let enumerations = 0;
  const s = segment();
  delta();
  const args = new Proxy(
    { p: { name: "write", text: '{"path":"x"' } },
    {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    },
  );
  h.session.live.main = { ...h.session.live.main!, toolArgs: args };
  render(s);
  expect(enumerations).toBe(1);
  enumerations = 0;
  delta();
  render(s);
  expect(enumerations).toBe(0);
  h.session.live.main = { ...h.session.live.main!, toolArgs: { q: { name: "edit", text: "new" } } };
  expect(JSON.stringify(render(s))).toContain("正在准备：编辑文件 · 已接收 3 字符");
});

test("new block text and completion update copy payload and feedback sequence", () => {
  let s = segment();
  s.blocks = [{ type: "text", key: "one", seq: 2, text: "one" }];
  render(s);
  s = {
    ...s,
    status: "completed",
    endedAt: s.at,
    blocks: [...s.blocks, { type: "text", key: "two", seq: 3, text: "two" }],
  };
  const actions = components(render(s), MessageActions);
  expect(actions).toHaveLength(1);
  expect(actions[0].props.text).toBe("one\n\ntwo");
  expect(actions[0].props.feedbackSeq).toBe(3);
});

test("tool state and latest-row changes still update static tool groups", () => {
  let s = segment();
  s.blocks = [{ type: "tool", key: "task", seq: 2 }];
  h.session.tools.task = { id: "task", name: "todo", phase: "done", status: "ok" } as never;
  expect(components(render(s), ActivityGroup)).toHaveLength(0);
  h.session.tools = { ...h.session.tools, task: { ...h.session.tools.task!, status: "error" } };
  expect(components(render(s), ActivityGroup)).toHaveLength(1);
  s = { ...s, status: "completed", endedAt: s.at };
  h.index = 0;
  const old = AssistantMessage({ segment: s, isLatest: false });
  expect(components(old, ActivityGroup)[0].props.defaultCollapsed).toBe(true);
  expect(components(render(s), ActivityGroup)[0].props.defaultCollapsed).toBe(false);
});

test("copy actions retain complete long raw text including Markdown syntax", () => {
  const s = segment();
  s.status = "completed";
  s.endedAt = s.at;
  const raw = "| item | value |\n".repeat(8000) + "END_OF_RAW";
  s.blocks = [{ type: "text", key: "long", seq: 1, text: raw }];
  const tree = render(s);
  expect(components(tree, MessageActions)[0]?.props.text === raw).toBe(true);
});
