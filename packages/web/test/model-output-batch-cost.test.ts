import type { LogRecord } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";
import type { Block, SessionState, ToolState, TurnSegment } from "../src/lib/session/types";

const segment = (): TurnSegment => ({
  kind: "turn",
  id: "turn:0",
  turnId: "turn",
  segment: 0,
  seq: 1,
  at: "2026-10-18T00:00:00Z",
  agentId: "main",
  status: "running",
  blocks: [],
  steps: 1,
});
function fixture() {
  const seg = segment();
  const state: SessionState = {
    ...initialSessionState(),
    timelines: { main: [seg] },
    openSegments: { main: { turnId: "turn", segment: 0, segmentId: seg.id } },
  };
  return { state, seg };
}
function output(state: SessionState, data: Record<string, unknown>) {
  const seq = state.cursor + 1;
  const record: LogRecord = {
    type: "model.output",
    seq,
    sessionId: "s",
    agentId: "main",
    createdAt: "2026-10-18T00:00:00Z",
    data,
  };
  return reduceSession(state, { type: "rec", topic: "session:s", seq, record });
}
const calls = () =>
  Array.from({ length: 20 }, (_, i) => ({
    id: `new-${i}`,
    name: "read",
    args: { path: `${i}.txt` },
  }));

test("multi-tool output preserves historical entries and adds calls without mutating input", () => {
  const { state } = fixture();
  let reads = 0;
  for (let i = 0; i < 100; i++) {
    const tool: ToolState = {
      id: `old-${i}`,
      name: "read",
      agentId: "main",
      seq: 1,
      args: {},
      targets: [],
      phase: "done",
      status: "ok",
    };
    Object.defineProperty(state.tools, tool.id, {
      enumerable: true,
      get: () => {
        reads++;
        return tool;
      },
    });
  }
  const next = output(state, { stepId: "step", toolCalls: calls() });
  expect(reads).toBe(100);
  expect(Object.keys(next.tools)).toHaveLength(120);
  expect(Object.keys(state.tools)).toHaveLength(100);
});

test("one output checks existing blocks once instead of once per new tool", () => {
  const { state, seg } = fixture();
  let reads = 0;
  seg.blocks = Array.from({ length: 100 }, (_, i) => {
    const block = { type: "text", key: `old-${i}`, seq: 1, text: "old" } as Block;
    Object.defineProperty(block, "type", {
      enumerable: true,
      get: () => {
        reads++;
        return "text";
      },
    });
    return block;
  });
  const next = output(state, {
    stepId: "step",
    reasoning: "thinking",
    reasoningMs: 5,
    text: "answer",
    toolCalls: calls(),
  });
  expect(reads).toBeLessThanOrEqual(300);
  expect((next.timelines.main[0] as TurnSegment).blocks).toHaveLength(122);
  expect(seg.blocks).toHaveLength(100);
});

test("batched blocks keep order, first duplicate arguments, and existing tool status", () => {
  const { state, seg } = fixture();
  const old: ToolState = {
    id: "existing",
    name: "read",
    agentId: "main",
    seq: 1,
    args: { path: "original" },
    targets: [],
    phase: "done",
    status: "ok",
  };
  state.tools.existing = old;
  seg.blocks = [{ type: "tool", key: "existing", seq: 1 }];
  const next = output(state, {
    stepId: "step",
    reasoning: "think",
    text: "text",
    toolCalls: [
      { id: "new", name: "read", args: { path: "first" } },
      { id: "new", name: "write", args: { path: "second" } },
      { id: "existing", name: "write" },
      { name: "invalid" },
    ],
  });
  expect((next.timelines.main[0] as TurnSegment).blocks.map((b) => [b.type, b.key])).toEqual([
    ["tool", "existing"],
    ["thinking", "think:step"],
    ["text", "text:step"],
    ["tool", "new"],
  ]);
  expect(next.tools.new).toMatchObject({ name: "read", args: { path: "first" }, phase: "planned" });
  expect(next.tools.existing).toBe(old);
});

test("an interrupted open turn creates only one continuation segment for all blocks", () => {
  const { state } = fixture();
  state.openSegments.main.segmentId = null;
  const next = output(state, {
    stepId: "step",
    reasoning: "think",
    text: "answer",
    toolCalls: calls(),
  });
  expect(next.timelines.main).toHaveLength(2);
  expect(next.timelines.main[1]).toMatchObject({ id: "turn:1", segment: 1 });
  expect((next.timelines.main[1] as TurnSegment).blocks).toHaveLength(22);
});

test("an empty output does not create an orphan segment and retry resolution remains intact", () => {
  const empty = output(initialSessionState(), { toolCalls: [{ name: "invalid" }] });
  expect(empty.timelines).toEqual({});
  const { state, seg } = fixture();
  seg.blocks = [
    {
      type: "retry",
      key: "retry",
      seq: 1,
      attempt: 1,
      waitMs: 1000,
      reason: "temporary",
      resolved: false,
    },
  ];
  const next = output(state, { text: "recovered" });
  expect((next.timelines.main[0] as TurnSegment).blocks[0]).toMatchObject({ resolved: true });
  expect(seg.blocks[0]).toMatchObject({ resolved: false });
});
