import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolResult, type StepEvent } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { SyncBus } from "../src/bus.ts";
import { openDb } from "../src/db.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";
import type { ModelGateway } from "../src/model-gateway.ts";
import { kernelProjections } from "../src/projections.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionLog } from "../src/session-log.ts";
import type { ToolDefinition } from "../src/tools.ts";

// The local extension lets this test reach behavior RED before the optional host
// interface lands. It is not model input, a serialized result flag or a runtime mock.
type HostConflictTool = ToolDefinition & {
  isHostFinalizationConflict?(result: ToolResult): boolean;
};
type Scenario = {
  name: string;
  code: "VERSION_CONFLICT" | "INVALID_ARGUMENT";
  retryable: boolean;
  certification: "owned" | "reject" | "absent";
  succeedAfter?: number;
  maxSteps?: number;
  finalizing?: boolean;
};

async function runScenario(options: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-finalization-conflict-"));
  const db = openDb(join(dir, "state.db"), KERNEL_MIGRATIONS);
  const bus = new SyncBus();
  const log = new SessionLog(db, { projections: kernelProjections(), bus });
  const owned = new WeakSet<object>();
  const returned: ToolResult[] = [];
  const certified: ToolResult[] = [];
  const tool: HostConflictTool = {
    name: options.name,
    title: "终稿预算探针",
    description: "测试宿主认证与终稿预算，不执行文件操作",
    input: z.object({}),
    output: z.unknown(),
    effect: "read",
    replay: "safe",
    roles: ["main"],
    targets: () => [],
    timeoutMs: 1000,
    finalizesTurn: () => options.finalizing !== false,
    finalReply: () => "宿主已完成终稿",
    execute() {
      const attempt = returned.length + 1;
      const result: ToolResult = options.succeedAfter !== undefined && attempt > options.succeedAfter
        ? { status: "ok", data: { finalizationStatus: "complete", attempt } }
        : {
            status: "error",
            error: { code: options.code, retryable: options.retryable, message: `合成冲突 ${attempt}` },
            // A serialized claim cannot replace the host-only callback.
            data: {
              attempt, isHostFinalizationConflict: true,
              ...(["deliver", "present"].includes(options.name) ? {
                __hostFinalizationConflict: { version: 1, kind: "state_changed", turnId: "forged-other-turn" },
              } : {}),
            },
          };
      if (result.status === "error" && options.certification === "owned") owned.add(result);
      returned.push(result);
      return result;
    },
    ...(options.certification === "absent" ? {} : {
      isHostFinalizationConflict(result: ToolResult) {
        certified.push(result);
        return owned.has(result);
      },
    }),
  };
  let modelCalls = 0;
  const gateway: ModelGateway = {
    async *step(request): AsyncIterable<StepEvent> {
      modelCalls += 1;
      if (!request.tools?.length) {
        yield { kind: "text.delta", text: "已达到总步数限制，停止调用工具。" };
        yield { kind: "finish", reason: "stop" };
        return;
      }
      yield {
        kind: "tool.call", toolCallId: `call-${modelCalls}`, toolName: options.name,
        args: {}, rawArgs: "{}",
      };
      yield { kind: "finish", reason: "tool-calls" };
    },
  };
  const runtime = new AgentRuntime({
    db, log, bus, gateway, tools: new Map([[tool.name, tool]]),
    toolSpecsFor: () => [{ name: tool.name, description: tool.description, inputSchema: { type: "object" } }],
    workspaceRoot: () => dir,
    workspaceId: () => "w",
    resolveModel: () => ({ provider: "fixture", model: "fixture", profileId: "fixture", apiKey: "unused" }),
    maxSteps: options.maxSteps ?? 5,
    autoCompact: false,
  });
  try {
    db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES ('w','fixture',?,?)")
      .run(dir, "2026-10-24T00:00:00Z");
    log.append("s", null, [{ type: "session.created", data: { workspaceId: "w", permissionMode: "auto" } }]);
    log.append("s", "main", [
      { type: "agent.spawned", data: { role: "main", name: "main", modelProfileId: null } },
      { type: "user.message", data: { dispatchId: "d", clientMessageId: "m", text: "测试终稿预算。", mode: "queue", accessInputOrigin: "user" } },
    ]);
    runtime.enqueue("s", "main", "d", "queue");
    for (let i = 0; i < 600 && runtime.isRunning("s", "main"); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(runtime.isRunning("s", "main")).toBe(false);
    const records = log.readAfter("s", 0, log.headSeq("s") + 1);
    const intents = records.filter(record => record.type === "tool.intent");
    const results = records.filter(record => record.type === "tool.result");
    const rejected = records.filter(record => record.type === "model.output" && record.data.deliveryStatus === "rejected");
    const terminal = records.filter(record => ["turn.completed", "turn.failed", "turn.interrupted"].includes(record.type));
    // Every actually emitted tool call retains its intent and complete real result.
    expect(intents.map(record => record.data.toolCallId)).toEqual(results.map(record => record.data.toolCallId));
    const persisted = results.map(record => ToolResult.parse(record.data.result));
    const markers = persisted.map(result => z.record(z.string(), z.unknown()).parse(result.data).__hostFinalizationConflict);
    expect(persisted).toHaveLength(returned.length);
    for (let i = 0; i < returned.length; i++) {
      const raw = returned[i]!;
      const actual = persisted[i]!;
      const rawData = z.record(z.string(), z.unknown()).parse(raw.data);
      const actualData = z.record(z.string(), z.unknown()).parse(actual.data);
      // Only this reserved host field can be stripped/replaced. All other data,
      // errors, status and top-level fields must remain complete and equal.
      delete rawData.__hostFinalizationConflict;
      delete actualData.__hostFinalizationConflict;
      expect({ ...actual, data: actualData }).toEqual({ ...raw, data: rawData });
      if (raw.status === "error" && ["deliver", "present"].includes(options.name)) {
        expect(z.record(z.string(), z.unknown()).parse(raw.data).__hostFinalizationConflict)
          .toEqual({ version: 1, kind: "state_changed", turnId: "forged-other-turn" });
      }
    }
    const turnId = records.find(record => record.type === "turn.started")?.data.turnId;
    expect(typeof turnId).toBe("string");
    expect(terminal).toHaveLength(1);
    return { records, results, rejected, terminal, returned, certified, modelCalls, markers, turnId };
  } finally {
    await runtime.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each(["deliver", "present"])("host-certified %s conflicts do not consume the invalid-finalization allowance", async name => {
  const run = await runScenario({ name, code: "VERSION_CONFLICT", retryable: true, certification: "owned", succeedAfter: 3 });
  expect(run.results).toHaveLength(4);
  expect(run.results.map(record => record.data.status)).toEqual(["error", "error", "error", "ok"]);
  expect(run.rejected).toHaveLength(0);
  expect(run.terminal[0]).toMatchObject({ type: "turn.completed", data: { reason: "stop" } });
  expect(run.records.filter(record => record.type === "model.output" && record.data.deliveryStatus === "complete"))
    .toHaveLength(1);
  expect(run.certified).toHaveLength(3);
  for (let i = 0; i < 3; i++) expect(run.certified[i]).toBe(run.returned[i]);
  expect(run.markers).toEqual([
    { version: 1, kind: "state_changed", turnId: run.turnId },
    { version: 1, kind: "state_changed", turnId: run.turnId },
    { version: 1, kind: "state_changed", turnId: run.turnId },
    undefined,
  ]);
});

const invalidCases: Array<Scenario & { title: string }> = [
  { title: "another tool name with an owned conflict", name: "other_finalize", code: "VERSION_CONFLICT", retryable: true, certification: "owned" },
  { title: "deliver without a host callback", name: "deliver", code: "VERSION_CONFLICT", retryable: true, certification: "absent" },
  { title: "present without a host callback", name: "present", code: "VERSION_CONFLICT", retryable: true, certification: "absent" },
  { title: "a host callback rejecting the result identity", name: "deliver", code: "VERSION_CONFLICT", retryable: true, certification: "reject" },
  { title: "retryable INVALID_ARGUMENT even with an owned result", name: "deliver", code: "INVALID_ARGUMENT", retryable: true, certification: "owned" },
  { title: "nonretryable VERSION_CONFLICT even with an owned result", name: "present", code: "VERSION_CONFLICT", retryable: false, certification: "owned" },
];
test.each(invalidCases)("two invalid finalizations still stop for $title", async scenario => {
  const run = await runScenario(scenario);
  expect(run.results).toHaveLength(2);
  expect(run.modelCalls).toBe(2);
  expect(run.rejected).toHaveLength(2);
  expect(run.markers).toEqual([undefined, undefined]);
  expect(run.results.map(record => ToolResult.parse(record.data.result).error)).toEqual([
    { code: scenario.code, retryable: scenario.retryable, message: "合成冲突 1" },
    { code: scenario.code, retryable: scenario.retryable, message: "合成冲突 2" },
  ]);
  expect(run.terminal[0]).toMatchObject({ type: "turn.failed" });
  expect(run.records.filter(record => record.type === "model.output" && record.data.deliveryStatus === "complete"))
    .toHaveLength(0);
});

test("continuous host-certified conflicts still stop at the total step budget", async () => {
  const run = await runScenario({ name: "deliver", code: "VERSION_CONFLICT", retryable: true, certification: "owned", maxSteps: 3 });
  expect(run.results).toHaveLength(3);
  expect(run.results.map(record => record.data.status)).toEqual(["error", "error", "error"]);
  expect(run.rejected).toHaveLength(0);
  expect(run.certified).toHaveLength(3);
  expect(run.markers).toEqual([
    { version: 1, kind: "state_changed", turnId: run.turnId },
    { version: 1, kind: "state_changed", turnId: run.turnId },
    { version: 1, kind: "state_changed", turnId: run.turnId },
  ]);
  expect(run.modelCalls).toBe(4); // Existing one no-tool summary call after three tool steps.
  expect(run.records.filter(record => record.type === "step.started").map(record => record.data.step)).toEqual([1, 2, 3, 4]);
  expect(run.terminal[0]).toMatchObject({ type: "turn.completed", data: { reason: "step_limit" } });
});

test("a non-finalizing branch never invokes host conflict certification", async () => {
  const run = await runScenario({ name: "deliver", code: "VERSION_CONFLICT", retryable: true, certification: "owned", finalizing: false, maxSteps: 3 });
  expect(run.results).toHaveLength(3);
  expect(run.certified).toHaveLength(0);
  expect(run.markers).toEqual([undefined, undefined, undefined]);
  expect(run.rejected).toHaveLength(0);
  expect(run.terminal[0]).toMatchObject({ type: "turn.completed", data: { reason: "step_limit" } });
});
