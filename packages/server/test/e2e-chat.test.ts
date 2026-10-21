import { createTestProfile } from "./fixtures/create-model.ts";
// M1 后端纵切集成测试（ADR 0006：真实 HTTP/WebSocket/SQLite 文件 + 假模型）。
// 假模型只替代模型服务输出（doStream），不替代我们自己的任何代码：
// 档案/会话/派发/日志/投影/票据/续传全部走真实路径。

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createApiClient, type RecMsg, type ServerMessage } from "@excelmanus/protocol";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function streamOf(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

function apiErr(status: number, headers: Record<string, string> = {}): APICallError {
  return new APICallError({
    message: `HTTP ${status}`,
    url: "https://mock.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    responseBody: `{"error":{"message":"e${status}"}}`,
    isRetryable: status === 429 || status >= 500,
  });
}

function lastUserText(prompt: Array<{ role: string; content: unknown }>): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const parts = m.content as Array<{ type: string; text?: string }>;
    return parts.map((p) => p.text ?? "").join("");
  }
  return "";
}

/**
 * Mock 模型：第一步（历史中无 tool 结果）调用 find 列工作区；
 * 第二步流式文本回答。文本含 [[429]]/[[401]] 时抛对应 APICallError 测试错误路径。
 */
function makeMockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-1",
    doStream: async (opts) => {
      const prompt = opts.prompt as Array<{ role: string; content: unknown }>;
      const text = lastUserText(prompt);
      if (text.includes("[[401]]")) throw apiErr(401);
      if (text.includes("[[429]]")) throw apiErr(429);
      const hasToolResult = prompt.some((m) => m.role === "tool");
      if (!hasToolResult) {
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "tc1", toolName: "find" },
            { type: "tool-input-delta", id: "tc1", delta: '{"path":' },
            { type: "tool-input-delta", id: "tc1", delta: '"."}' },
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "find",
              input: '{"path":"."}',
            },
            {
              type: "finish",
              usage: USAGE,
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
            },
          ]),
        };
      }
      return {
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "工作区里有：" },
          { type: "text-delta", id: "t1", delta: "note.txt。" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            usage: USAGE,
            finishReason: { unified: "stop", raw: "stop" },
          },
        ]),
      };
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TestWs {
  readonly msgs: ServerMessage[] = [];
  private ws!: WebSocket;
  private constructor() {}

  static async connect(url: string): Promise<TestWs> {
    const c = new TestWs();
    c.ws = new WebSocket(url);
    // 服务端在 upgrade 完成即刻发 hello，必须与 open 之前挂监听，否则首帧丢失
    c.ws.on("message", (data) => {
      c.msgs.push(JSON.parse(String(data)) as ServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once("open", () => resolve());
      c.ws.once("error", reject);
    });
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  recs(): RecMsg[] {
    return this.msgs.filter((m): m is RecMsg => m.type === "rec");
  }

  async waitFor(
    pred: (m: ServerMessage) => boolean,
    what: string,
    timeoutMs = 15_000,
  ): Promise<ServerMessage> {
    const t0 = Date.now();
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `等待超时：${what}；已收到 ${this.msgs.length} 条 ${JSON.stringify(this.msgs.map((x) => x.type))}`,
        );
      }
      await sleep(10);
    }
  }

  async waitRec(pred: (r: RecMsg) => boolean, what: string, timeoutMs = 15_000): Promise<RecMsg> {
    const t0 = Date.now();
    for (;;) {
      const m = this.recs().find(pred);
      if (m) return m;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `等待超时：${what}；recs=${JSON.stringify(this.recs().map((x) => x.record.type))}`,
        );
      }
      await sleep(10);
    }
  }

  close(): void {
    this.ws.close();
  }
}

const servers: RunningServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function typeSeq(recs: RecMsg[]): string[] {
  return recs.map((r) => r.record.type);
}

/** 断言 expected 是 actual 的保序子序列。 */
function expectSubsequence(actual: string[], expected: string[]): void {
  let i = 0;
  for (const t of actual) {
    if (i < expected.length && t === expected[i]) i += 1;
  }
  expect(i, `子序列未按序出现：${JSON.stringify(actual)}`).toBe(expected.length);
}

describe("e2e：档案→会话→WS订阅→消息→只读工具→流式回答", () => {
  test("完整纵切 + 游标续传 + 日志一致性 + 错误路径", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-e2e-"));
    dirs.push(dataDir);
    const srv = await startServer({
      dataDir,
      retryBaseMs: 10,
      resolveLanguageModel: () => makeMockModel(),
      log: () => {},
    });
    servers.push(srv);
    writeFileSync(join(srv.workspaceRoot, "note.txt"), "hello workspace\n", "utf8");

    const api = createApiClient(srv.url, srv.token);
    expect(await api.health()).toMatchObject({ ok: true, protocolVersion: 4 });
    const boot = await api.bootstrap();
    expect(boot.hasModelProfile).toBe(false);
    expect(boot.modules).toContain("files");

    const providers = await api.listProviders();
    expect(providers.items.map((p) => p.id)).toContain("mimo");

    // 模型档案：apiKey 读回只有掩码
    const { profile } = await createTestProfile(api, {
      name: "测试档案",
      provider: "custom-openai-compatible",
      model: "mock-1",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "sk-test-1234",
    });
    expect(profile.apiKeyMasked).toBe("••••1234");
    expect(profile.hasCredential).toBe(true);
    expect(profile.isDefault).toBe(true);

    const { session, agents } = await api.createSession({});
    expect(agents[0]?.role).toBe("main");
    const sid = session.id;
    const agentId = "main";

    // ---- WS：票据 → hello → sub ----
    const { ticket } = await api.createTicket();
    const ws = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    await ws.waitFor((m) => m.type === "hello", "hello");
    // cursor=0：从日志开头回放（含 session.created/agent.spawned），与 GET /log 全量对齐
    ws.send({ type: "sub", topic: `session:${sid}`, cursor: 0 });
    const subOk = await ws.waitFor(
      (m) => m.type === "sub.ok" && m.topic === `session:${sid}`,
      "sub.ok",
    );
    expect(subOk).toMatchObject({ type: "sub.ok", headCursor: 2 });

    // ---- 发消息：模型先调 find，再流式回答 ----
    await api.sendMessage(sid, agentId, {
      clientMessageId: "m1",
      text: "列出工作区里的文件",
    });
    await ws.waitRec((r) => r.record.type === "turn.completed", "turn.completed");

    const recs = ws.recs();
    const types = typeSeq(recs);
    expectSubsequence(types, [
      "user.message",
      "dispatch.updated",
      "turn.started",
      "step.started",
      "model.output",
      "tool.intent",
      "tool.result",
      "step.started",
      "model.output",
      "turn.completed",
    ]);

    // tool.result 是真实 find 的结果：能看到 note.txt
    const toolResult = recs.find((r) => r.record.type === "tool.result");
    const trData = toolResult?.record.data as {
      status: string;
      result: { status: string; data?: { entries?: { path: string }[] } };
    };
    expect(trData.status).toBe("ok");
    const paths = trData.result.data?.entries?.map((e) => e.path) ?? [];
    expect(paths).toContain("note.txt");

    // 流式增量：tool_args 与 text delta 都到达过
    const deltas = ws.msgs.filter((m) => m.type === "delta");
    // v3：tool_args 分片带工具 id，首个分片（tool-input-start）带工具名
    const argParts = deltas.flatMap((d) =>
      d.type === "delta" && d.kind === "tool_args"
        ? [d.payload as { id: string; name?: string; delta: string }]
        : [],
    );
    expect(argParts[0]).toEqual({ id: "tc1", name: "find", delta: "" });
    expect(argParts.every((p) => p.id === "tc1")).toBe(true);
    expect(argParts.map((p) => p.delta).join("")).toBe('{"path":"."}');
    expect(deltas.some((d) => d.type === "delta" && d.kind === "text")).toBe(true);

    const headAfterTurn1 = Math.max(...recs.map((r) => r.seq));
    ws.close();

    // ---- 断开后发第二条消息（走 queue），服务端继续写日志 ----
    await api.sendMessage(sid, agentId, {
      clientMessageId: "m2",
      text: "再说一遍",
      mode: "queue",
    });
    const t0 = Date.now();
    for (;;) {
      const page = await api.getSessionLog(sid, { limit: 10 });
      if (
        page.items.filter((i) => i.type === "turn.completed").length >= 2 ||
        page.items.some((i) => i.type === "turn.failed")
      ) {
        break;
      }
      if (Date.now() - t0 > 15_000) throw new Error("第二轮未完成");
      await sleep(20);
    }

    // ---- 用游标重连：只收到之后的记录 ----
    const { ticket: ticket2 } = await api.createTicket();
    const ws2 = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket2}`);
    await ws2.waitFor((m) => m.type === "hello", "hello2");
    ws2.send({ type: "sub", topic: `session:${sid}`, cursor: headAfterTurn1 });
    await ws2.waitFor((m) => m.type === "sub.ok", "sub.ok2");
    await ws2.waitRec((r) => r.record.type === "turn.completed", "turn2 completed 回放");
    const replayed = ws2.recs();
    expect(replayed.length).toBeGreaterThan(0);
    expect(Math.min(...replayed.map((r) => r.seq))).toBe(headAfterTurn1 + 1);
    // 断线期间写入的第二轮：user.message 起、turn.completed/usage.updated 止
    expect(typeSeq(replayed)).toEqual([
      "user.message",
      "dispatch.updated",
      "dispatch.updated",
      "turn.started",
      "step.started",
      "model.output",
      "turn.completed",
      "usage.updated",
    ]);
    ws2.close();

    // ---- GET /log 与 WS 收到的完全一致 ----
    const logPage = await api.getSessionLog(sid, { limit: 500 });
    const allRecs = [...recs, ...replayed];
    expect(logPage.items.length).toBe(allRecs.length);
    expect(logPage.items.map((i) => i.seq)).toEqual(allRecs.map((r) => r.seq));
    expect(logPage.items.map((i) => i.type)).toEqual(allRecs.map((r) => r.record.type));

    // ---- 429：可重试错误 → retry.scheduled → 失败后 error.guidance + turn.failed ----
    const { ticket: t3 } = await api.createTicket();
    const ws3 = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${t3}`);
    await ws3.waitFor((m) => m.type === "hello", "hello3");
    ws3.send({ type: "sub", topic: `session:${sid}` });
    await ws3.waitFor((m) => m.type === "sub.ok", "sub.ok3");
    await api.sendMessage(sid, agentId, {
      clientMessageId: "m3",
      text: "[[429]]",
    });
    await ws3.waitRec((r) => r.record.type === "turn.failed", "turn.failed(429)", 30_000);
    const types3 = typeSeq(ws3.recs());
    expect(types3).toContain("retry.scheduled");
    expect(types3).toContain("error.guidance");
    expect(types3.indexOf("retry.scheduled")).toBeLessThan(types3.indexOf("error.guidance"));
    const guidance = ws3.recs().find((r) => r.record.type === "error.guidance");
    const gd = guidance?.record.data as { kind: string } | undefined;
    expect(gd?.kind).toBe("rate_limit");

    // ---- 401：不可重试 → 直接 error.guidance + turn.failed（无 retry.scheduled）----
    const turn3End = Math.max(...ws3.recs().map((r) => r.seq));
    await api.sendMessage(sid, agentId, {
      clientMessageId: "m4",
      text: "[[401]]",
    });
    await ws3.waitRec(
      (r) => r.record.type === "turn.failed" && r.seq > turn3End,
      "turn.failed(401)",
      30_000,
    );
    const recs4 = ws3.recs().filter((r) => r.seq > turn3End);
    const types4 = typeSeq(recs4);
    expect(types4).toContain("error.guidance");
    expect(types4).toContain("turn.failed");
    expect(types4).not.toContain("retry.scheduled");
    const g4 = recs4.find((r) => r.record.type === "error.guidance");
    const gd4 = g4?.record.data as { kind: string } | undefined;
    expect(gd4?.kind).toBe("auth");
    ws3.close();

    // ---- 幂等：同 clientMessageId 同内容返回原派发 ----
    const dupe = await api.sendMessage(sid, agentId, {
      clientMessageId: "m4",
      text: "[[401]]",
    });
    expect(dupe.deduplicated).toBe(true);

    // 会话标题：首条用户消息前 30 字
    const detail = await api.getSession(sid);
    expect(detail.session.title).toBe("列出工作区里的文件");
  }, 90_000);

  // ---- modules/workbook 纵切：mock 模型调 workbook_read overview + <context> 渲染 ----
  test("rewind：从某条消息重新开始，之后的对话不再进入模型上下文", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-e2e-rewind-"));
    dirs.push(dataDir);
    const prompts: string[] = [];
    const srv = await startServer({
      dataDir,
      retryBaseMs: 10,
      resolveLanguageModel: () =>
        new MockLanguageModelV4({
          provider: "mock",
          modelId: "mock-1",
          doStream: async (opts) => {
            prompts.push(JSON.stringify(opts.prompt));
            return {
              stream: streamOf([
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: "好的" },
                { type: "text-end", id: "t1" },
                { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
              ]),
            };
          },
        }),
      log: () => {},
    });
    servers.push(srv);
    const api = createApiClient(srv.url, srv.token);
    await createTestProfile(api, {
      name: "测试档案",
      provider: "custom-openai-compatible",
      model: "mock-1",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "sk-test-1234",
    });
    const { session } = await api.createSession({});
    const sid = session.id;
    const send = async (n: number, text: string) => {
      const { dispatch } = await api.sendMessage(sid, "main", { clientMessageId: `m${n}`, text });
      const t0 = Date.now();
      for (;;) {
        const page = await api.getSessionLog(sid, { limit: 200 });
        if (page.items.filter((i) => i.type === "turn.completed").length >= n) break;
        if (Date.now() - t0 > 15_000) throw new Error(`第 ${n} 轮未完成`);
        await sleep(20);
      }
      return dispatch.id;
    };
    await send(1, "第一条消息");
    const d2 = await send(2, "第二条消息");

    const out = await api.rewindAgent(sid, "main", { dispatchId: d2 });
    const log = await api.getSessionLog(sid, { limit: 200 });
    const msg2 = log.items.find(
      (i) => i.type === "user.message" && (i.data as { dispatchId?: string }).dispatchId === d2,
    );
    expect(out).toEqual({ ok: true, fromSeq: msg2?.seq, cancelled: [] });
    expect(log.items.at(-1)).toMatchObject({
      type: "history.rewound",
      data: { dispatchId: d2, fromSeq: msg2?.seq },
    });

    await send(3, "改过的第二条");
    const last = prompts.at(-1) ?? "";
    expect(last).toContain("第一条消息");
    expect(last).toContain("改过的第二条");
    expect(last).not.toContain("第二条消息");

    await expect(api.rewindAgent(sid, "main", { dispatchId: "dsp_nope" })).rejects.toMatchObject({
      status: 404,
    });
  });

  test("workbook_read 走真实 DocumentService；context 渲染进模型历史", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-e2e-wb-"));
    dirs.push(dataDir);
    let lastPrompt: Array<{ role: string; content: unknown }> = [];
    const srv = await startServer({
      dataDir,
      retryBaseMs: 10,
      log: () => {},
      resolveLanguageModel: () =>
        new MockLanguageModelV4({
          provider: "mock",
          modelId: "mock-wb",
          doStream: async (opts) => {
            lastPrompt = opts.prompt as Array<{ role: string; content: unknown }>;
            const hasToolResult = lastPrompt.some((m) => m.role === "tool");
            if (!hasToolResult) {
              return {
                stream: streamOf([
                  { type: "stream-start", warnings: [] },
                  {
                    type: "tool-call",
                    toolCallId: "tw1",
                    toolName: "workbook_read",
                    input: '{"path":"sales.xlsx","mode":"overview"}',
                  },
                  {
                    type: "finish",
                    usage: USAGE,
                    finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  },
                ]),
              };
            }
            return {
              stream: streamOf([
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: "工作簿已读取。" },
                { type: "text-end", id: "t1" },
                {
                  type: "finish",
                  usage: USAGE,
                  finishReason: { unified: "stop", raw: "stop" },
                },
              ]),
            };
          },
        }),
    });
    servers.push(srv);
    const samples = join(dirname(fileURLToPath(import.meta.url)), "../../../samples");
    cpSync(join(samples, "sales.xlsx"), join(srv.workspaceRoot, "sales.xlsx"));

    const api = createApiClient(srv.url, srv.token);
    await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock-wb",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "sk-test-1234",
    });
    const { session } = await api.createSession({});
    const sid = session.id;

    const { ticket } = await api.createTicket();
    const ws = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    await ws.waitFor((m) => m.type === "hello", "hello");
    ws.send({ type: "sub", topic: `session:${sid}`, cursor: 0 });
    await ws.waitFor((m) => m.type === "sub.ok", "sub.ok");

    // REST 打开文档拿到 docId/rev，随消息带 context（04 §7.3）
    const { document } = await api.openDoc(session.workspaceId, { path: "sales.xlsx" });
    expect(document.rev).toBe(0);
    await api.sendMessage(sid, "main", {
      clientMessageId: "wb1",
      text: "这个工作簿里有什么",
      context: [{ docId: document.id, rev: document.rev, range: "销售!A1:F3" }],
    });
    await ws.waitRec((r) => r.record.type === "turn.completed", "wb turn.completed", 30_000);

    const recs = ws.recs();
    expectSubsequence(typeSeq(recs), [
      "user.message",
      "turn.started",
      "step.started",
      "model.output",
      "tool.intent",
      "tool.result",
      "model.output",
      "turn.completed",
    ]);
    const intent = recs.find((r) => r.record.type === "tool.intent");
    const intentData = intent?.record.data as { toolName?: string } | undefined;
    expect(intentData?.toolName).toBe("workbook_read");
    const result = recs.find((r) => r.record.type === "tool.result");
    const rd = result?.record.data as {
      status: string;
      result: { status: string; data?: { sheets?: { name: string }[] } };
    };
    expect(rd.status).toBe("ok");
    expect(rd.result.status).toBe("ok");
    expect(rd.result.data?.sheets?.[0]?.name).toBe("销售");

    // 给模型的用户消息里应有 <context> 块
    const userText = lastUserText(lastPrompt);
    expect(userText).toContain("<context>");
    expect(userText).toContain(document.id);
    expect(userText).toContain("销售!A1:F3");

    // 快照 REST 也真实返回
    const snap = await api.getDocSnapshot(session.workspaceId, document.id);
    expect(snap.document.id).toBe(document.id);
    expect((snap.snapshot as { sheetOrder: string[] }).sheetOrder.length).toBe(2);

    // 文件列表含 sales.xlsx
    const files = await api.listFiles(session.workspaceId);
    expect(files.items.map((f) => f.name)).toContain("sales.xlsx");

    // 供 web reducer 测试使用的真实消息流 fixture（只留 rec/delta，去掉 hello/sub.ok）
    const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../web/test/fixtures");
    mkdirSync(fixturesDir, { recursive: true });
    const streamFixture = ws.msgs.filter((m) => m.type === "rec" || m.type === "delta");
    writeFileSync(join(fixturesDir, "session-stream.json"), JSON.stringify(streamFixture, null, 2));
    ws.close();
  }, 60_000);
});
