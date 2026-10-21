import type { LogRecord } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";
import type { SessionState, ToolState, TurnSegment } from "../src/lib/session/types";

const segment = (id: string): TurnSegment => ({
  kind: "turn",
  id: `${id}:0`,
  turnId: id,
  segment: 0,
  seq: 1,
  at: "2026-10-18T00:00:00Z",
  agentId: "main",
  status: "running",
  blocks: [],
  steps: 0,
});
function fixture() {
  let reads = 0;
  const history = Array.from({ length: 400 }, (_, i) => {
    const item = { ...segment(`old${i}`), status: "completed" as const };
    Object.defineProperty(item, "kind", {
      get: () => {
        reads++;
        return "turn";
      },
      enumerable: true,
    });
    return item;
  });
  const active = segment("active");
  const state: SessionState = {
    ...initialSessionState(),
    timelines: { main: [...history, active] },
    openSegments: { main: { turnId: "active", segment: 0, segmentId: active.id } },
  };
  return { state, active, reads: () => reads };
}
function record(state: SessionState, type: LogRecord["type"], data: Record<string, unknown>) {
  const seq = state.cursor + 1;
  return reduceSession(state, {
    type: "rec",
    topic: "session:s",
    seq,
    record: { type, data, seq, sessionId: "s", agentId: "main", createdAt: "2026-10-18T00:00:00Z" },
  });
}
test("updating the current tail segment does not inspect completed history", () => {
  const { state, active, reads } = fixture();
  const next = record(state, "step.started", { stepId: "step" });
  expect(reads()).toBe(0);
  expect(next.timelines.main.at(-1)).toMatchObject({ steps: 1 });
  expect(active.steps).toBe(0);
  expect(next.timelines.main[0]).toBe(state.timelines.main[0]);
});
test("registering a tool already in the tail does not scan earlier tool blocks", () => {
  const { state, active, reads } = fixture();
  active.blocks = [{ type: "tool", key: "call", seq: 1 }];
  const next = record(state, "tool.intent", { toolCallId: "call", toolName: "read" });
  expect(reads()).toBe(0);
  expect(next.tools.call.phase).toBe("running");
  expect(next.timelines.main).toBe(state.timelines.main);
});
test("ending a turn does not copy the tool dictionary when all calls have settled", () => {
  const state = initialSessionState();
  let reads = 0;
  for (let i = 0; i < 400; i++) {
    const tool: ToolState = {
      id: `tool${i}`,
      name: "read",
      agentId: "main",
      seq: i + 1,
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
  const next = record(state, "turn.completed", { turnId: "active" });
  expect(reads).toBe(400);
  expect(next.tools).toBe(state.tools);
});
test("non-tail segments and existing earlier tool blocks retain their fallback behavior", () => {
  const { state } = fixture();
  const old = state.timelines.main[0] as TurnSegment;
  old.blocks = [{ type: "tool", key: "earlier", seq: 1 }];
  state.openSegments.main = { turnId: old.turnId, segment: 0, segmentId: old.id };
  const stepped = record(state, "step.started", { stepId: "late-step" });
  expect(stepped.timelines.main[0]).toMatchObject({ steps: 1 });
  expect(stepped.timelines.main.at(-1)).toBe(state.timelines.main.at(-1));
  const tool = record(stepped, "tool.intent", { toolCallId: "earlier", toolName: "read" });
  expect(tool.timelines.main).toBe(stepped.timelines.main);
});

test("turn completion still finalizes only this agent's unexecuted calls immutably", () => {
  const state = initialSessionState();
  const planned: ToolState = {
    id: "planned",
    name: "read",
    agentId: "main",
    seq: 1,
    args: {},
    targets: [],
    phase: "planned",
  };
  const other = { ...planned, id: "other", agentId: "child" };
  state.tools = { planned, other };
  const next = record(state, "turn.completed", { turnId: "active" });
  expect(next.tools.planned).toMatchObject({ phase: "done", status: "not_executed" });
  expect(planned.phase).toBe("planned");
  expect(next.tools.other).toBe(other);
});
