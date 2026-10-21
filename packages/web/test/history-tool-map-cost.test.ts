import { readFileSync } from "node:fs";
import type { LogRecord, ServerMessage } from "@excelmanus/protocol";
import { expect, test, vi } from "vitest";
import {
  createHistoryReplay,
  initialSessionState,
  reduceSession,
} from "../src/lib/session/reducer";

function records(): LogRecord[] {
  const out: LogRecord[] = [];
  const add = (type: LogRecord["type"], data: Record<string, unknown>, agentId = "main") =>
    out.push({
      seq: out.length + 1,
      sessionId: "s",
      agentId,
      type,
      data,
      createdAt: "2026-10-18T00:00:00Z",
    });
  for (let i = 0; i < 40; i++) {
    const agent = i % 2 ? "child" : "main",
      id = `tool${i}`;
    add("turn.started", { turnId: `t${i}` }, agent);
    add(
      "model.output",
      {
        stepId: `step${i}`,
        text: "body",
        toolCalls: [{ id, name: "read", args: { path: "x.xlsx" } }],
      },
      agent,
    );
    add("tool.intent", { toolCallId: id, toolName: "read" }, agent);
    add("approval.requested", { approvalId: `a${i}`, toolCallId: id, toolName: "read" }, agent);
    add("approval.decided", { approvalId: `a${i}`, decision: "approved" }, agent);
    add(
      "question.asked",
      {
        questionId: `q${i}`,
        questionType: "text",
        spec: { _runtime: { toolCallId: id }, prompt: "question" },
      },
      agent,
    );
    add("question.answered", { questionId: `q${i}`, answer: "yes" }, agent);
    add(
      "tool.result",
      { toolCallId: id, status: "ok", result: { status: "ok", data: { value: i } } },
      agent,
    );
    add(
      "model.output",
      { stepId: `last${i}`, toolCalls: [{ id: `unexecuted${i}`, name: "read", args: {} }] },
      agent,
    );
    add("turn.completed", { turnId: `t${i}` }, agent);
  }
  return out;
}
function legacy(rows: LogRecord[]) {
  let s = initialSessionState();
  for (const record of rows)
    s = reduceSession(s, {
      type: "rec",
      topic: `session:${record.sessionId}`,
      seq: record.seq,
      record,
    });
  return s;
}
test("private tool-map replay matches immutable reduction across tool lifecycle and agents", () => {
  const rows = records(),
    replay = createHistoryReplay();
  for (const r of rows) replay.push(r);
  expect(replay.finish()).toEqual(legacy(rows));
});
test("recorded session history produces exactly the same final view", () => {
  const messages = JSON.parse(
    readFileSync(new URL("./fixtures/session-stream.json", import.meta.url), "utf8"),
  ) as ServerMessage[];
  const rows = messages
    .filter((m): m is Extract<ServerMessage, { type: "rec" }> => m.type === "rec")
    .map((m) => m.record);
  const replay = createHistoryReplay();
  for (const r of rows) replay.push(r);
  expect(replay.finish()).toEqual(legacy(rows));
});
test("published history can only receive immutable live updates", () => {
  const rows = records(),
    replay = createHistoryReplay();
  for (const r of rows) replay.push(r);
  const state = replay.finish(),
    previous = JSON.stringify(state),
    last = {
      ...rows[0],
      seq: rows.length + 1,
      type: "tool.intent" as const,
      data: { toolCallId: "tool0", toolName: "late" },
    };
  const next = reduceSession(state, {
    type: "rec",
    topic: "session:s",
    seq: last.seq,
    record: last,
  });
  expect(next.tools).not.toBe(state.tools);
  expect(next.tools.tool0.name).toBe("late");
  expect(JSON.stringify(state)).toBe(previous);
  expect(() => replay.push(last)).toThrow();
  expect(JSON.stringify(state)).toBe(previous);
});
test("parallel private replays do not share their mutable tool maps", () => {
  const [first, ...rest] = records(),
    a = createHistoryReplay(),
    b = createHistoryReplay();
  a.push(first);
  for (const r of rest) a.push(r);
  const second = {
    ...first,
    type: "tool.intent" as const,
    data: { toolCallId: "other", toolName: "read" },
  };
  b.push(second);
  expect(Object.keys(b.finish().tools)).toEqual(["other"]);
  expect(a.finish().tools.other).toBeUndefined();
});

test("private turn endings do not enumerate already settled tools", () => {
  const replay = createHistoryReplay();
  const values = vi.spyOn(Object, "values");
  try {
    for (const record of records()) replay.push(record);
    const toolScans = values.mock.calls.filter(([object]) => Object.hasOwn(object, "tool0"));
    expect(toolScans.length).toBe(0);
    expect(replay.finish().tools.unexecuted39.status).toBe("not_executed");
  } finally {
    values.mockRestore();
  }
});

test("outputs before any retry do not scan old timeline segments for retry blocks", () => {
  const replay = createHistoryReplay(),
    rows = records();
  for (const record of rows) replay.push(record);
  const add = (type: LogRecord["type"], data: Record<string, unknown>) =>
    replay.push({
      seq: rows.length + (type === "turn.started" ? 1 : 2),
      sessionId: "s",
      agentId: "main",
      type,
      data,
      createdAt: "2026-10-18T00:00:00Z",
    });
  add("turn.started", { turnId: "next" });
  const map = vi.spyOn(Array.prototype, "map");
  try {
    add("model.output", { text: "new text", stepId: "next" });
    const scans = map.mock.contexts.filter(
      (array) => Array.isArray(array) && array[0]?.kind === "turn",
    );
    expect(scans.length).toBe(0);
  } finally {
    map.mockRestore();
  }
});

test.each(["turn.completed", "turn.failed", "turn.interrupted"] as const)(
  "private settlement preserves multi-agent planned, running and retry states on %s",
  (ending) => {
    const rows: LogRecord[] = [];
    const add = (type: LogRecord["type"], data: Record<string, unknown>, agentId = "main") =>
      rows.push({
        seq: rows.length + 1,
        sessionId: "s",
        agentId,
        type,
        data,
        createdAt: "2026-10-18T00:00:00Z",
      });
    add("retry.scheduled", { reason: "orphan before first turn" });
    add("turn.started", { turnId: "main-turn" });
    add("model.output", {
      toolCalls: [
        { id: "running", name: "read" },
        { id: "waiting", name: "read" },
      ],
    });
    add("turn.started", { turnId: "child-turn" }, "child");
    add("model.output", { toolCalls: [{ id: "child-plan", name: "read" }] }, "child");
    add("retry.scheduled", { reason: "retry in current main turn" });
    add("tool.intent", { toolCallId: "running", toolName: "read" });
    add("model.output", { text: "retry resolved", toolCalls: [{ id: "waiting", name: "read" }] });
    add(ending, { turnId: "child-turn" }, "child");
    add(ending, { turnId: "main-turn" });
    add("retry.scheduled", { reason: "late retry" });
    add("turn.started", { turnId: "main-turn" });
    add("model.output", { text: "resumed", toolCalls: [{ id: "new-plan", name: "read" }] });
    add(ending, { turnId: "main-turn" });
    const replay = createHistoryReplay();
    for (const row of rows) replay.push(row);
    const result = replay.finish();
    expect(result).toEqual(legacy(rows));
    expect(result.tools.running.phase).toBe("running");
    for (const id of ["waiting", "child-plan", "new-plan"])
      expect(result.tools[id]).toMatchObject({ phase: "done", status: "not_executed" });
    expect(replay.finish()).toBe(result);
  },
);
