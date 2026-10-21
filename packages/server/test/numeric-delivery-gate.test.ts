import { randomUUID } from "node:crypto";
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
import { afterAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (value: string): StepEvent[] => [
  { kind: "text.delta", text: value },
  { kind: "finish", reason: "stop" },
];
const call = (id: string, toolName: string, args: unknown): StepEvent[] => [
  { kind: "tool.call", toolCallId: id, toolName, args, rawArgs: JSON.stringify(args) },
  { kind: "finish", reason: "tool-calls" },
];
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
  test(`真实 provider 正文 receipt 足以完成交付，不从协议外层调用 ID 作弊：string=${encodedFinalize}`, async () => {
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
    expect(requests).toBe(3);
    expect(copiedSources.length).toBeGreaterThan(0);
    expect(
      items.filter((row) => row.type === "model.output" && row.data.sourceToolCallId).at(-1)?.data,
    ).toMatchObject({ deliveryStatus: "complete", text: expect.stringContaining("2.35") });
  });
}

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function boot(
  handler: (request: StepRequest, step: number) => StepEvent[] | Promise<StepEvent[]>,
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
  const log = async () => (await api.getSessionLog(session.id, { limit: 1000 })).items;
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

test("真实公式之后拒绝自由算理 final，实际计算解释证据再服务端完成且不流出错句", async () => {
  const bad = "这两个尾数合并为 12406.335，整体进位 0.005。";
  const t = await boot((_request, step) => {
    if (step === 1) return create();
    if (step === 2) return text(bad);
    if (step === 3)
      return call("explanation", "workbook_analyze", {
        path: "numbers.xlsx",
        mode: "sql",
        range: "A1:C3",
        sql: 'SELECT SUM("原值") AS "原始合计", SUM("舍入值") AS "逐行舍入合计", ROUND(SUM("原值"),2)-SUM("原值") AS "整体舍入增量", SUM("舍入值"-"原值") AS "逐行舍入增量" FROM data',
      });
    if (step === 4)
      return call("finish", "present", {
        finalize: {
          status: "complete",
          sources: [{ refId: 'nr1:["explanation","/data/rows"]' }],
        },
      });
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
    expect(t.steps()).toBe(4);
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
      return call("parent-finish", "present", {
        finalize: {
          status: "complete",
          sources: [{ refId: 'nr1:["parent-read","/data/values"]' }],
        },
      });
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
