import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  kernelProjections,
  type ModelGateway,
  SessionLog,
  type StepRequest,
} from "@excelmanus/kernel";
import { createGateway } from "@excelmanus/models";
import { createApiClient, type LogRecord, type StepEvent } from "@excelmanus/protocol";
import { afterAll, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
// Only the round-nine cases register timing diagnostics; cleanup order is unchanged.
type RoundNineDiagnostic = (phase: string, detail?: Record<string, string | number | boolean>) => void;
const roundNineServerDiagnostics = new Map<RunningServer, RoundNineDiagnostic>();
const roundNineDirDiagnostics = new Map<string, RoundNineDiagnostic>();
const roundNineBeforeClose = new Map<RunningServer, () => void>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (value: string): StepEvent[] => [
  { kind: "text.delta", text: value },
  { kind: "finish", reason: "stop" },
];
const call = (id: string, toolName: string, args: unknown): StepEvent[] => [
  { kind: "tool.call", toolCallId: id, toolName, args, rawArgs: JSON.stringify(args) },
  { kind: "finish", reason: "tool-calls" },
];
// Handles are copied only from the model-visible inspect payload, never private host state.
function inspectedFactSetIds(request: StepRequest): string[] {
  const receipt = request.history.findLast(item => item.kind === "toolResult" && item.toolName === "deliver");
  if (!receipt || receipt.kind !== "toolResult") throw new Error("missing visible inspect receipt");
  const output = receipt.output as { data?: { action?: string; factSets?: { id: string }[] } };
  if (output.data?.action !== "inspect" || !output.data.factSets?.length) throw new Error("missing visible fact sets");
  return output.data.factSets.map(fact => fact.id);
}
const create = (id = "write"): StepEvent[] =>
  call(id, "workbook_edit", {
    path: "numbers.xlsx",
    create: true,
    ops: [
      {
        op: "cells.set",
        range: "A1:C3",
        values: [
          ["项目", "原值", "舍入值"],
          ["甲", 2.345, null],
          ["乙", 5.675, null],
        ],
      },
      { op: "cells.set", range: "C2:C3", values: [["=ROUND(B2,2)"], ["=ROUND(B3,2)"]] },
    ],
  });

for (const encodedFinalize of [false, true]) {
  test(`真实 provider 正文引用不能认证未计划写入；事实集可部分交付且不借外层 ID：string=${encodedFinalize}`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "numeric-receipt-"));
    dirs.push(dataDir);
    let requests = 0;
    const copiedSources: unknown[] = [];
    const fetchModel = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      requests += 1;
      let name: string | undefined;
      let args: unknown;
      if (requests === 1) {
        name = "workbook_edit";
        const event = create()[0];
        if (event?.kind !== "tool.call") throw new Error("缺少写入夹具");
        args = event.args;
      } else if (requests === 2) {
        name = "workbook_read";
        args = {
          path: "numbers.xlsx",
          mode: "range",
          range: "A1:C3",
          facets: ["values", "formulas", "styles"],
        };
      } else if (requests === 4) {
        name = "deliver";
        args = { action: "inspect" };
      } else if (requests === 5) {
        const inspected = body.messages.filter(message => message.role === "tool")
          .map(message => JSON.parse(message.content) as { data?: { action?: string; factSets?: { id: string }[] } })
          .findLast(output => output.data?.action === "inspect");
        if (!inspected?.data?.factSets?.length) throw new Error("missing provider-visible inspect handles");
        name = "deliver";
        args = { action: "finalize", outcome: "partial", factSetIds: inspected.data.factSets.map(fact => fact.id) };
      } else {
        // The model only sees tool content. Never inspect messages[].tool_call_id,
        // assistant tool_calls, StepRequest.history, or any ID generated below.
        const content = body.messages
          .filter((message) => message.role === "tool")
          .map(
            (message) =>
              JSON.parse(message.content) as {
                data?: { mode?: string };
                numericEvidence?: { sources: unknown[]; docRevs: Record<string, number> };
              },
          )
          .findLast((output) => output.data?.mode === "range");
        if (content?.numericEvidence?.sources.length && requests <= 4) {
          copiedSources.push(...content.numericEvidence.sources);
          expect(Object.keys(content.numericEvidence.docRevs).length).toBeGreaterThan(0);
          name = "present";
          const finalize = { status: "complete", sources: content.numericEvidence.sources };
          args = { finalize: encodedFinalize ? JSON.stringify(finalize) : finalize };
        }
      }
      const chunk = {
        id: "provider-fixture",
        choices: [
          {
            index: 0,
            delta: name
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${randomUUID()}`,
                      type: "function",
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                }
              : { content: "工具正文没有可复制的证据引用，无法提交。" },
            finish_reason: name ? "tool_calls" : "stop",
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const realGateway = createGateway();
    const gateway: ModelGateway = {
      step: (request) =>
        realGateway.step({ ...request, model: { ...request.model, fetch: fetchModel } }),
    };
    const server = await startServer({ dataDir, gateway, log: () => {} });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "provider-content",
      provider: "custom-openai-compatible",
      model: "mock-numeric",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", {
      clientMessageId: "provider-content",
      text: "计算并回读数字后交付",
    });
    let items: LogRecord[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      items = (await api.getSessionLog(session.id, { limit: 1000 })).items;
      if (items.some((row) => ["turn.completed", "turn.failed"].includes(row.type))) break;
      await sleep(15);
    }
    expect(items.some((row) => row.type === "turn.failed")).toBe(false);
    expect(items.some((row) => row.type === "turn.completed")).toBe(true);
    expect(requests).toBe(5);
    expect(items.some(row => row.type === "tool.result" && row.data.toolName === "present" && row.data.status === "error")).toBe(true);
    expect(copiedSources.length).toBeGreaterThan(0);
    expect(
      items.filter((row) => row.type === "model.output" && row.data.sourceToolCallId).at(-1)?.data,
    ).toMatchObject({ deliveryStatus: "incomplete", text: expect.stringContaining("2.35") });
  });
}

afterAll(async () => {
  for (const server of servers) {
    const diagnostic = roundNineServerDiagnostics.get(server);
    diagnostic?.("cleanup.server.start");
    roundNineBeforeClose.get(server)?.();
    await server.close();
    diagnostic?.("cleanup.server.end");
  }
  for (const dir of dirs) {
    const diagnostic = roundNineDirDiagnostics.get(dir);
    diagnostic?.("cleanup.directory.start");
    rmSync(dir, { recursive: true, force: true });
    diagnostic?.("cleanup.directory.end");
  }
});

async function boot(
  handler: (request: StepRequest, step: number) => StepEvent[] | Promise<StepEvent[]>,
  diagnostic?: RoundNineDiagnostic,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "numeric-delivery-"));
  dirs.push(dataDir);
  let steps = 0;
  const gateway: ModelGateway = {
    async *step(request) {
      for (const event of await handler(request, ++steps)) yield event;
    },
  };
  const server = await startServer({ dataDir, gateway, log: () => {} });
  servers.push(server);
  const api = createApiClient(server.url, server.token);
  await createTestProfile(api, {
    name: "mock",
    provider: "custom-openai-compatible",
    model: "mock-numeric",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "test",
  });
  const { session } = await api.createSession({});
  const log = async () => {
    diagnostic?.("http.log.start");
    const items = (await api.getSessionLog(session.id, { limit: 1000 })).items;
    diagnostic?.("http.log.end", {
      rows: items.length,
      terminals: items.filter(row => ["turn.completed", "turn.failed"].includes(row.type)).length,
    });
    return items;
  };
  const wait = async (predicate: (items: LogRecord[]) => boolean) => {
    const end = Date.now() + 20_000;
    for (;;) {
      const items = await log();
      if (predicate(items)) return items;
      if (Date.now() > end) throw new Error(`等待日志超时：${items.map((x) => x.type).join(",")}`);
      await sleep(15);
    }
  };
  const send = (clientMessageId = "m", message = "计算并解释两种舍入口径的差异") =>
    api.sendMessage(session.id, "main", { clientMessageId, text: message });
  return { server, api, session, dataDir, wait, send, log, steps: () => steps };
}

test("真实公式拒绝自由算理 final，实际计算事实部分交付且不认证未检查输出", async () => {
  const bad = "这两个尾数合并为 12406.335，整体进位 0.005。";
  const t = await boot((request, step) => {
    if (step === 1) return create();
    if (step === 2) return text(bad);
    if (step === 3)
      return call("explanation", "workbook_analyze", {
        path: "numbers.xlsx",
        mode: "sql",
        range: "A1:C3",
        sql: 'SELECT SUM("原值") AS "原始合计", SUM("舍入值") AS "逐行舍入合计", ROUND(SUM("原值"),2)-SUM("原值") AS "整体舍入增量", SUM("舍入值"-"原值") AS "逐行舍入增量" FROM data',
      });
    if (step === 4) return call("inspect", "deliver", { action: "inspect" });
    if (step === 5) return call("finish", "deliver", { action: "finalize", outcome: "partial", factSetIds: inspectedFactSetIds(request) });
    throw new Error("证据终稿后不应再次调用模型");
  });
  const { ticket } = await t.api.createTicket();
  const ws = new WebSocket(`ws://127.0.0.1:${t.server.port}/api/v1/sync?ticket=${ticket}`);
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "sub", topic: `session:${t.session.id}`, cursor: 0 }));
  try {
    await t.send();
    const items = await t.wait((all) =>
      all.some((r) => ["turn.completed", "turn.failed"].includes(r.type)),
    );
    expect(
      items.find((r) => r.type === "tool.result" && r.data.toolCallId === "write")?.data.result,
    ).toMatchObject({
      status: "ok",
      data: { formulaValues: { "Sheet1!C2": 2.35, "Sheet1!C3": 5.68 } },
    });
    const final = items.filter((r) => r.type === "model.output" && r.data.text).at(-1);
    expect(final?.data.text).not.toContain(bad);
    expect(final?.data.sourceToolCallId).toBe("finish");
    expect(final?.data.text).toContain("整体舍入增量");
    expect(final?.data.text).toContain("逐行舍入增量");
    expect(final?.data.text).toContain("8.02");
    expect(t.steps()).toBe(5);
    expect(final?.data.deliveryStatus).toBe("incomplete");
    expect(final?.data.text).toContain("unverified");
    expect(items.some((r) => r.type === "model.output" && r.data.withheldText === bad)).toBe(true);
    expect(
      messages.filter((m) => m.type === "delta").some((m) => JSON.stringify(m).includes(bad)),
    ).toBe(false);
    expect(items.filter((r) => r.type === "turn.completed")).toHaveLength(1);
  } finally {
    ws.close();
  }
});

test("重复绕过终稿门有界失败，不把无数值空话当成功交付", async () => {
  const t = await boot((_request, step) =>
    step === 1
      ? create()
      : [
          { kind: "usage", usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
          ...text("已处理完成"),
        ],
  );
  await t.send();
  const items = await t.wait((all) =>
    all.some((r) => ["turn.completed", "turn.failed"].includes(r.type)),
  );
  expect(items.some((r) => r.type === "turn.failed")).toBe(true);
  expect(items.some((r) => r.type === "turn.completed")).toBe(false);
  expect(items.filter((r) => r.type === "model.output" && r.data.text)).toHaveLength(0);
  expect(t.steps()).toBe(3);
  const db = new DatabaseSync(join(t.dataDir, "excelmanus.db"));
  try {
    const usage = () =>
      JSON.parse(
        (
          db
            .prepare("SELECT usage FROM agents WHERE session_id=? AND id='main'")
            .get(t.session.id) as { usage: string }
        ).usage,
      );
    expect(usage()).toMatchObject({
      inputTokens: 22,
      outputTokens: 14,
      totalTokens: 36,
      toolCalls: 1,
    });
    const context = () =>
      db
        .prepare("SELECT item FROM agent_context WHERE session_id=? ORDER BY idx")
        .all(t.session.id);
    const before = context();
    new SessionLog(db, { projections: kernelProjections() }).rebuild(t.session.id);
    expect(context()).toEqual(before);
    expect(JSON.stringify(context())).not.toContain("已处理完成");
    expect(usage()).toMatchObject({
      inputTokens: 22,
      outputTokens: 14,
      totalTokens: 36,
      toolCalls: 1,
    });
  } finally {
    db.close();
  }
});

test("明确 finalize 的非法参数两次即失败，普通 present 参数错不耗终稿机会", async () => {
  const t = await boot((_request, step) => {
    if (step === 1) return create();
    if (step <= 3) return call(`ordinary-${step}`, "present", { payload: "broken" });
    if (step > 5) return text("不应走到此额外终稿");
    return call(`malformed-${step}`, "present", {
      finalize: JSON.stringify(JSON.stringify({ status: "complete", sources: [] })),
    });
  });
  await t.send();
  const items = await t.wait((all) => all.some((row) => row.type === "turn.failed"));
  expect(t.steps()).toBe(5);
  expect(
    items.filter((row) => row.type === "model.output" && row.data.deliveryStatus === "rejected"),
  ).toHaveLength(2);
  expect(
    items.filter((row) => row.type === "tool.result" && row.data.toolName === "present"),
  ).toHaveLength(4);
  expect(items.some((row) => row.type === "turn.completed")).toBe(false);
});

test("数值门的步数上限使用固定未完成状态，不再调用自由 forceFinal", async () => {
  const t = await boot((_request, step) => (step === 1 ? create() : text("forceFinal 虚构 999")));
  const db = new DatabaseSync(join(t.dataDir, "excelmanus.db"));
  try {
    db.prepare("UPDATE agents SET budget=? WHERE session_id=? AND id='main'").run(
      JSON.stringify({ maxSteps: 1 }),
      t.session.id,
    );
  } finally {
    db.close();
  }
  await t.send();
  const items = await t.wait((all) => all.some((r) => r.type === "turn.completed"));
  expect(t.steps()).toBe(1);
  expect(items.find((r) => r.type === "turn.completed")?.data.reason).toBe("step_limit");
  const final = items.filter((r) => r.type === "model.output" && r.data.text).at(-1);
  expect(final?.data.deliveryStatus).toBe("incomplete");
  expect(final?.data.text).toContain("交付未完成");
  expect(final?.data.text).toContain("实际工具执行事实");
  expect(final?.data.text).toContain("numbers.xlsx");
  expect(final?.data.text).toContain("docRevs=");
  expect(final?.data.text).not.toContain("999");
});

test("子代理也受数值门约束，固定未完成状态进入报告而非虚构结果", async () => {
  let childSteps = 0;
  let mainSteps = 0;
  const t = await boot((request) => {
    if (request.system?.includes("子代理任务说明")) {
      childSteps += 1;
      if (childSteps === 1) return create();
      if (childSteps === 2) return text("子代理自行心算得 999");
      return call("child-finish", "present", { finalize: { status: "incomplete", sources: [] } });
    }
    mainSteps += 1;
    if (mainSteps === 1)
      return call("spawn", "agent_spawn", {
        name: "数字子任务",
        role: "worker",
        task: "计算工作簿",
        files: ["numbers.xlsx"],
      });
    return text("请查看子任务交付状态");
  });
  await t.send();
  const items = await t.wait((all) =>
    all.some((r) => r.type === "inbox.sent" && r.data.kind === "report"),
  );
  const childFinal = items.find(
    (r) => r.type === "model.output" && r.data.sourceToolCallId === "child-finish",
  );
  expect(childFinal?.data.deliveryStatus).toBe("incomplete");
  expect(childFinal?.data.text).toContain("交付未完成");
  expect(
    items.some((r) => r.type === "model.output" && r.data.text === "子代理自行心算得 999"),
  ).toBe(false);
  expect(childSteps).toBe(3);
  expect(
    String(items.find((r) => r.type === "inbox.sent" && r.data.kind === "report")?.data.message),
  ).toContain("交付未完成");
});

for (const numericChild of [true, false]) {
  test(`委派返回只按服务端数值任务标志传播给主代理：numeric=${numericChild}`, async () => {
    let childSteps = 0;
    let mainStarted = false;
    let reportedSteps = 0;
    const bad = numericChild ? "全委派后自由心算 12406.335" : "普通子任务汇总 42";
    const t = await boot((request) => {
      if (request.system?.includes("子代理任务说明")) {
        if (!numericChild) return text("已核对任务信息");
        childSteps += 1;
        if (childSteps === 1) return create();
        if (childSteps === 2)
          return call("child-read", "workbook_read", {
            path: "numbers.xlsx",
            mode: "range",
            range: "A1:C3",
            facets: ["values", "formulas", "styles"],
          });
        if (childSteps === 4) return call("child-inspect", "deliver", { action: "inspect" });
        if (childSteps === 5) return call("child-partial", "deliver", { action: "finalize", outcome: "partial", factSetIds: inspectedFactSetIds(request) });
        return call("child-complete", "present", {
          finalize: {
            status: "complete",
            sources: [{ refId: 'nr1:["child-read","/data/values"]' }],
          },
        });
      }
      if (!mainStarted) {
        mainStarted = true;
        return call("spawn", "agent_spawn", {
          name: "委派核算",
          role: "worker",
          task: "核对工作簿",
          files: ["numbers.xlsx"],
        });
      }
      if (!JSON.stringify(request.history).includes("【最终回复】")) return text("等待子任务交付");
      reportedSteps += 1;
      if (!numericChild || reportedSteps === 1) return text(bad);
      if (reportedSteps === 2)
        return call("parent-read", "workbook_read", {
          path: "numbers.xlsx",
          mode: "range",
          range: "A1:C3",
          facets: ["values", "formulas", "styles"],
        });
      if (reportedSteps === 3) return call("parent-inspect", "deliver", { action: "inspect" });
      return call("parent-finish", "deliver", { action: "finalize", outcome: "partial", factSetIds: inspectedFactSetIds(request) });
    });
    await t.send();
    const items = await t.wait((all) =>
      all.some(
        (r) =>
          r.type === "model.output" &&
          r.agentId === "main" &&
          (r.data.text === bad || r.data.sourceToolCallId === "parent-finish"),
      ),
    );
    const report = items.find((r) => r.type === "inbox.sent" && r.data.kind === "report");
    if (numericChild) {
      expect(items.some((r) => r.type === "model.output" && r.data.text === bad)).toBe(false);
      expect(report?.data.numericDelivery).toMatchObject({ outcome: "completed" });
      const final = items.find(
        (r) => r.type === "model.output" && r.data.sourceToolCallId === "parent-finish",
      );
      expect(final?.agentId).toBe("main");
      expect(final?.data.deliveryStatus).toBe("incomplete");
      expect(final?.data.text).toContain("unverified");
      expect(items.find(row => row.type === "tool.result" && row.data.toolCallId === "child-complete")?.data.result).toMatchObject({ status: "error" });
      expect(final?.data.text).toContain("2.35");
      expect(final?.data.text).toContain("parent-read");
    } else {
      expect(report?.data.numericDelivery).toBeUndefined();
      expect(items.some((r) => r.type === "model.output" && r.data.text === bad)).toBe(true);
    }
  });
}

for (const outcome of ["failed", "interrupted"] as const) {
  test(`子代理数值任务 ${outcome} 保持真实终态并传播未交付义务`, async () => {
    let childSteps = 0;
    let mainStarted = false;
    const t = await boot(async (request) => {
      if (request.system?.includes("子代理任务说明")) {
        childSteps += 1;
        if (childSteps === 1) return create();
        if (outcome === "failed") throw new Error("测试模型失败");
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return text("取消后不应展示的 999");
      }
      if (!mainStarted) {
        mainStarted = true;
        return call("spawn", "agent_spawn", {
          name: "异常子任务",
          role: "worker",
          task: "核对工作簿",
          files: ["numbers.xlsx"],
        });
      }
      if (!JSON.stringify(request.history).includes("【最终回复】")) return text("等待子任务交付");
      return call("main-incomplete", "present", {
        finalize: { status: "incomplete", sources: [] },
      });
    });
    await t.send();
    if (outcome === "interrupted") {
      const running = await t.wait(
        (all) =>
          childSteps > 1 &&
          all.some((r) => r.type === "tool.result" && r.data.toolCallId === "write"),
      );
      const childId = running.find(
        (r) => r.type === "tool.result" && r.data.toolCallId === "write",
      )?.agentId;
      expect(childId).toBeTruthy();
      if (!childId) throw new Error("缺少子代理 ID");
      await t.api.stopAgent(t.session.id, childId);
    }
    const items = await t.wait((all) =>
      all.some((r) => r.type === "model.output" && r.data.sourceToolCallId === "main-incomplete"),
    );
    const report = items.find((r) => r.type === "inbox.sent" && r.data.kind === "report");
    expect(report?.data.numericDelivery).toMatchObject({ outcome });
    const childTurn = (report?.data.numericDelivery as { turnId: string } | undefined)?.turnId;
    expect(
      items.some(
        (r) =>
          r.agentId === report?.agentId &&
          r.type === `turn.${outcome}` &&
          r.data.turnId === childTurn,
      ),
    ).toBe(true);
    expect(
      items.some(
        (r) =>
          r.agentId === report?.agentId &&
          r.type === "turn.completed" &&
          r.data.turnId === childTurn,
      ),
    ).toBe(false);
    expect(
      items.some((r) => r.type === "model.output" && r.data.text === "取消后不应展示的 999"),
    ).toBe(false);
    expect(
      items.find((r) => r.type === "model.output" && r.data.sourceToolCallId === "main-incomplete")
        ?.data.deliveryStatus,
    ).toBe("incomplete");
  });
}

test("普通只读和无关聊天不继承数值终稿门", async () => {
  const t = await boot((_request, step) =>
    step === 1
      ? call("read", "workbook_read", { path: "read.csv", mode: "range", range: "A1:B2" })
      : text("编号 00017，明天 2026-10-21 再看"),
  );
  writeFileSync(join(t.server.workspaceRoot, "read.csv"), "编号,值\n00017,3\n");
  await t.send();
  const items = await t.wait((all) => all.some((r) => r.type === "turn.completed"));
  expect(items.filter((r) => r.type === "model.output" && r.data.text).at(-1)?.data.text).toBe(
    "编号 00017，明天 2026-10-21 再看",
  );
  expect(t.steps()).toBe(2);
});

test("坏解释与普通工具同一步也不成为可见文字，文件呈现进度仍保留", async () => {
  const bad = "额外心算得 12406.335，所以整体进位 0.005。";
  const t = await boot((_request, step) => {
    if (step === 1) return create();
    if (step === 2)
      return [
        { kind: "text.delta", text: bad },
        ...call("file", "present", { payload: { kind: "file", path: "numbers.xlsx" } }),
      ];
    return call("incomplete", "present", { finalize: { status: "incomplete", sources: [] } });
  });
  await t.send();
  const items = await t.wait((all) =>
    all.some((r) => ["turn.completed", "turn.failed"].includes(r.type)),
  );
  expect(items.some((r) => r.type === "model.output" && r.data.text === bad)).toBe(false);
  expect(items.some((r) => r.type === "model.output" && r.data.withheldText === bad)).toBe(true);
  expect(items.some((r) => r.type === "ui.present" && r.data.path === "numbers.xlsx")).toBe(true);
  expect(
    items.filter((r) => r.type === "model.output" && r.data.text).at(-1)?.data.deliveryStatus,
  ).toBe("incomplete");
});

test("停止后显式继续继承未交付义务，新用户消息不继承", async () => {
  let hanging = false;
  const t = await boot(async (request, step) => {
    if (step === 1) return create();
    if (step === 2) {
      hanging = true;
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return [{ kind: "error", error: { kind: "aborted", message: "stopped", retryable: false } }];
    }
    return text("未经证据交付的合计 999");
  });
  await t.send();
  await t.wait(() => hanging);
  await t.api.stopAgent(t.session.id, "main");
  await t.wait((all) => all.some((r) => r.type === "turn.interrupted"));
  await t.api.resumeAgent(t.session.id, "main");
  const failed = await t.wait(
    (all) => all.filter((r) => ["turn.completed", "turn.failed"].includes(r.type)).length > 0,
  );
  expect(failed.some((r) => r.type === "turn.failed")).toBe(true);
  expect(
    failed.some((r) => r.type === "model.output" && r.data.text === "未经证据交付的合计 999"),
  ).toBe(false);
  await t.send("unrelated", "换个话题，只重复我说的日期");
  const normal = await t.wait((all) => all.some((r) => r.type === "turn.completed"));
  expect(normal.filter((r) => r.type === "model.output" && r.data.text).at(-1)?.data.text).toBe(
    "未经证据交付的合计 999",
  );
  const db = new DatabaseSync(join(t.dataDir, "excelmanus.db"));
  try {
    const resumed = db
      .prepare("SELECT data FROM session_log WHERE type='turn.started' ORDER BY seq")
      .all() as { data: string }[];
    expect(JSON.parse(resumed[1]?.data ?? "{}").numericDeliveryRequired).toBe(true);
    expect(resumed).toHaveLength(3);
    expect(JSON.parse(resumed[2]?.data ?? "{}").numericDeliveryRequired).toBeUndefined();
  } finally {
    db.close();
  }
});

import { numericEvidence } from "@excelmanus/protocol";
import { mkdirSync } from "node:fs";
test.each([{ oversize: false, scoped: true }, { oversize: true, scoped: true }, { oversize: false, scoped: false }])("round eight HTTP delivery keeps unchecked writes partial independent of presentation size: %j", async ({ oversize, scoped }) => {
  let checkedGuidance = false;
  const path = scoped ? "results/numbers.xlsx" : "numbers.xlsx";
  const values = [["对象", "净分"], ...Array.from({ length: oversize ? 16 : 2 }, (_, i) => [i === 0 ? "001" : String(i), i * 10])];
  const t = await boot((request, step) => {
    if (step === 1) return call("compact-write", "workbook_edit", { path, create: true, ops: [{ op: "cells.set", range: `A1:B${values.length}`, values }, { op: "cells.set", range: "C2", values: [["=SUM(B2:B3)"]] }] });
    if (step === 2) return call("compact-read", "workbook_read", { path, mode: "range", range: `A1:B${values.length}`, facets: ["values"] });
    if (step === 3) {
      const context = JSON.stringify(request);
      expect(context).toContain("deliver");
      expect(context).toContain("factSetIds");
      expect(context).toContain("unverified");
      checkedGuidance = true;
      return call("compact-inspect", "deliver", { action: "inspect" });
    }
    if (step === 4) return call("compact-finish", "deliver", { action: "finalize", outcome: "partial", factSetIds: inspectedFactSetIds(request) });
    throw new Error("typed partial delivery must end the turn");
  });
  if (scoped) mkdirSync(join(t.server.workspaceRoot, "results"));
  await t.send("compact-user", `${scoped ? "仅访问目录 results；" : ""}写入并保存表格，简短报告原文结果。`);
  const items = await t.wait(rows => rows.some(row => ["turn.completed", "turn.failed"].includes(row.type)));
  const final = items.findLast(row => row.type === "model.output" && row.data.sourceToolCallId === "compact-finish");
  const result = items.find(row => row.type === "tool.result" && row.data.toolCallId === "compact-finish")?.data.result as { data?: { finalText?: string; finalizationStatus?: string } };
  expect(checkedGuidance).toBe(true);
  expect(t.steps()).toBe(4);
  expect(final?.data.deliveryStatus, JSON.stringify(result)).toBe("incomplete");
  expect(final?.data.text).toBe(result.data?.finalText);
  expect(final?.data.text).toContain("001");
  expect(result).toMatchObject({ status: "ok", data: { outcome: "partial", finalizationStatus: "incomplete", artifacts: [{ path, persistence: "saved", validation: "unverified" }] } });
  expect(items.filter(row => row.type === "turn.completed")).toHaveLength(1);
  expect(items.filter(row => row.type === "turn.failed")).toHaveLength(0);
  expect(items.filter(row => row.type === "model.output" && row.data.deliveryStatus === "rejected")).toHaveLength(0);
  expect(items.some(row => row.type === "ui.present" && row.data.path === path)).toBe(true);
});

test.each([false, true])("round nine real HTTP SQL facts reject unchecked completion then deliver partial with both saved cards, oversize=%s", async (oversize) => {
  const diagnosticStart = performance.now();
  const diagnostic: RoundNineDiagnostic = (phase, detail = {}) => {
    process.stderr.write(JSON.stringify({
      diagnostic: "round-nine-phase", oversize, phase,
      elapsedMs: Number((performance.now() - diagnosticStart).toFixed(3)), ...detail,
    }) + "\n");
  };
  diagnostic("test.start");
  const gateway = createGateway();
  const sql = "SELECT (SELECT COUNT(*) FROM data) AS allRows, (SELECT COUNT(*) FROM other) AS otherRows, 8 AS included, 10 AS exceptions, 140 AS august, 130 AS september" + (oversize ? ", 19 AS reconciliation" : "");
  const secondSql = "SELECT 19 AS total, 10 AS included, 7 AS excluded, 2 AS missing, 0 AS difference FROM other LIMIT 1";
  type VisibleReceipt = { data: Record<string, unknown>; numericEvidence: NonNullable<ReturnType<typeof numericEvidence>> };
  let chosen: VisibleReceipt[] = [];
  diagnostic("boot.start");
  const t = await boot(async (request, step) => {
    diagnostic("provider.step.start", { step });
    if (step === 3) {
      diagnostic("checkpoint.start", { step });
      const db = new DatabaseSync(join(t.dataDir, "excelmanus.db"));
      try {
        diagnostic("checkpoint.wait.start", { step });
        await vi.waitFor(() => {
          const rows = db.prepare("SELECT head_rev,checkpoint_rev FROM documents WHERE path IN ('results/main.xlsx','results/other.xlsx')").all() as { head_rev: number; checkpoint_rev: number }[];
          expect(rows).toHaveLength(2);
          for (const row of rows) expect(row.checkpoint_rev).toBe(row.head_rev);
        }, { timeout: 5000 });
        diagnostic("checkpoint.wait.end", { step });
      } finally {
        db.close();
        diagnostic("checkpoint.database.closed", { step });
      }
      diagnostic("checkpoint.end", { step });
    }
    const fetchModel: typeof fetch = async (_url, init) => {
      diagnostic("provider.fetch.start", { step });
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      let name: string;
      let args: unknown;
      if (step === 1 || step === 2) {
        name = "workbook_edit";
        args = { path: step === 1 ? "results/main.xlsx" : "results/other.xlsx", create: true,
          ops: [{ op: "cells.set", range: step === 1 ? "A1:E3" : "A1:B2",
            values: step === 1 ? [["月份", "数量", "收入", "净分", "异常"], ["2026-08", 6, 140, 120, 0], ["2026-09", 5, 130, 125, 1]] : [["身份", "数量"], ["001", 7]] }] };
      } else if (step === 3) {
        name = "workbook_read";
        args = { path: "results/main.xlsx", mode: "range", range: "A1:E3", facets: ["values"] };
      } else if (step === 4 || (oversize && step === 5)) {
        name = "workbook_analyze";
        args = { path: "results/main.xlsx", mode: "sql", range: "Sheet1!A1:E3",
          sources: [{ name: "other", path: "results/other.xlsx", range: "Sheet1!A1:B2" }, { name: "unused", range: "Sheet1!A1:E3" }],
          sql: step === 4 ? sql : secondSql };
      } else {
        const attemptStep = oversize ? 6 : 5;
        if (step === attemptStep + 1) {
          name = "deliver";
          args = { action: "inspect" };
        } else if (step === attemptStep + 2) {
          const inspected = body.messages.filter(message => message.role === "tool")
            .map(message => JSON.parse(message.content) as { data?: { action?: string; factSets?: { id: string }[] } })
            .findLast(output => output.data?.action === "inspect");
          if (!inspected?.data?.factSets?.length) throw Error("missing visible inspect facts");
          name = "deliver";
          args = { action: "finalize", outcome: "partial", factSetIds: inspected.data.factSets.map(fact => fact.id) };
        } else {
          if (step !== attemptStep) throw Error("typed partial must end the runtime without another provider request");
          const receipts = body.messages.filter((message) => message.role === "tool")
            .map((message) => JSON.parse(message.content) as VisibleReceipt)
            .filter((receipt) => receipt.data?.mode === "range" || receipt.data?.mode === "sql");
          chosen = receipts;
          expect(receipts).toHaveLength(oversize ? 3 : 2);
          const sources = receipts.map((receipt) => {
            const pointer = receipt.data.mode === "sql" ? "/data/rows" : "/data/values";
            const root = receipt.numericEvidence.candidates.items.find((item) => item.pointer === pointer);
            expect(root).toBeDefined();
            return { refId: root!.refId };
          });
          name = "present";
          args = { finalize: { status: "complete", presentation: "summary", sources } };
        }
      }
      const chunk = { id: "round-nine-provider", choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: "round-nine-step-" + step, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      }, finish_reason: "tool_calls" }] };
      diagnostic("provider.fetch.response", { step, toolName: name });
      return new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    };
    const events: StepEvent[] = [];
    diagnostic("provider.gateway.start", { step });
    for await (const event of gateway.step({ ...request, model: { ...request.model, fetch: fetchModel } })) events.push(event);
    diagnostic("provider.gateway.end", { step, events: events.length });
    diagnostic("provider.step.end", { step });
    return events;
  }, diagnostic);
  diagnostic("boot.end");
  roundNineServerDiagnostics.set(t.server, diagnostic);
  roundNineDirDiagnostics.set(t.dataDir, diagnostic);
  roundNineBeforeClose.set(t.server, () => {
    // Read only this generated fixture session, before the original close/removal.
    // Diagnostic read failure is reported, never substituted for an assertion.
    try {
      const db = new DatabaseSync(join(t.dataDir, "excelmanus.db"), { readOnly: true });
      try {
        const fields = "seq,type,created_at,length(data) AS dataChars," +
          "json_extract(data,'$.toolCallId') AS toolCallId," +
          "json_extract(data,'$.toolName') AS toolName," +
          "json_extract(data,'$.status') AS status," +
          "json_extract(data,'$.result.status') AS resultStatus," +
          "json_extract(data,'$.result.error.code') AS errorCode," +
          "json_extract(data,'$.result.data.finalizationStatus') AS finalizationStatus";
        const head = db.prepare("SELECT COUNT(*) AS rowCount,MAX(seq) AS maxSeq,MAX(created_at) AS latestCreatedAt,SUM(length(CAST(data AS BLOB))) AS dataBytes FROM session_log WHERE session_id=?").get(t.session.id);
        const byType = db.prepare("SELECT type,COUNT(*) AS rowCount,SUM(length(CAST(data AS BLOB))) AS dataBytes FROM session_log WHERE session_id=? GROUP BY type ORDER BY type").all(t.session.id);
        const recent = db.prepare("SELECT " + fields + " FROM session_log WHERE session_id=? ORDER BY seq DESC LIMIT 12").all(t.session.id);
        const finalCallId = "round-nine-step-" + (oversize ? 8 : 7);
        const finalCall = db.prepare("SELECT " + fields + " FROM session_log WHERE session_id=? AND type IN ('tool.intent','tool.result') AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 12").all(t.session.id, finalCallId);
        const intent = finalCall.find(row => row.type === "tool.intent");
        const result = finalCall.find(row => row.type === "tool.result");
        const resultSeq = typeof result?.seq === "number" ? result.seq : null;
        const finalInterval = typeof intent?.seq === "number" ? db.prepare(
          "SELECT COUNT(*) AS rowCount,SUM(length(CAST(data AS BLOB))) AS dataBytes," +
          "SUM(CASE WHEN type IN ('access.fact','access.batch','access.unscoped') THEN 1 ELSE 0 END) AS accessRows," +
          "SUM(CASE WHEN type IN ('access.fact','access.batch','access.unscoped') THEN length(CAST(data AS BLOB)) ELSE 0 END) AS accessDataBytes " +
          "FROM session_log WHERE session_id=? AND seq>=? AND (? IS NULL OR seq<=?)",
        ).get(t.session.id, intent.seq, resultSeq, resultSeq) : null;
        diagnostic("cleanup.session_log.snapshot", {
          finalCallId, head: JSON.stringify(head), byType: JSON.stringify(byType),
          recent: JSON.stringify(recent), finalCall: JSON.stringify(finalCall), finalInterval: JSON.stringify(finalInterval),
        });
      } finally { db.close(); }
    } catch (error) {
      diagnostic("cleanup.session_log.error", { errorName: error instanceof Error ? error.name : typeof error });
    }
  });
  mkdirSync(join(t.server.workspaceRoot, "results"));
  diagnostic("send.start");
  await t.send("round-nine-user", "仅访问目录 results；保存两份结果，核验 SQL 和月汇总后简短交付。");
  diagnostic("send.end");
  diagnostic("turn.wait.start");
  await t.wait((rows) => rows.some((row) => ["turn.completed", "turn.failed"].includes(row.type)));
  diagnostic("turn.wait.end", { steps: t.steps() });
  // Large typed receipts can exceed the API tail window; assertions page the real log.
  // The fake model above still consumes only its actual provider-visible messages.
  const items: LogRecord[] = [];
  let before: number | undefined;
  let pageNumber = 0;
  diagnostic("pagination.start");
  for (;;) {
    diagnostic("pagination.page.start", { page: ++pageNumber });
    const page = await t.api.getSessionLog(t.session.id, { limit: 1000, ...(before === undefined ? {} : { before }) });
    diagnostic("pagination.page.end", { page: pageNumber, rows: page.items.length });
    if (!page.items.length) break;
    items.push(...page.items);
    const next = Math.min(...page.items.map(row => row.seq));
    if (next <= 1) break;
    if (before !== undefined && next >= before) throw new Error("session log cursor did not advance");
    before = next;
  }
  items.sort((a, b) => a.seq - b.seq);
  diagnostic("pagination.end", { pages: pageNumber, rows: items.length });
  diagnostic("assertions.start");
  const attemptedId = "round-nine-step-" + (oversize ? 6 : 5);
  expect(items.find(row => row.type === "tool.result" && row.data.toolCallId === attemptedId)?.data.result, JSON.stringify({ steps: t.steps(), events: items.filter(row => row.type === "tool.result" || row.type === "turn.failed").map(row => ({ type: row.type, id: row.data.toolCallId, name: row.data.toolName, status: row.data.status, error: (row.data.result as { error?: unknown } | undefined)?.error, message: row.data.message })) }, null, 2)).toMatchObject({ status: "error" });
  const finalId = "round-nine-step-" + (oversize ? 8 : 7);
  const result = items.find((row) => row.type === "tool.result" && row.data.toolCallId === finalId)?.data.result as {
    status: string; data: { finalText: string; finalizationStatus: string;
      deliveredFiles: { path: string; docId: string; rev: number; sha256: string; saved: boolean }[] };
  };
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: {
    outcome: "partial", finalizationStatus: "incomplete", artifacts: [{ validation: "unverified" }, { validation: "unverified" }],
  } });
  expect(t.steps()).toBe(oversize ? 8 : 7);
  const final = items.findLast((row) => row.type === "model.output" && row.data.sourceToolCallId === finalId);
  expect(final?.data.text).toBe(result.data.finalText);
  expect(final?.data.deliveryStatus).toBe("incomplete");
  expect(items.filter((row) => row.type === "turn.completed")).toHaveLength(1);
  expect(items.filter((row) => row.type === "turn.failed")).toHaveLength(0);
  expect(items.filter((row) => row.type === "model.output" && row.data.deliveryStatus === "rejected")).toHaveLength(1);
  expect(items.find(row => row.type === "model.output" && row.data.deliveryStatus === "rejected")!.seq).toBeLessThan(final!.seq);
  for (const receipt of chosen.filter((entry) => entry.data.mode === "sql")) {
    const actual = items.filter((row) => row.type === "tool.result")
      .map((row) => row.data.result as { data?: Record<string, unknown> })
      .find((output) => output.data?.sql === receipt.data.sql);
    for (const field of ["sql", "columns", "rows", "rowCount", "truncated", "sources"]) expect(actual?.data?.[field]).toEqual(receipt.data[field]);
    expect(receipt.data.sources).toMatchObject([{ name: "data" }, { name: "other" }, { name: "unused" }]);
    for (const label of receipt.data.columns as string[]) expect(result.data.finalText).toContain(label);
  }
  expect(result.data.finalText).toContain("unverified");
  expect(result.data.finalText).toContain("unused");
  // Small/large presentation never supplies the missing business checks.
  expect(result.data.finalizationStatus).toBe("incomplete");
  expect(result.data.deliveredFiles.map((file) => file.path).sort()).toEqual(["results/main.xlsx", "results/other.xlsx"]);
  const db = new DatabaseSync(join(t.dataDir, "excelmanus.db"));
  try {
    for (const file of result.data.deliveredFiles) {
      const doc = db.prepare("SELECT id,head_rev,checkpoint_rev,checkpoint_hash FROM documents WHERE path=?").get(file.path) as { id: string; head_rev: number; checkpoint_rev: number; checkpoint_hash: string };
      expect(file).toMatchObject({ docId: doc.id, rev: doc.head_rev, sha256: doc.checkpoint_hash, saved: true });
      expect(doc.checkpoint_rev).toBe(file.rev);
      const card = items.find((row) => row.type === "ui.present" && row.data.path === file.path);
      expect(card?.data.note).toContain(file.sha256);
      expect(result.data.finalText).toContain("修订=" + file.rev);
      diagnostic("download.start", { path: file.path });
      const downloaded = await t.api.downloadFile(t.session.workspaceId, file.path);
      diagnostic("download.response", { path: file.path });
      expect(createHash("sha256").update(Buffer.from(await downloaded.arrayBuffer())).digest("hex")).toBe(file.sha256);
      diagnostic("download.verified", { path: file.path });
    }
  } finally { db.close(); }
  diagnostic("assertions.end");
  diagnostic("test.body.end");
});
