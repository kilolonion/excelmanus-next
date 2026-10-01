// M6 审计分支 4（代理主循环）回归：真实 HTTP + 真实 SQLite 文件 + MockLanguageModelV4
// （只替代模型输出）。P1-14/P1-20 另用测试模块注入探针工具，走同一条运行时执行路径。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type CapabilityModule, kernelProjections, SessionLog } from "@excelmanus/kernel";
import { type ApiClient, createApiClient, type LogRecord } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { type RunningServer, startServer } from "../src/index.ts";

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
  opts: { modules?: CapabilityModule[] } = {},
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
  });
  servers.push(srv);
  const api = createApiClient(srv.url, srv.token);
  await api.createModelProfile({
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
