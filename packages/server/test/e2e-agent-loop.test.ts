// M6 审计分支 4（代理主循环）回归：真实 HTTP + 真实 SQLite 文件 + MockLanguageModelV4
// （只替代模型输出）。P1-14/P1-20 另用测试模块注入探针工具，走同一条运行时执行路径。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type CapabilityModule, kernelProjections, SessionLog } from "@excelmanus/kernel";
import { type ApiClient, createApiClient, type LogRecord } from "@excelmanus/protocol";
import { importCsv, importXlsx } from "@excelmanus/workbook";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { minimalXlsx } from "../../modules/workbook/src/checkpoint.ts";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Prompt = Array<{ role: string; content: unknown }>;
type Out = { stream: ReadableStream<LanguageModelV4StreamPart> };

function streamOf(parts: LanguageModelV4StreamPart[]): Out {
  return {
    stream: new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    }),
  };
}
const text = (t: string): Out =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "a" },
    { type: "text-delta", id: "a", delta: t },
    { type: "text-end", id: "a" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
  ]);
const call = (id: string, toolName: string, input: unknown): Out =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
  ]);
const systemOf = (p: Prompt): string => {
  const s = p.find((m) => m.role === "system");
  return typeof s?.content === "string" ? s.content : "";
};

/** 每个测试一个服务；handler 拿到 prompt，计数放在闭包里（网关每步新建模型实例）。 */
async function boot(
  handler: (prompt: Prompt) => Out | Promise<Out>,
  opts: { modules?: CapabilityModule[]; maxConcurrentSubAgents?: number } = {},
): Promise<{ srv: RunningServer; api: ApiClient; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-fix-agent-loop-"));
  dirs.push(dataDir);
  const srv = await startServer({
    dataDir,
    retryBaseMs: 10,
    log: () => {},
    resolveLanguageModel: () =>
      new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-loop",
        doStream: async (o) => handler([...(o.prompt as Prompt)]),
      }),
    ...(opts.modules ? { modules: opts.modules } : {}),
    ...(opts.maxConcurrentSubAgents ? { maxConcurrentSubAgents: opts.maxConcurrentSubAgents } : {}),
  });
  servers.push(srv);
  const api = createApiClient(srv.url, srv.token);
  await createTestProfile(api, {
    name: "mock",
    provider: "custom-openai-compatible",
    model: "mock-loop",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "test",
  });
  return { srv, api, dataDir };
}

async function waitLog(
  api: ApiClient,
  sessionId: string,
  pred: (items: LogRecord[]) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<LogRecord[]> {
  const t0 = Date.now();
  for (;;) {
    const { items } = await api.getSessionLog(sessionId, { limit: 1000 });
    if (pred(items)) return items;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`等待超时：${what}；types=${items.map((i) => i.type).join(",")}`);
    await sleep(20);
  }
}

const resultsOf = (items: LogRecord[], toolCallId: string) =>
  items.filter((r) => r.type === "tool.result" && r.data.toolCallId === toolCallId);
const errCode = (r: LogRecord | undefined) =>
  (r?.data.result as { error?: { code?: string } } | undefined)?.error?.code;

test("新会话系统提示明确事实、推断与因果证据边界", async () => {
  let system = "";
  const { api } = await boot((prompt) => {
    system = systemOf(prompt);
    return text("收到");
  });
  const { session } = await api.createSession({});
  await api.sendMessage(session.id, "main", { clientMessageId: "evidence", text: "分析数据" });
  await waitLog(api, session.id, (all) => all.some((r) => r.type === "turn.completed"), "完成");
  expect(system).toContain("区分数据事实、推断与因果证据");
  expect(system).toContain("不补造输入未提供的维度");
  expect(system).toContain("相关关系不能单独证明因果");
});

test("批次参数校验一次反馈所有字段问题且不执行写入", async () => {
  let step = 0;
  const { srv, api } = await boot(() =>
    ++step === 1
      ? call("bad-batch", "workbook_edit", {
          path: "invalid-batch.xlsx",
          create: true,
          ops: [
            { op: "cols.width", unexpectedAxis: "cols", at: 1, count: 1, pixels: 120 },
            { op: "freeze", sheet: "Sheet1", rows: 1 },
          ],
        })
      : text("已收到完整校验反馈"),
  );
  const { session } = await api.createSession({});
  await api.sendMessage(session.id, "main", { clientMessageId: "bad-batch", text: "测试批次" });
  const items = await waitLog(
    api,
    session.id,
    (all) => all.some((r) => r.type === "turn.completed"),
    "校验完成",
  );
  const result = resultsOf(items, "bad-batch")[0]?.data.result as {
    error: { code: string; field: string; hint?: string };
  };
  expect(result.error).toMatchObject({ code: "INVALID_ARGUMENT", field: "ops.0.sheet" });
  expect(result.error.hint).toContain("ops.0.sheet");
  expect(result.error.hint).toContain('Unrecognized key: "unexpectedAxis"');
  expect(result.error.hint).toContain("ops.1.cols");
  expect(result.error.hint).toContain("下标从 0 开始");
  expect(existsSync(join(srv.workspaceRoot, "invalid-batch.xlsx"))).toBe(false);
});

describe("P1-04 ask_user 在停止/打断时收口", () => {
  test("stop 与 interrupt 后回答返回 idempotent，不出现第二条 tool.result、不复活旧轮", async () => {
    const { api } = await boot((p) =>
      p.some((m) => m.role === "tool")
        ? text("好的")
        : call("q1", "ask_user", { type: "choice", spec: { question: "继续？" } }),
    );
    for (const how of ["stop", "interrupt"] as const) {
      const { session } = await api.createSession({});
      await api.sendMessage(session.id, "main", { clientMessageId: `${how}-1`, text: "问我" });
      const asked = await waitLog(
        api,
        session.id,
        (all) => all.some((r) => r.type === "question.asked"),
        "question.asked",
      );
      const questionId = String(asked.find((r) => r.type === "question.asked")?.data.questionId);
      if (how === "stop") await api.stopAgent(session.id, "main");
      else
        await api.sendMessage(session.id, "main", {
          clientMessageId: `${how}-2`,
          text: "改做别的",
          mode: "interrupt",
        });
      await waitLog(
        api,
        session.id,
        (all) => all.some((r) => r.type === "turn.interrupted"),
        `${how} → turn.interrupted`,
      );
      if (how === "interrupt")
        await waitLog(
          api,
          session.id,
          (all) => all.some((r) => r.type === "turn.completed"),
          "打断后的新轮完成",
        );
      const answered = await api.answerQuestion(questionId, { answer: "yes" });
      expect(answered.idempotent).toBe(true);
      await sleep(400);
      const items = (await api.getSessionLog(session.id, { limit: 1000 })).items;
      const q = resultsOf(items, "q1");
      expect(q).toHaveLength(1);
      expect(errCode(q[0])).toBe("CANCELLED");
      expect(items.filter((r) => r.type === "turn.interrupted")).toHaveLength(1);
      expect(items.filter((r) => r.type === "turn.started")).toHaveLength(how === "stop" ? 1 : 2);
    }
  }, 60_000);
});

describe("P1-11 用户消息唤醒 agent_wait(any_message)", () => {
  test("等待期间发 steer：wait 以 user_message 返回，消息随后应用", async () => {
    let step = 0;
    const { api } = await boot(() => {
      step += 1;
      return step === 1
        ? call("w1", "agent_wait", { for: "any_message", timeoutSeconds: 30 })
        : text("收到");
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "等消息" });
    await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "tool.intent" && r.data.toolCallId === "w1"),
      "wait intent",
    );
    await sleep(300);
    const t0 = Date.now();
    await api.sendMessage(session.id, "main", { clientMessageId: "m2", text: "先别改原表" });
    const items = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "turn.completed"),
      "turn.completed",
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    const w = resultsOf(items, "w1")[0];
    const wr = w?.data.result as { data?: { reason?: string } } | undefined;
    expect(wr?.data?.reason).toBe("user_message");
  }, 60_000);
});

describe("P1-12 执行时按 roles 校验", () => {
  test("reader 子代理调 write：按工具不存在返回，文件未创建", async () => {
    let mainStep = 0;
    const { srv, api } = await boot((p) => {
      if (systemOf(p).includes("读者任务-甲"))
        return p.some((m) => m.role === "tool")
          ? text("读者结束")
          : call("rw1", "write", { path: "reader-wrote.txt", content: "x" });
      mainStep += 1;
      return mainStep === 1
        ? call("sp1", "agent_spawn", { name: "甲", role: "reader", task: "读者任务-甲" })
        : text("完成");
    });
    const { session } = await api.createSession({ permissionMode: "auto" });
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "派生" });
    const items = await waitLog(
      api,
      session.id,
      (all) => resultsOf(all, "rw1").length > 0,
      "reader write 结果",
    );
    const intent = items.find((r) => r.type === "tool.intent" && r.data.toolCallId === "rw1");
    const r = resultsOf(items, "rw1")[0];
    expect(intent).toBeDefined();
    expect(errCode(r)).toBe("INVALID_ARGUMENT");
    const rr = r?.data.result as { error?: { message?: string } } | undefined;
    expect(rr?.error?.message).toContain("不存在");
    expect(existsSync(join(srv.workspaceRoot, "reader-wrote.txt"))).toBe(false);
  }, 60_000);
});

describe("P1-13 / P1-20 审批放行后删除生效；intentMeta 失败保留原错误码", () => {
  test("auto 模式删除成功；越界路径返回 OUT_OF_WORKSPACE", async () => {
    let step = 0;
    const { srv, api } = await boot(() => {
      step += 1;
      if (step === 1) return call("d1", "files", { ops: [{ op: "delete", path: "del-auto.txt" }] });
      if (step === 2) return call("e1", "write", { path: "../escape.txt", content: "x" });
      return text("完成");
    });
    writeFileSync(join(srv.workspaceRoot, "del-auto.txt"), "bye");
    const { session } = await api.createSession({ permissionMode: "auto" });
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "删除" });
    const items = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "turn.completed"),
      "turn.completed",
    );
    expect(resultsOf(items, "d1")[0]?.data.status).toBe("ok");
    expect(existsSync(join(srv.workspaceRoot, "del-auto.txt"))).toBe(false);
    expect(items.some((r) => r.type === "approval.requested")).toBe(false);
    expect(errCode(resultsOf(items, "e1")[0])).toBe("OUT_OF_WORKSPACE");
  }, 60_000);

  test("standard 模式批准并记住：本次删除执行，之后同类删除免审批且成功", async () => {
    let step = 0;
    const { srv, api } = await boot(() => {
      step += 1;
      if (step === 1 || step === 3)
        return call(`d${step}`, "files", { ops: [{ op: "delete", path: "rem.txt" }] });
      return text("完成");
    });
    const file = join(srv.workspaceRoot, "rem.txt");
    writeFileSync(file, "1");
    const { session } = await api.createSession({ permissionMode: "standard" });
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "删除一次" });
    const asked = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "approval.requested"),
      "approval.requested",
    );
    const approvalId = String(asked.find((r) => r.type === "approval.requested")?.data.approvalId);
    await api.decideApproval(approvalId, { decision: "approve", remember: true });
    await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "turn.completed"),
      "第一轮完成",
    );
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "2");
    await api.sendMessage(session.id, "main", { clientMessageId: "m2", text: "再删一次" });
    const items = await waitLog(
      api,
      session.id,
      (all) => all.filter((r) => r.type === "turn.completed").length >= 2,
      "第二轮完成",
    );
    expect(resultsOf(items, "d1")[0]?.data.status).toBe("ok");
    expect(resultsOf(items, "d3")[0]?.data.status).toBe("ok");
    expect(items.filter((r) => r.type === "approval.requested")).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  }, 60_000);
});

describe("P1-14 / P1-17 / P1-20 发布审批计时、结果截断、错误码收敛", () => {
  // 探针工具：与 run_script 一样 approval:"publish"，工具超时缩短到 300ms
  const publishProbe = {
    name: "probe_publish",
    title: "探针发布",
    description: "测试用：发布前自请审批",
    input: z.strictObject({}),
    output: z.unknown(),
    effect: "write" as const,
    approval: "publish" as const,
    targets: () => ["probe.txt"],
    replay: "unsafe" as const,
    timeoutMs: 300,
    roles: ["main" as const],
    async execute(
      _a: unknown,
      ctx: Parameters<NonNullable<CapabilityModule["tools"]>[number]["execute"]>[1],
    ) {
      const g = await ctx.requestApproval?.({ targets: ["probe.txt"], args: {}, effect: "write" });
      if (g?.decision !== "approved")
        return {
          status: "error" as const,
          error: { code: "APPROVAL_DENIED", message: "拒绝", retryable: false },
        };
      ctx.signal.throwIfAborted();
      return { status: "ok" as const, data: { published: true } };
    },
  };
  const badCodeProbe = {
    name: "probe_badcode",
    title: "探针错误码",
    description: "测试用：返回词表外错误码",
    input: z.strictObject({}),
    output: z.unknown(),
    effect: "read" as const,
    targets: () => [],
    replay: "safe" as const,
    timeoutMs: 1000,
    roles: ["main" as const],
    execute: () => ({
      status: "error" as const,
      error: { code: "WEIRD_CODE", message: "x", retryable: false },
    }),
  };
  const probes = {
    id: "probes",
    tools: [publishProbe, badCodeProbe],
  } as unknown as CapabilityModule;

  test("发布审批等待超过工具超时不被自动拒绝；批准后执行成功", async () => {
    let step = 0;
    const { api } = await boot(
      () => {
        step += 1;
        return step === 1 ? call("pp1", "probe_publish", {}) : text("完成");
      },
      { modules: [probes] },
    );
    const { session } = await api.createSession({ permissionMode: "confirm" });
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "发布" });
    const asked = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "approval.requested"),
      "approval.requested",
    );
    await sleep(1_000); // 超过 timeoutMs=300 的三倍
    const mid = (await api.getSessionLog(session.id, { limit: 1000 })).items;
    expect(mid.some((r) => r.type === "approval.decided")).toBe(false);
    expect(resultsOf(mid, "pp1")).toHaveLength(0);
    const approvalId = String(asked.find((r) => r.type === "approval.requested")?.data.approvalId);
    const decided = await api.decideApproval(approvalId, { decision: "approve" });
    expect(decided.idempotent).toBe(false);
    const items = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "turn.completed"),
      "turn.completed",
    );
    expect(resultsOf(items, "pp1")[0]?.data.status).toBe("ok");
  }, 60_000);

  test("run_script 90 万字符结果：日志保留全文，下一步 prompt 中被截到约 16000 字符；词表外码收敛为 INTERNAL", async () => {
    const prompts: Prompt[] = [];
    let step = 0;
    const { api } = await boot(
      (p) => {
        prompts.push(p);
        step += 1;
        if (step === 1) return call("big1", "run_script", { code: 'return "x".repeat(900000);' });
        if (step === 2) return call("bc1", "probe_badcode", {});
        return text("完成");
      },
      { modules: [probes] },
    );
    const { session } = await api.createSession({ permissionMode: "auto" });
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "跑" });
    const items = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "turn.completed"),
      "turn.completed",
      60_000,
    );
    const big = resultsOf(items, "big1")[0];
    expect(big?.data.status).toBe("ok");
    expect(JSON.stringify(big?.data.result).length).toBeGreaterThan(900_000);
    const toolMsg = prompts[1]?.find((m) => m.role === "tool");
    const shown = JSON.stringify(toolMsg);
    expect(shown.length).toBeLessThan(20_000);
    expect(shown).toContain("结果过长");
    expect(errCode(resultsOf(items, "bc1")[0])).toBe("INTERNAL");
  }, 90_000);
});

describe("P0-01 环境通知与优先级合并", () => {
  test("ask_user 等待中：子代理消息与报告到达、用户改规则再发消息 → 回答后一条 <inbox>，report/notice 先于代理消息；重建一致", async () => {
    let mainStep = 0;
    const { srv, api, dataDir } = await boot((p) => {
      if (systemOf(p).includes("核对任务-甲"))
        return p.some((m) => m.role === "tool")
          ? text("子代理完成-甲")
          : call("snd1", "agent_send", { to: "parent", message: "进度消息-甲" });
      mainStep += 1;
      if (mainStep === 1)
        return call("sp1", "agent_spawn", { name: "甲", role: "reader", task: "核对任务-甲" });
      if (mainStep === 2)
        return call("q1", "ask_user", { type: "choice", spec: { question: "继续？" } });
      return text("已处理");
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "派生并提问" });
    await waitLog(
      api,
      session.id,
      (all) =>
        all.some((r) => r.type === "question.asked") &&
        all.some((r) => r.type === "inbox.sent" && r.data.kind === "report"),
      "提问 + 子代理报告",
    );
    await api.createRule({ scope: "session", sessionId: session.id, content: "规则-不要改原表" });
    await api.sendMessage(session.id, "main", { clientMessageId: "m2", text: "顺便看看" });
    let items = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "context.notice"),
      "context.notice",
    );
    // 等待中尚未投递
    expect(items.some((r) => r.type === "inbox.delivered" && r.data.toAgentId === "main")).toBe(
      false,
    );
    const questionId = String(items.find((r) => r.type === "question.asked")?.data.questionId);
    await api.answerQuestion(questionId, { answer: "yes" });
    items = await waitLog(
      api,
      session.id,
      (all) =>
        all.some((r) => r.type === "turn.completed" && r.agentId === "main") &&
        all.some((r) => r.type === "inbox.delivered" && r.data.toAgentId === "main"),
      "main 完成",
    );
    const main = items.filter((r) => r.agentId === "main");
    expect(main.some((r) => r.type === "turn.failed")).toBe(false);
    const qSeq = resultsOf(main, "q1")[0]?.seq ?? Infinity;
    const delivered = main.filter((r) => r.type === "inbox.delivered");
    expect(delivered.length).toBeGreaterThanOrEqual(3);
    for (const d of delivered) expect(d.seq).toBeGreaterThan(qSeq);

    const db = new DatabaseSync(join(dataDir, "excelmanus.db"));
    const dump = () => ({
      ctx: db
        .prepare(
          "SELECT idx, item, superseded FROM agent_context WHERE session_id = ? AND agent_id = 'main' ORDER BY idx",
        )
        .all(session.id),
      inbox: db
        .prepare(
          "SELECT message_id, from_agent_id, to_agent_id, kind, message, status FROM inbox_pending WHERE session_id = ? ORDER BY message_id",
        )
        .all(session.id),
    });
    const before = dump();
    const inboxItems = (before.ctx as { item: string }[])
      .map((r) => JSON.parse(r.item) as { kind: string; text?: string })
      .filter((i) => i.kind === "user" && i.text?.startsWith("<inbox>"));
    expect(inboxItems).toHaveLength(1);
    const merged = inboxItems[0]?.text ?? "";
    const iReport = merged.indexOf("子代理完成-甲");
    const iNotice = merged.indexOf("规则-不要改原表");
    const iAgent = merged.indexOf("进度消息-甲");
    expect(iReport).toBeGreaterThan(-1);
    expect(iNotice).toBeGreaterThan(iReport);
    expect(iAgent).toBeGreaterThan(iNotice);
    // 子代理也收到环境通知（context.notice 按当时未关闭代理展开）
    expect(
      (before.inbox as { from_agent_id: string; to_agent_id: string }[]).filter(
        (r) => r.from_agent_id === "environment",
      ).length,
    ).toBeGreaterThanOrEqual(2);

    servers.splice(servers.indexOf(srv), 1);
    await srv.close();
    new SessionLog(db, { projections: kernelProjections() }).rebuild(session.id);
    expect(dump()).toEqual(before);
    db.close();
  }, 90_000);
});

test("malformed tool JSON is reported distinctly instead of losing the parse error as null", async () => {
  let calls = 0;
  const { api } = await boot(() =>
    ++calls === 1
      ? streamOf([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "broken-json",
            toolName: "workbook_read",
            input: '{"path":"broken.xlsx",',
          },
          { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
        ])
      : text("已看到参数格式错误"),
  );
  const { session } = await api.createSession({});
  await api.sendMessage(session.id, "main", {
    clientMessageId: "invalid-json",
    text: "读取测试文件",
  });
  const done = await waitLog(
    api,
    session.id,
    (items) => items.some((r) => r.type === "turn.completed"),
    "无效 JSON 回执",
  );
  const result = resultsOf(done, "broken-json")[0];
  expect(errCode(result)).toBe("INVALID_ARGUMENT");
  expect(result?.data.result).toMatchObject({
    error: { message: expect.stringContaining("JSON") },
  });
  expect(done.find((r) => r.type === "model.output")?.data.toolCalls).toEqual([
    expect.objectContaining({ inputError: expect.stringContaining("JSON") }),
  ]);
  expect(calls).toBe(2);
});

test("停止流式回复保留已输出文字与思考，未完整生成的工具不执行", async () => {
  let started = false;
  const { api } = await boot(() => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        c.enqueue({ type: "reasoning-start", id: "r" });
        c.enqueue({ type: "reasoning-delta", id: "r", delta: "已检查表格" });
        c.enqueue({ type: "reasoning-end", id: "r" });
        c.enqueue({ type: "text-start", id: "a" });
        c.enqueue({ type: "text-delta", id: "a", delta: "已经输出的一半内容" });
        c.enqueue({ type: "text-end", id: "a" });
        c.enqueue({ type: "tool-input-start", id: "partial", toolName: "workbook_edit" });
        c.enqueue({ type: "tool-input-delta", id: "partial", delta: '{"path":"unfinished.xlsx"' });
        started = true;
      },
    }),
  }));
  const { session } = await api.createSession({});
  await api.sendMessage(session.id, "main", { clientMessageId: "partial-stop", text: "测试停止" });
  for (let i = 0; !started && i < 100; i++) await sleep(20);
  expect(started).toBe(true);
  await sleep(100);
  await api.stopAgent(session.id, "main");
  const records = await waitLog(
    api,
    session.id,
    (all) => all.some((r) => r.type === "turn.interrupted"),
    "停止保留输出",
  );
  const output = records.filter((r) => r.type === "model.output");
  expect(output).toHaveLength(1);
  expect(output[0]?.data).toMatchObject({ text: "已经输出的一半内容", reasoning: "已检查表格" });
  expect(output[0]?.data.toolCalls).toBeUndefined();
  expect(records.some((r) => r.type === "tool.intent")).toBe(false);
  expect(records.some((r) => r.type === "attempt.discarded")).toBe(false);
});

test("a report consumed at a step boundary does not wake an extra empty main turn", async () => {
  let mainCalls = 0;
  let summaries = 0;
  const { api } = await boot(async (p) => {
    if (systemOf(p).includes("角色的子代理")) {
      await sleep(150);
      return text("只读核对完成");
    }
    mainCalls += 1;
    if (mainCalls === 1)
      return call("spawn-report", "agent_spawn", {
        name: "核对员",
        role: "reader",
        task: "只读核对",
      });
    if (mainCalls === 2)
      return call("wait-report", "agent_wait", { for: "any_message", timeoutSeconds: 5 });
    summaries += 1;
    return text(`汇总 ${summaries}`);
  });
  const { session } = await api.createSession({});
  await api.sendMessage(session.id, "main", {
    clientMessageId: "one-report",
    text: "请分派并汇总一次",
  });
  await waitLog(
    api,
    session.id,
    (all) => all.some((r) => r.agentId === "main" && r.type === "turn.completed"),
    "main finished",
  );
  await sleep(200);
  expect(summaries).toBe(1);
  const { items } = await api.getSessionLog(session.id, { limit: 1000 });
  expect(items.filter((r) => r.agentId === "main" && r.type === "turn.started")).toHaveLength(1);
});

test("explicit resume continues an interrupted agent with no pending inbox or dispatch", async () => {
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { api } = await boot(async () => {
    calls += 1;
    if (calls === 1) await gate;
    return text("继续后的结果");
  });
  const { session } = await api.createSession({});
  await api.sendMessage(session.id, "main", { clientMessageId: "resume-empty", text: "测试继续" });
  while (calls === 0) await sleep(10);
  await api.stopAgent(session.id, "main");
  release();
  await waitLog(api, session.id, (all) => all.some((r) => r.type === "turn.interrupted"), "interrupted");
  await sleep(100);
  const resumed = await api.resumeAgent(session.id, "main");
  expect(resumed).toMatchObject({ resumed: 0, started: true });
  await waitLog(api, session.id, (all) => all.some((r) => r.type === "turn.completed"), "resumed");
  expect(calls).toBe(2);
});

test.each(["main", "child", "child-pending"])(
  "explicit resume after exhausted stream retries preserves a committed workbook edit (%s)",
  async (target) => {
    let providerRecovered = false;
    let calls = 0;
    let resumedPrompt: Prompt | undefined;
    const { srv, api, dataDir } = await boot((prompt) => {
      if (target !== "main" && !systemOf(prompt).includes("角色的子代理"))
        return prompt.some((m) => m.role === "tool")
          ? text("等待子代理报告")
          : call("resume-spawn", "agent_spawn", {
              name: "插行子代理",
              role: "worker",
              task: "仅在 resume.xlsx 第 2 行前插入一行，写入 applied-once",
              files: ["resume.xlsx"],
            });
      calls += 1;
      const hasResult = (id: string) =>
        prompt.some(
          (m) =>
            m.role === "tool" &&
            Array.isArray(m.content) &&
            m.content.some((part) => part.type === "tool-result" && part.toolCallId === id),
        );
      if (!hasResult("resume-read"))
        return call("resume-read", "workbook_read", {
          path: "resume.xlsx",
          mode: "range",
          range: "Sheet1!A1:A3",
        });
      if (!hasResult("resume-edit"))
        return call("resume-edit", "workbook_edit", {
          path: "resume.xlsx",
          ops: [
            { op: "rows.insert", sheet: "Sheet1", at: 2, count: 1 },
            { op: "cells.set", range: "Sheet1!A2", values: [["applied-once"]] },
          ],
        });
      if (!providerRecovered)
        return streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "partial" },
          { type: "text-delta", id: "partial", delta: "尚未完成的收尾" },
        ]);
      resumedPrompt = prompt;
      return text("继续后仅补收尾");
    });
    const { session } = await api.createSession({});
    const file = join(srv.workspaceRoot, "resume.xlsx");
    writeFileSync(
      file,
      minimalXlsx(
        importCsv(new TextEncoder().encode("marker\noriginal-one\ntail\n"), "resume.csv").snapshot,
      ),
    );
    const { document } = await api.openDoc(session.workspaceId, { path: "resume.xlsx" });
    await api.sendMessage(session.id, "main", {
      clientMessageId: "resume-failed",
      text: "在第 2 行前插入一行，写入 applied-once",
    });
    const failed = await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "turn.failed") && !srv.hasRunningAgents(),
      "断流重试耗尽",
    );
    const agentId =
      target === "main"
        ? "main"
        : (await api.getSession(session.id)).agents.find((a) => a.role === "worker")?.id;
    expect(agentId).toBeDefined();
    if (!agentId) throw new Error("缺少目标子代理");
    expect(failed.find((r) => r.type === "turn.failed")?.data.error).toMatchObject({
      kind: "stream_interrupted",
    });
    expect(failed.filter((r) => r.type === "retry.scheduled")).toHaveLength(5);
    expect(failed.filter((r) => r.type === "attempt.discarded")).toHaveLength(6);
    expect(resultsOf(failed, "resume-edit")).toHaveLength(1);
    expect(resultsOf(failed, "resume-edit")[0]?.data.status).toBe("ok");
    expect(calls).toBe(8);

    const db = new DatabaseSync(join(dataDir, "excelmanus.db"), { readOnly: true });
    try {
      // 等待真实异步检查点；继续前后文件与修订都只能包含这一次非幂等插行。
      const deadline = Date.now() + 5_000;
      while (
        (await api.getDocSnapshot(session.workspaceId, document.id)).document.checkpointRev !== 1 &&
        Date.now() < deadline
      )
        await sleep(20);
      const documentState = () =>
        db
          .prepare("SELECT rev, head_rev, checkpoint_rev FROM documents WHERE id = ?")
          .get(document.id);
      expect(documentState()).toMatchObject({ rev: 1, head_rev: 1, checkpoint_rev: 1 });
      const committedBytes = readFileSync(file);
      const disk = importXlsx(committedBytes, "resume.xlsx").snapshot;
      const sheet = disk.sheets[disk.sheetOrder[0] ?? ""];
      expect(Object.values(sheet?.cellData ?? {}).map((row) => row?.[0]?.v)).toEqual([
        "marker",
        "applied-once",
        "original-one",
        "tail",
      ]);

      providerRecovered = true;
      if (target === "child-pending") {
        const { dispatch } = await api.sendMessage(session.id, agentId, {
          clientMessageId: "pending-after-failure",
          text: "只补收尾，不要重复插行",
          mode: "queue",
        });
        expect(dispatch.status).toBe("accepted");
        expect(
          (await api.getSession(session.id)).agents.find((a) => a.id === agentId)?.status,
        ).toBe("failed");
        expect(calls).toBe(8);
      }
      expect(await api.resumeAgent(session.id, agentId)).toMatchObject({
        resumed: target === "child-pending" ? 1 : 0,
        started: true,
      });
      const completed = (
        await waitLog(
          api,
          session.id,
          (all) =>
            all.some((r) => r.type === "turn.completed" && r.agentId === agentId) &&
            !srv.hasRunningAgents(),
          "失败后继续完成",
        )
      ).filter((r) => r.agentId === agentId);
      expect(calls).toBe(9);
      expect(resumedPrompt).toContainEqual({
        role: "tool",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "resume-edit",
            output: expect.objectContaining({ value: expect.objectContaining({ status: "ok" }) }),
          }),
        ]),
      });
      expect(completed.filter((r) => r.type === "turn.started")).toHaveLength(2);
      expect(completed.filter((r) => r.type === "turn.failed")).toHaveLength(1);
      expect(completed.filter((r) => r.type === "turn.completed")).toHaveLength(1);
      expect(resultsOf(completed, "resume-edit")).toHaveLength(1);
      expect(
        completed.filter((r) => r.type === "tool.intent" && r.data.toolName === "workbook_edit"),
      ).toHaveLength(1);
      expect(documentState()).toMatchObject({ rev: 1, head_rev: 1, checkpoint_rev: 1 });
      expect(
        db.prepare("SELECT rev, tool_call_id FROM doc_ops WHERE doc_id = ?").all(document.id),
      ).toEqual([{ rev: 1, tool_call_id: "resume-edit" }]);
      expect(readFileSync(file)).toEqual(committedBytes);
      expect(await api.resumeAgent(session.id, agentId)).toMatchObject({
        resumed: 0,
        started: false,
      });
      expect(calls).toBe(9);
    } finally {
      db.close();
    }
  },
  20_000,
);

test("failed child waits for explicit resume and repeated queued resumes start only one turn", async () => {
  let action: "spawn-failed" | "send-inbox" | "spawn-blocker" | "idle" = "spawn-failed";
  let childId = "";
  let childCalls = 0;
  let recovered = false;
  let releaseBlocker = () => {};
  const blockerGate = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const { srv, api } = await boot(
    async (prompt) => {
      const system = systemOf(prompt);
      if (system.includes("failed-gate-child")) {
        childCalls += 1;
        return recovered
          ? text("恢复一次")
          : streamOf([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "partial" },
              { type: "text-delta", id: "partial", delta: "断流" },
            ]);
      }
      if (system.includes("hold-gate-child")) {
        await blockerGate;
        return text("释放并发名额");
      }
      const next = action;
      action = "idle";
      if (next === "spawn-failed" || next === "spawn-blocker")
        return call(next, "agent_spawn", {
          name: next,
          role: "reader",
          task: next === "spawn-failed" ? "failed-gate-child" : "hold-gate-child",
        });
      if (next === "send-inbox")
        return call("ordinary-inbox", "agent_send", { to: childId, message: "普通进度消息" });
      return text("已收到");
    },
    { maxConcurrentSubAgents: 1 },
  );
  try {
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "spawn-failed", text: "派生" });
    await waitLog(
      api,
      session.id,
      (all) => all.some((r) => r.type === "turn.failed") && !srv.hasRunningAgents(),
      "子代理失败并收尾",
    );
    childId =
      (await api.getSession(session.id)).agents.find((a) => a.name === "spawn-failed")?.id ?? "";
    expect(childId).not.toBe("");
    expect(childCalls).toBe(6);
    recovered = true;
    action = "send-inbox";
    await api.sendMessage(session.id, "main", {
      clientMessageId: "send-inbox",
      text: "给子代理发送普通进度消息",
    });
    const inbox = await waitLog(
      api,
      session.id,
      (all) => resultsOf(all, "ordinary-inbox").length === 1 && !srv.hasRunningAgents(),
      "普通消息不唤醒失败子代理",
    );
    expect(resultsOf(inbox, "ordinary-inbox")[0]?.data.status).toBe("ok");
    expect(inbox.some((r) => r.type === "inbox.sent" && r.data.toAgentId === childId)).toBe(true);
    expect((await api.getSession(session.id)).agents.find((a) => a.id === childId)?.status).toBe(
      "failed",
    );
    expect(childCalls).toBe(6);

    action = "spawn-blocker";
    await api.sendMessage(session.id, "main", {
      clientMessageId: "spawn-blocker",
      text: "占用唯一并发名额",
    });
    await waitLog(
      api,
      session.id,
      (all) =>
        all.some((r) => r.type === "step.started" && r.agentId !== "main" && r.agentId !== childId),
      "另一子代理占满并发",
    );
    for (let click = 0; click < 3; click += 1) {
      expect(await api.resumeAgent(session.id, childId)).toMatchObject({
        resumed: 0,
        started: false,
      });
      const { agents } = await api.getSession(session.id);
      expect(agents.find((a) => a.id === childId)?.status).toBe("queued");
      expect(agents.filter((a) => a.role !== "main" && a.status === "running")).toHaveLength(1);
      expect(childCalls).toBe(6);
    }
    releaseBlocker();
    const completed = await waitLog(
      api,
      session.id,
      (all) =>
        all.some((r) => r.type === "turn.completed" && r.agentId === childId) &&
        !srv.hasRunningAgents(),
      "名额释放后仅继续一轮",
    );
    const child = completed.filter((r) => r.agentId === childId);
    expect(child.filter((r) => r.type === "turn.started")).toHaveLength(2);
    expect(child.filter((r) => r.type === "turn.completed")).toHaveLength(1);
    expect(
      child.filter((r) => r.type === "agent.status" && r.data.status === "queued"),
    ).toHaveLength(1);
    expect(childCalls).toBe(7);
  } finally {
    releaseBlocker();
  }
}, 20_000);

test("target resolution failure is fail-closed before tool execution", async () => {
  let step = 0;
  let executed = false;
  const probe = {
    name: "probe_target_failure",
    title: "目标解析",
    description: "test",
    input: z.strictObject({}),
    output: z.unknown(),
    effect: "write" as const,
    targets: (_args: unknown, scope?: { workspaceId: string; workspaceRoot: string }) => {
      expect(scope?.workspaceId).toBeTruthy();
      expect(scope?.workspaceRoot).toBeTruthy();
      throw new Error("目标参数矛盾");
    },
    replay: "unsafe" as const,
    timeoutMs: 1000,
    roles: ["main" as const],
    execute: () => {
      executed = true;
      return { status: "ok" as const };
    },
  };
  const { api } = await boot(
    () => (++step === 1 ? call("bad-target", probe.name, {}) : text("收到拒绝")),
    { modules: [{ id: "target-probe", tools: [probe] } as unknown as CapabilityModule] },
  );
  const { session } = await api.createSession({});
  await api.sendMessage(session.id, "main", {
    clientMessageId: "bad-target",
    text: "测试目标错误",
  });
  const items = await waitLog(
    api,
    session.id,
    (all) => all.some((r) => r.type === "turn.completed"),
    "拒绝完成",
  );
  expect(executed).toBe(false);
  expect(resultsOf(items, "bad-target")[0]?.data.result).toMatchObject({
    status: "error",
    error: { code: "INVALID_ARGUMENT", message: "目标参数矛盾" },
  });
});
