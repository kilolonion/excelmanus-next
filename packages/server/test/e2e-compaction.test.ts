import { createTestProfile } from "./fixtures/create-model.ts";
// M3 上下文压缩集成测试（04 §6、10 §3.3，14 场景 12 与场景 22 的超限重试部分；
// ADR 0006：真实 HTTP/WebSocket/SQLite 文件 + MockLanguageModelV4 只替代模型输出）。
// 摘要调用通过 prompt 中 system 是否等于 COMPACTION_SYSTEM 与主调用区分。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { COMPACTION_SYSTEM } from "@excelmanus/kernel";
import { type ApiClient, createApiClient, type LogRecord } from "@excelmanus/protocol";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";

const LOW_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

/** input+output = 390，超过窗口 400 的 80%（320）。 */
const HIGH_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 380, noCache: 380, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function streamOf(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

type Prompt = Array<{ role: string; content: unknown }>;
type ModelOut = { stream: ReadableStream<LanguageModelV4StreamPart> };

const textOut = (text: string, usage: LanguageModelV4Usage = LOW_USAGE, id = "t1"): ModelOut => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
  ]),
});

const toolCallOut = (
  toolCallId: string,
  toolName: string,
  input: string,
  usage: LanguageModelV4Usage = LOW_USAGE,
): ModelOut => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
  ]),
});

class Gate {
  readonly promise: Promise<void>;
  private release!: () => void;
  constructor() {
    this.promise = new Promise((r) => {
      this.release = r;
    });
  }
  open(): void {
    this.release();
  }
}

const SUMMARY = [
  "## 用户目标与约束",
  "用户要核对销售表口径",
  "## 已做出的决定",
  "无",
  "## 涉及的文件与最后已知修订号",
  "无",
  "## 未完成的待办",
  "无",
  "## 用户明确说过的偏好",
  "无",
  "## 重要中间结果",
  "表头口径：B 列为含税金额",
].join("\n");

function systemText(prompt: Prompt): string {
  const m = prompt.find((x) => x?.role === "system");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
}

function isCompactionCall(prompt: Prompt): boolean {
  return systemText(prompt) === COMPACTION_SYSTEM;
}

function allUserText(prompt: Prompt): string {
  return prompt
    .filter((m) => m?.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join(""),
    )
    .join("\n");
}

const servers: RunningServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface ModelSpec {
  /** 主调用按序执行；compaction 调用由 summary 处理。 */
  main: ((prompt: Prompt) => Promise<ModelOut> | ModelOut)[];
  summary?: (prompt: Prompt) => Promise<ModelOut> | ModelOut;
}

async function boot(
  spec: ModelSpec,
  opts: { contextWindow?: number } = {},
): Promise<{ srv: RunningServer; api: ApiClient; sessionId: string; calls: Prompt[] }> {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-compact-"));
  dirs.push(dataDir);
  const calls: Prompt[] = [];
  let mainIdx = 0;
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-compact",
    doStream: async (o) => {
      const prompt = [...(o.prompt as Prompt)];
      calls.push(prompt);
      if (isCompactionCall(prompt)) {
        return (spec.summary ?? (() => textOut(SUMMARY)))(prompt);
      }
      const handler = spec.main[mainIdx] ?? (() => textOut("…"));
      mainIdx += 1;
      return handler(prompt);
    },
  });
  const srv = await startServer({
    dataDir,
    retryBaseMs: 10,
    resolveLanguageModel: () => model,
    log: () => {},
  });
  servers.push(srv);
  const api = createApiClient(srv.url, srv.token);
  await createTestProfile(api, {
    name: "mock",
    provider: "custom-openai-compatible",
    model: "mock-compact",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "test",
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
  });
  const { session } = await api.createSession({});
  return { srv, api, sessionId: session.id, calls };
}

async function waitLog(
  api: ApiClient,
  sessionId: string,
  pred: (items: LogRecord[]) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<LogRecord[]> {
  const t0 = Date.now();
  for (;;) {
    const { items } = await api.getSessionLog(sessionId, { limit: 500 });
    if (pred(items)) return items;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待超时：${what}；types=${JSON.stringify(items.map((i) => i.type))}`);
    }
    await sleep(20);
  }
}

const AGENT = "main";
const BIG = "很长的背景描述。".repeat(120); // ~840 字符，保证进旧侧

function overflowError(): APICallError {
  return new APICallError({
    message: "prompt is too long",
    url: "https://mock.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"error":{"message":"prompt is too long"}}',
    isRetryable: true,
  });
}

describe("M3 上下文压缩（04 §6）", () => {
  test("auto：占用达 80% 在步骤边界压缩，同轮继续、prompt 换为摘要+保留尾部", async () => {
    // 第一轮用量 390（≥0.8*400）；第二轮 step 边界触发 auto 压缩
    const { api, sessionId, calls } = await boot(
      {
        main: [
          () => textOut(`${"第一轮的大回答。".repeat(60)}`, HIGH_USAGE),
          () => textOut("压缩后的回答", LOW_USAGE),
        ],
        summary: () => textOut(SUMMARY),
      },
      { contextWindow: 400 },
    );
    await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "a1",
      text: `最早的用户消息：${BIG}`,
    });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "turn.completed"), "轮1完成");

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "a2", text: "第二问" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 2,
      "轮2完成",
    );

    // compaction 记录：trigger auto，非估算（提供商报告 390→压缩）
    const cmp = items.find((r) => r.type === "compaction");
    expect(cmp?.data.trigger).toBe("auto");
    expect(cmp?.data.estimated).toBe(false);
    expect(cmp?.data.keepFromSeq).not.toBeNull();
    // 压缩发生在轮 2 的步骤边界：turn.started(2) 之后、第二个 step.started 之前没有新轮
    expect(items.filter((r) => r.type === "turn.started").length).toBe(2);
    const t2Start = items.findIndex(
      (r) =>
        r.type === "turn.started" &&
        r.data.turnId !== items.find((x) => x.type === "turn.started")?.data.turnId,
    );
    const cmpIdx = items.findIndex((r) => r.type === "compaction");
    expect(cmpIdx).toBeGreaterThan(t2Start);
    // 压缩摘要调用夹在两个主调用之间
    expect(calls.length).toBe(3);
    expect(isCompactionCall(calls[1] ?? [])).toBe(true);
    // 摘要请求是压缩器 system + 纯文本转录（含被压缩的最早用户消息文本）
    expect(allUserText(calls[1] ?? [])).toContain("【用户】");
    expect(allUserText(calls[1] ?? [])).toContain("最早的用户消息");
    // 压缩后主调用：含 <summary> 与摘要事实，含保留尾部「第二问」，不含被摘要的最早消息原文
    const prompt = calls[2] ?? [];
    expect(allUserText(prompt)).toContain("<summary>");
    expect(allUserText(prompt)).toContain("表头口径：B 列为含税金额");
    expect(allUserText(prompt)).toContain("第二问");
    expect(allUserText(prompt)).not.toContain("最早的用户消息");
    // usage.updated 带上下文占用
    const usageRec = items.findLast(
      (r) => r.type === "usage.updated" && r.data.context !== undefined,
    );
    expect(usageRec).toBeDefined();
    expect((usageRec?.data.context as { window?: number } | undefined)?.window).toBe(400);
  }, 30_000);

  test("auto：摘要调用失败不阻塞本步，无 compaction 记录", async () => {
    const { api, sessionId, calls } = await boot(
      {
        main: [
          () => textOut(`${"第一轮的大回答。".repeat(60)}`, HIGH_USAGE),
          () => textOut("照常回答", LOW_USAGE),
        ],
        summary: () => {
          throw new Error("summary backend down");
        },
      },
      { contextWindow: 400 },
    );
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "f1", text: `第一条 ${BIG}` });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "turn.completed"), "轮1完成");
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "f2", text: "继续问" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 2,
      "轮2完成",
    );
    expect(items.some((r) => r.type === "compaction")).toBe(false);
    expect(calls.length).toBe(3);
    expect(isCompactionCall(calls[1] ?? [])).toBe(true);
    // 压缩失败后主调用仍用未压缩上下文
    expect(allUserText(calls[2] ?? [])).toContain("第一条");
  }, 30_000);

  test("overflow：上下文超限 → 压缩后同轮重试一次并完成", async () => {
    const { api, sessionId, calls } = await boot(
      {
        main: [
          () => textOut(`${"第一轮的大回答。".repeat(60)}`, LOW_USAGE),
          () => {
            throw overflowError();
          },
          () => textOut("压缩后重试的回答", LOW_USAGE),
        ],
        summary: () => textOut(SUMMARY),
      },
      { contextWindow: 400 },
    );
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "o1", text: `第一条 ${BIG}` });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "turn.completed"), "轮1完成");

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "o2", text: "第二问" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 2,
      "轮2完成",
    );
    const cmp = items.find((r) => r.type === "compaction");
    expect(cmp?.data.trigger).toBe("overflow");
    expect(items.some((r) => r.type === "turn.failed")).toBe(false);
    // 同一轮内完成：turn.started 总数 2
    expect(items.filter((r) => r.type === "turn.started").length).toBe(2);
    // 调用序：主（轮1）→ 主抛错 → 摘要 → 主重试成功
    expect(calls.length).toBe(4);
    expect(isCompactionCall(calls[2] ?? [])).toBe(true);
    expect(allUserText(calls[3] ?? [])).toContain("<summary>");
  }, 30_000);

  test("overflow：压缩后再次超限 → turn.failed + context_overflow 指引", async () => {
    const { api, sessionId, calls } = await boot(
      {
        main: [
          () => textOut(`${"第一轮的大回答。".repeat(60)}`, LOW_USAGE),
          () => {
            throw overflowError();
          },
          () => {
            throw overflowError();
          },
        ],
        summary: () => textOut(SUMMARY),
      },
      { contextWindow: 400 },
    );
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "x1", text: `第一条 ${BIG}` });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "turn.completed"), "轮1完成");

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "x2", text: "第二问" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.failed"),
      "turn.failed",
    );
    const cmp = items.find((r) => r.type === "compaction");
    expect(cmp?.data.trigger).toBe("overflow");
    const failed = items.find((r) => r.type === "turn.failed");
    expect((failed?.data.error as { kind?: string } | undefined)?.kind).toBe("context_overflow");
    const guidance = items.find(
      (r) => r.type === "error.guidance" && r.data.kind === "context_overflow",
    );
    expect(guidance).toBeDefined();
    // 只重试一次：主调用共 3 次（轮1 + 首轮 + 重试）
    expect(calls.length).toBe(4);
    expect(calls.filter(isCompactionCall).length).toBe(1);
  }, 30_000);

  test("manual：空闲立即压缩无 turn.*；历史过短返回 compacted=false", async () => {
    const { api, sessionId, calls } = await boot(
      {
        main: [
          () => textOut(`${"第一轮的大回答。".repeat(60)}`, LOW_USAGE),
          () => textOut("压缩后的回答", LOW_USAGE),
        ],
        summary: () => textOut(SUMMARY),
      },
      { contextWindow: 400 },
    );
    // 无任何历史时无可压缩
    const empty = await api.compactAgent(sessionId, AGENT);
    expect(empty).toEqual({ compacted: false, scheduled: false });

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "m1", text: `第一条 ${BIG}` });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "turn.completed"), "轮1完成");

    const res = await api.compactAgent(sessionId, AGENT);
    expect(res).toEqual({ compacted: true, scheduled: false });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "compaction"),
      "compaction 记录",
    );
    const cmp = items.find((r) => r.type === "compaction");
    expect(cmp?.data.trigger).toBe("manual");
    // 空闲压缩不写 turn.*：turn.started 仍只有轮 1 那一个
    expect(items.filter((r) => r.type === "turn.started").length).toBe(1);

    // 压缩后下一轮 prompt 含摘要
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "m2", text: "再问" });
    await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 2,
      "轮2完成",
    );
    const lastMain = calls[calls.length - 1] ?? [];
    expect(allUserText(lastMain)).toContain("<summary>");
  }, 30_000);

  test("manual：运行中 POST 返回 scheduled，下一步前出现 manual 压缩", async () => {
    const gate = new Gate();
    const { api, sessionId, calls } = await boot(
      {
        main: [
          // 轮 1：先完成，攒下可压缩历史
          () => textOut(`${"第一轮的大回答。".repeat(60)}`, LOW_USAGE),
          // 轮 2 第 1 步被 gate 卡住
          async () => {
            await gate.promise;
            return toolCallOut("tc1", "find", '{"path":"."}', LOW_USAGE);
          },
          () => textOut("压缩后的回答", LOW_USAGE),
        ],
        summary: () => textOut(SUMMARY),
      },
      { contextWindow: 400 },
    );
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "r1", text: `第一条 ${BIG}` });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "turn.completed"), "轮1完成");

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "r2", text: "第二问" });
    const secondTurnStarted = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.started").length >= 2,
      "轮2开始",
    );
    const t2Seq = secondTurnStarted.filter((r) => r.type === "turn.started")[1]?.seq ?? 0;
    await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "step.started" && r.seq > t2Seq),
      "轮2 step1",
    );
    await sleep(30);

    const res = await api.compactAgent(sessionId, AGENT);
    expect(res).toEqual({ compacted: false, scheduled: true });
    gate.open();

    const items = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 2,
      "轮2完成",
    );
    const cmp = items.find((r) => r.type === "compaction");
    expect(cmp?.data.trigger).toBe("manual");
    // 压缩记录落在轮 2 的第 1 步之后、第 2 个 step.started 之前
    const stepStarts = items
      .filter((r) => r.type === "step.started" && r.seq > t2Seq)
      .map((r) => r.seq);
    const cmpSeq = cmp?.seq ?? -1;
    expect(stepStarts.length).toBe(2);
    expect(cmpSeq).toBeGreaterThan(stepStarts[0] ?? 0);
    expect(cmpSeq).toBeLessThan(stepStarts[1] ?? 0);
    expect(items.filter((r) => r.type === "turn.started").length).toBe(2);
    // 压缩后的主调用看到摘要
    const lastMain = calls[calls.length - 1] ?? [];
    expect(allUserText(lastMain)).toContain("<summary>");
  }, 30_000);

  test("保留尾部含工具调用对：assistant toolCalls 与 toolResult 同侧、AI SDK 转换不报错", async () => {
    const { api, sessionId, calls } = await boot(
      {
        main: [
          () => textOut(`${"第一轮的大回答。".repeat(60)}`, LOW_USAGE),
          () => toolCallOut("tk1", "find", '{"path":"."}', LOW_USAGE),
          () => textOut("列目录完成", LOW_USAGE),
          () => textOut("压缩后的回答", LOW_USAGE),
        ],
        summary: () => textOut(SUMMARY),
      },
      { contextWindow: 400 },
    );
    // 轮1：大消息 + 大回答（进旧侧）
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "p1", text: `第一条 ${BIG}` });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "turn.completed"), "轮1完成");
    // 轮2：小消息 + 工具调用对（进保留尾部）
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "p2", text: "列一下目录" });
    await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 2,
      "轮2完成",
    );

    const res = await api.compactAgent(sessionId, AGENT);
    expect(res.compacted).toBe(true);
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "compaction"), "compaction");

    // 下一轮主调用 prompt：tool 结果必须跟在携带对应 tool-call 的 assistant 消息后
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "p3", text: "再问" });
    await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 3,
      "轮3完成",
    );
    const prompt = calls[calls.length - 1] ?? [];
    const toolIdx = prompt.findIndex((m) => m.role === "tool");
    expect(toolIdx).toBeGreaterThan(-1);
    // 往前找最近的 assistant 消息，须含相同 toolCallId 的 tool-call 部件
    let callId: string | undefined;
    const toolMsg = prompt[toolIdx];
    const toolPart = (toolMsg?.content as Array<{ toolCallId?: string }>)?.[0];
    callId = toolPart?.toolCallId;
    const assistantIdx = prompt
      .slice(0, toolIdx)
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role === "assistant")
      .map(({ i }) => i)
      .pop();
    expect(assistantIdx).toBeDefined();
    const aContent = prompt[assistantIdx ?? -1]?.content as Array<{
      type: string;
      toolCallId?: string;
    }>;
    expect(aContent.some((p) => p.type === "tool-call" && p.toolCallId === callId)).toBe(true);
    // 保留尾部第一条不是孤立工具结果：摘要后的第一个非 system 条目是 user
    const firstCtx = prompt.find((m) => m.role !== "system");
    expect(firstCtx?.role).toBe("user");
    expect(systemText(prompt)).not.toBe(COMPACTION_SYSTEM);
  }, 30_000);
});
