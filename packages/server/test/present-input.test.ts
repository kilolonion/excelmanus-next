import { createReadTable, type QuestionCoordinator, type SessionLog } from "@excelmanus/kernel";
import { expect, test, vi } from "vitest";
import { interactionTools } from "../src/interactions.ts";

test("present decodes finalize once then keeps strict reference schema", () => {
  const tool = interactionTools({} as SessionLog, {} as QuestionCoordinator).find(
    (entry) => entry.name === "present",
  );
  if (!tool) throw new Error("missing present");
  const finalize = {
    status: "complete",
    sources: [{ refId: 'nr1:["call_actual","/data/rows"]' }],
  };
  expect(tool.input.parse({ finalize: JSON.stringify(finalize) })).toEqual({ finalize });
  for (const value of [
    "broken",
    "[]",
    JSON.stringify(JSON.stringify(finalize)),
    JSON.stringify({ ...finalize, value: 999 }),
    JSON.stringify({
      ...finalize,
      sources: [{ refId: 'nr1:["call_actual","/data/rows"]', value: 999 }],
    }),
  ])
    expect(tool.input.safeParse({ finalize: value }).success).toBe(false);
});

test("present decodes a JSON-encoded payload once and validates it before logging", async () => {
  const append = vi.fn();
  const tool = interactionTools(
    { append } as unknown as SessionLog,
    {} as QuestionCoordinator,
  ).find((tool) => tool.name === "present")!;
  const payload = { kind: "focus", path: "qa.xlsx", range: "A1", note: "已核对" };
  const args = tool.input.parse({ payload: JSON.stringify(payload) });
  await tool.execute(args, {
    workspaceId: "w",
    workspaceRoot: "/tmp",
    sessionId: "s",
    agentId: "main",
    toolCallId: "p",
    role: "main",
    signal: new AbortController().signal,
    reads: createReadTable(),
    backups: {
      needsBackup: () => false,
      ensureBackup: () => undefined,
      list: () => [],
      markCreated: () => {
        throw new Error("unexpected write");
      },
      backup: () => {
        throw new Error("unexpected write");
      },
      trash: () => {
        throw new Error("unexpected write");
      },
    },
  });
  expect(append).toHaveBeenCalledWith("s", "main", [{ type: "ui.present", data: payload }]);
  expect(tool.input.safeParse({ payload: "not JSON" }).success).toBe(false);
  expect(
    tool.input.safeParse({ payload: JSON.stringify({ ...payload, execute: "anything" }) }).success,
  ).toBe(false);
  expect(tool.inputJsonSchema).toHaveProperty("anyOf.0.properties.payload.oneOf");
});

test("todo accepts one JSON-encoded items array but rejects malformed and non-array input", () => {
  const tool = interactionTools({} as SessionLog, {} as QuestionCoordinator).find(
    (t) => t.name === "todo",
  )!;
  const items = [{ id: "1", title: "跨表核对" }];
  expect(tool.input.parse({ op: "set", items: JSON.stringify(items) })).toEqual({
    op: "set",
    items,
  });
  expect(tool.input.parse({ op: "set", items })).toEqual({ op: "set", items });
  for (const value of ["broken", "{}", "[1]", JSON.stringify(JSON.stringify(items))])
    expect(tool.input.safeParse({ op: "set", items: value }).success).toBe(false);
  expect(JSON.stringify(tool.inputJsonSchema)).toContain('"type":"array"');
});

test("present explains the required payload wrapper instead of accepting misplaced fields", () => {
  const tool = interactionTools({} as SessionLog, {} as QuestionCoordinator).find(
    (t) => t.name === "present",
  )!;
  const bad = tool.input.safeParse({ kind: "file", path: "qa.xlsx" });
  expect(bad.success).toBe(false);
  if (bad.success) throw new Error("invalid arguments accepted");
  expect(bad.error.issues.map((issue) => issue.message).join("\n")).toContain(
    '{"payload":{"kind":"file","path":"报告.xlsx"}}',
  );
  expect(tool.description).toContain('{"payload":');
});

test("todo rejects mixed operation fields with exact set and update examples", () => {
  const tool = interactionTools({} as SessionLog, {} as QuestionCoordinator).find(
    (t) => t.name === "todo",
  )!;
  for (const args of [
    { op: "set", items: [], todoId: "1", status: "done" },
    { op: "update", todoId: "1", status: "done", items: [] },
    { op: "update", todoId: "1", items: '[{"id":"1","status":"done","title":"核验"}]' },
  ]) {
    const bad = tool.input.safeParse(args);
    expect(bad.success).toBe(false);
    if (bad.success) throw new Error("invalid arguments accepted");
    const message = bad.error.issues.map((issue) => issue.message).join("\n");
    expect(message).toContain('"op":"set"');
    expect(message).toContain('"op":"update"');
  }
  expect(tool.description).toContain('"todoId"');
});
