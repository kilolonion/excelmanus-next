// 判据执行器：每例收集中立 StepEvent、计时、断言、写 results/cases.json
// 与 fixtures/recordings/<caseId>.json（脱敏）。真实请求每例 ≤3 次。
// 本文件不得 import 'ai' 或 '@ai-sdk/*'（类型或值）；mock 只在 fixtures 里构造。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asHandle,
  mockContextOverflow,
  mockEcho,
  mockNetworkError,
  mockRateLimit,
  mockServerError,
  mockStreamInterrupted,
} from "./fixtures/mock-models.ts";
import type { RecordedExchange } from "./fixtures/recorder.ts";
import { Recorder } from "./fixtures/recorder.ts";
import { createGateway, createMimoModel } from "./gateway/gateway.ts";
import type {
  ContextItem,
  ModelGateway,
  ModelHandle,
  StepEvent,
  StepRequest,
  ToolSpec,
} from "./neutral.ts";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.dirname(SRC_DIR);
const RESULTS_DIR = path.join(PKG_DIR, "results");
const FIXTURES_DIR = path.join(PKG_DIR, "fixtures", "recordings");

// ---------- env ----------

function loadSpikeEnv(): Record<string, string> {
  const p = path.join(os.homedir(), ".config", "excelmanus-next", "spike.env");
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const env = loadSpikeEnv();
const MIMO = {
  apiKey: env.MIMO_API_KEY ?? "",
  baseURL: env.MIMO_BASE_URL ?? "",
  model: env.MIMO_MODEL ?? "",
};

const unhandled: string[] = [];
process.on("unhandledRejection", (e) => unhandled.push(String(e)));

// ---------- 通用执行 ----------

interface CaseResult {
  id: string;
  provider: "mimo" | "mock";
  title: string;
  expect: string;
  pass: boolean;
  durationMs: number;
  firstDeltaMs: number | null;
  eventKinds: string[];
  underlyingCalls: number;
  details: Record<string, unknown>;
  notes?: string;
}

const recorder = new Recorder([MIMO.apiKey]);
const results: CaseResult[] = [];
const recordings: Record<string, RecordedExchange[]> = {};

async function collect(
  gw: ModelGateway,
  req: Omit<StepRequest, "model"> & { model: ModelHandle },
  onEvent?: (e: StepEvent) => void,
): Promise<{ events: StepEvent[]; firstDeltaMs: number | null; totalMs: number }> {
  const t0 = performance.now();
  let firstDeltaMs: number | null = null;
  const events: StepEvent[] = [];
  for await (const e of gw.step(req)) {
    if (firstDeltaMs == null && (e.kind === "text.delta" || e.kind === "reasoning.delta")) {
      firstDeltaMs = performance.now() - t0;
    }
    events.push(e);
    onEvent?.(e);
  }
  return { events, firstDeltaMs, totalMs: performance.now() - t0 };
}

function kinds(events: StepEvent[]): string[] {
  return events.map((e) => e.kind);
}

function lastError(events: StepEvent[]) {
  return events.filter((e) => e.kind === "error").at(-1);
}

function push(res: CaseResult): void {
  results.push(res);
  console.log(
    `${res.pass ? "PASS" : "FAIL"} ${res.id} ${res.title} (${res.durationMs.toFixed(0)}ms, calls=${res.underlyingCalls})`,
  );
}

function saveRecording(caseId: string, startIdx: number): void {
  recordings[caseId] = recorder.exchanges.slice(startIdx);
}

const wbTool: ToolSpec = {
  name: "workbook_read",
  description: "读取工作簿指定区域",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, range: { type: "string" } },
    required: ["path", "range"],
    additionalProperties: false,
  },
};

function validateAgainstSchema(args: unknown, schema: ToolSpec["inputSchema"]): boolean {
  if (typeof args !== "object" || args === null) return false;
  const req = (schema.required as string[] | undefined) ?? [];
  const props = (schema.properties as Record<string, { type?: string }>) ?? {};
  const o = args as Record<string, unknown>;
  for (const k of req) {
    if (!(k in o)) return false;
    const t = props[k]?.type;
    if (t === "string" && typeof o[k] !== "string") return false;
    if (t === "number" && typeof o[k] !== "number") return false;
  }
  return true;
}

// ---------- mimo cases ----------

function mimoGateway(): { gw: ModelGateway; model: ModelHandle } {
  const model = createMimoModel({
    baseURL: MIMO.baseURL,
    apiKey: MIMO.apiKey,
    modelId: MIMO.model,
    fetch: recorder.fetch,
  });
  return { gw: createGateway(model), model };
}

async function caseA01(): Promise<void> {
  const t0 = performance.now();
  const start = recorder.exchanges.length;
  const { gw, model } = mimoGateway();
  const r = await collect(gw, {
    model,
    system: "You are a helpful assistant. 用中文回答。",
    history: [{ kind: "user", text: "用一句话介绍你自己" }],
    signal: new AbortController().signal,
  });
  saveRecording("A01", start);
  const td = r.events.filter((e) => e.kind === "text.delta").length;
  const fin = r.events.find((e) => e.kind === "finish");
  const usg = r.events.find((e) => e.kind === "usage");
  const u = usg?.kind === "usage" ? usg.usage : undefined;
  const pass =
    td >= 2 &&
    fin?.kind === "finish" &&
    fin.reason === "stop" &&
    (u?.inputTokens ?? 0) > 0 &&
    (u?.outputTokens ?? 0) > 0;
  push({
    id: "A01",
    provider: "mimo",
    title: "流式纯文本",
    expect: "≥2 text.delta；finish=stop；usage>0；记录首字节与总耗时",
    pass,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: recorder.exchanges.length - start,
    details: { textDeltas: td, finish: fin, usage: u },
  });
  void t0;
}

async function caseA02(): Promise<void> {
  const start = recorder.exchanges.length;
  const { gw, model } = mimoGateway();
  const r = await collect(gw, {
    model,
    system: "You are a helpful assistant. 用中文回答。",
    history: [{ kind: "user", text: "9.11 和 9.9 哪个大？简要回答" }],
    signal: new AbortController().signal,
  });
  saveRecording("A02", start);
  const rd = r.events.filter((e) => e.kind === "reasoning.delta");
  const td = r.events.filter((e) => e.kind === "text.delta");
  const reasoningText = rd.map((e) => (e.kind === "reasoning.delta" ? e.text : "")).join("");
  const details: Record<string, unknown> = {
    reasoningDeltas: rd.length,
    textDeltas: td.length,
    reasoningPreview: reasoningText.slice(0, 200),
    textPreview: td
      .map((e) => (e.kind === "text.delta" ? e.text : ""))
      .join("")
      .slice(0, 200),
  };
  if (rd.length === 0) {
    await recorder.settle();
    // 判据要求：没有 reasoning.delta 时保存原始 SSE 片段说明是否被丢弃
    const sse = recordings.A02?.map((x) => x.responseBody).join("\n") ?? "";
    const idx = sse.indexOf("reasoning_content");
    details.sseExcerpt =
      idx >= 0 ? sse.slice(Math.max(0, idx - 200), idx + 400) : sse.slice(0, 800);
    details.sseContainsReasoningContent = idx >= 0;
  }
  push({
    id: "A02",
    provider: "mimo",
    title: "思考内容流式输出",
    expect: "≥1 reasoning.delta，与 text 分开；否则记录原始 SSE",
    pass: rd.length >= 1,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: recorder.exchanges.length - start,
    details,
  });
}

async function caseA03(): Promise<{
  toolCall: Extract<StepEvent, { kind: "tool.call" }> | undefined;
  reasoning: string;
}> {
  const start = recorder.exchanges.length;
  const { gw, model } = mimoGateway();
  const r = await collect(gw, {
    model,
    system: "You are a helpful assistant. 用中文回答。",
    history: [{ kind: "user", text: "读取 sales.xlsx 的 Sheet1!A1:C5" }],
    tools: [wbTool],
    signal: new AbortController().signal,
  });
  saveRecording("A03", start);
  const tc = r.events.find(
    (e): e is Extract<StepEvent, { kind: "tool.call" }> => e.kind === "tool.call",
  );
  const fin = r.events.find((e) => e.kind === "finish");
  const calls = recorder.exchanges.length - start;
  const argsOk = tc ? validateAgainstSchema(tc.args, wbTool.inputSchema) : false;
  const pass =
    tc != null &&
    tc.toolName === "workbook_read" &&
    argsOk &&
    fin?.kind === "finish" &&
    fin.reason === "tool-calls" &&
    calls === 1;
  push({
    id: "A03",
    provider: "mimo",
    title: "单步工具调用（无 execute）",
    expect: "tool.call(name=workbook_read, args 过 schema)；finish=tool-calls；底层恰好 1 次请求",
    pass,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: calls,
    details: { toolCall: tc, finish: fin, argsSchemaValid: argsOk },
  });
  const reasoning = r.events
    .filter((e) => e.kind === "reasoning.delta")
    .map((e) => (e.kind === "reasoning.delta" ? e.text : ""))
    .join("");
  return { toolCall: tc, reasoning };
}

async function caseA04(prev: {
  toolCall: Extract<StepEvent, { kind: "tool.call" }> | undefined;
  reasoning: string;
}): Promise<void> {
  const start = recorder.exchanges.length;
  const { gw, model } = mimoGateway();
  const fakeTable = {
    headers: ["product", "region", "amount"],
    rows: [
      ["Alpha", "华东", 1200],
      ["Beta", "华南", 890],
      ["Gamma", "华北", 1530],
    ],
  };
  const history: ContextItem[] = [
    { kind: "user", text: "读取 sales.xlsx 的 Sheet1!A1:C5" },
    {
      kind: "assistant",
      reasoning: prev.reasoning || undefined,
      toolCalls: prev.toolCall
        ? [{ id: prev.toolCall.toolCallId, name: prev.toolCall.toolName, args: prev.toolCall.args }]
        : [],
    },
    ...(prev.toolCall
      ? ([
          {
            kind: "toolResult",
            toolCallId: prev.toolCall.toolCallId,
            toolName: prev.toolCall.toolName,
            output: fakeTable,
          },
        ] satisfies ContextItem[])
      : []),
    { kind: "user", text: "根据刚才读到的表，哪个产品的 amount 最大？" },
  ];
  const r = await collect(gw, {
    model,
    system: "You are a helpful assistant. 用中文回答。",
    history,
    tools: [wbTool],
    signal: new AbortController().signal,
  });
  saveRecording("A04", start);
  // 检查第 2 步请求体
  const body = recordings.A04?.[0]?.requestBody ?? "";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  const msgs = (parsed.messages as Array<Record<string, unknown>>) ?? [];
  const assistantMsg = msgs.find((m) => m.role === "assistant");
  const toolMsg = msgs.find((m) => m.role === "tool");
  const assistantHasToolCalls =
    Array.isArray(assistantMsg?.tool_calls) && (assistantMsg.tool_calls as unknown[]).length > 0;
  const toolCallIdMatch =
    prev.toolCall != null &&
    JSON.stringify(toolMsg?.tool_call_id) === JSON.stringify(prev.toolCall.toolCallId);
  const reasoningSent =
    assistantMsg != null && ("reasoning_content" in assistantMsg || "reasoning" in assistantMsg);
  const answerText = r.events
    .filter((e) => e.kind === "text.delta")
    .map((e) => (e.kind === "text.delta" ? e.text : ""))
    .join("");
  const citesData = /Gamma|1530/.test(answerText);
  const pass = assistantHasToolCalls && toolCallIdMatch && citesData;
  push({
    id: "A04",
    provider: "mimo",
    title: "多轮+工具结果回传",
    expect: "第2步请求含 tool_calls/配对 tool_call_id；思考内容回传情况记录；回答引用表中数据",
    pass,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: recorder.exchanges.length - start,
    details: {
      assistantHasToolCalls,
      toolCallIdMatch,
      reasoningSentBack: reasoningSent,
      reasoningFieldName: assistantMsg
        ? Object.keys(assistantMsg).filter((k) => /reason/i.test(k))
        : [],
      answerPreview: answerText.slice(0, 300),
      citesData,
      step1ReasoningLen: prev.reasoning.length,
    },
  });
}

async function caseA05(): Promise<void> {
  const start = recorder.exchanges.length;
  const { gw, model } = mimoGateway();
  const ac = new AbortController();
  let scheduled = false;
  let abortedAt: number | null = null;
  let deltasAfterAbort = 0;
  const r = await collect(
    gw,
    {
      model,
      system: "You are a helpful assistant.",
      history: [{ kind: "user", text: "从 1 数到 300，每个数字一行" }],
      signal: ac.signal,
    },
    (e) => {
      if (abortedAt != null && (e.kind === "text.delta" || e.kind === "reasoning.delta")) {
        deltasAfterAbort += 1;
      }
      if (!scheduled && e.kind === "text.delta") {
        scheduled = true;
        setTimeout(() => {
          abortedAt = performance.now();
          ac.abort();
        }, 200);
      }
    },
  );
  const endAt = performance.now();
  const lastEv = r.events.at(-1);
  const msFromAbortToEnd = abortedAt != null ? endAt - abortedAt : null;
  const endWithin1sOfAbort = msFromAbortToEnd != null && msFromAbortToEnd <= 1000;
  const endedAs =
    lastEv?.kind === "error" ? `error(${lastEv.error.kind})` : `ended(${lastEv?.kind ?? "empty"})`;
  saveRecording("A05", start);
  // 随后再发一次普通 step 应成功
  const start2 = recorder.exchanges.length;
  const r2 = await collect(gw, {
    model,
    system: "You are a helpful assistant. 用中文回答。",
    history: [{ kind: "user", text: "说“好”。" }],
    signal: new AbortController().signal,
  });
  saveRecording("A05b", start2);
  const ok2 =
    r2.events.some((e) => e.kind === "text.delta") && r2.events.some((e) => e.kind === "finish");
  const pass = abortedAt != null && endWithin1sOfAbort && unhandled.length === 0 && ok2;
  push({
    id: "A05",
    provider: "mimo",
    title: "中断",
    expect:
      "首delta后200ms abort；迭代1s内结束（记录末事件形态）；无未处理拒绝；随后普通 step 成功",
    pass,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: recorder.exchanges.length - start,
    details: {
      aborted: abortedAt != null,
      endedAs,
      msFromAbortToEnd,
      endWithin1sOfAbort,
      deltasAfterAbort,
      unhandledRejections: unhandled.length,
      followupOk: ok2,
    },
  });
}

async function caseA06(): Promise<void> {
  const start = recorder.exchanges.length;
  const bad = createMimoModel({
    baseURL: MIMO.baseURL,
    apiKey: "sk-invalid-deadbeef-not-a-real-key",
    modelId: MIMO.model,
    fetch: recorder.fetch,
  });
  const gw = createGateway(bad);
  const r = await collect(gw, {
    model: bad,
    system: "You are a helpful assistant.",
    history: [{ kind: "user", text: "hi" }],
    signal: new AbortController().signal,
  });
  saveRecording("A06", start);
  const err = lastError(r.events);
  const msg = err?.kind === "error" ? `${err.error.message} ${err.error.detail ?? ""}` : "";
  const leaks = /sk-|Bearer\s+\S|authorization/i.test(msg);
  const pass =
    err?.kind === "error" && err.error.kind === "auth" && err.error.retryable === false && !leaks;
  push({
    id: "A06",
    provider: "mimo",
    title: "认证失败分类",
    expect: "error(auth, retryable=false)；错误信息不含请求头与密钥",
    pass,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: recorder.exchanges.length - start,
    details: { error: err, headerLeak: leaks },
  });
}

async function caseA07(): Promise<void> {
  const start = recorder.exchanges.length;
  const bad = createMimoModel({
    baseURL: MIMO.baseURL,
    apiKey: MIMO.apiKey,
    modelId: "nonexistent-model-xyz",
    fetch: recorder.fetch,
  });
  const gw = createGateway(bad);
  const r = await collect(gw, {
    model: bad,
    system: "You are a helpful assistant.",
    history: [{ kind: "user", text: "hi" }],
    signal: new AbortController().signal,
  });
  saveRecording("A07", start);
  const err = lastError(r.events);
  const status = err?.kind === "error" ? err.error.statusCode : undefined;
  const kind = err?.kind === "error" ? err.error.kind : undefined;
  const pass =
    err?.kind === "error" &&
    (kind === "model_not_found" || kind === "invalid_request") &&
    err.error.retryable === false;
  push({
    id: "A07",
    provider: "mimo",
    title: "模型不存在分类",
    expect: "error(model_not_found|invalid_request, 不可重试)；记录原始状态码与错误体摘要",
    pass,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: recorder.exchanges.length - start,
    details: {
      kind,
      statusCode: status,
      detail: err?.kind === "error" ? err.error.detail : undefined,
    },
  });
}

// ---------- mock cases ----------

async function mockCase(
  id: string,
  title: string,
  expect: string,
  model: { doStreamCalls: unknown[] } & object,
  check: (events: StepEvent[]) => { pass: boolean; details: Record<string, unknown> },
): Promise<void> {
  const gw = createGateway(asHandle(model as never));
  const r = await collect(gw, {
    model: asHandle(model as never),
    history: [{ kind: "user", text: "test" }],
    signal: new AbortController().signal,
  });
  const { pass, details } = check(r.events);
  push({
    id,
    provider: "mock",
    title,
    expect,
    pass,
    durationMs: r.totalMs,
    firstDeltaMs: r.firstDeltaMs,
    eventKinds: kinds(r.events),
    underlyingCalls: model.doStreamCalls.length,
    details,
  });
}

async function run(): Promise<void> {
  if (!MIMO.apiKey || !MIMO.baseURL || !MIMO.model) {
    console.error("缺少 MIMO_* 环境变量（~/.config/excelmanus-next/spike.env）");
    process.exit(2);
  }
  await caseA01();
  await caseA02();
  const a03 = await caseA03();
  await caseA04(a03);
  await caseA05();
  await caseA06();
  await caseA07();

  await mockCase(
    "M01",
    "429+Retry-After 分类",
    "rate_limit/retryable/retryAfterMs=2000",
    mockRateLimit(),
    (ev) => {
      const e = lastError(ev);
      const ok =
        e?.kind === "error" &&
        e.error.kind === "rate_limit" &&
        e.error.retryable &&
        e.error.retryAfterMs === 2000;
      return { pass: ok, details: { error: e } };
    },
  );
  await mockCase(
    "M02",
    "流中断",
    "3 个 text.delta 后 error(stream_interrupted, retryable)",
    mockStreamInterrupted(),
    (ev) => {
      const td = ev.filter((e) => e.kind === "text.delta").length;
      const e = lastError(ev);
      const ok =
        td === 3 &&
        e?.kind === "error" &&
        e.error.kind === "stream_interrupted" &&
        e.error.retryable;
      return { pass: ok, details: { textDeltas: td, error: e } };
    },
  );
  await mockCase("M03", "上下文超限分类", "context_overflow", mockContextOverflow(), (ev) => {
    const e = lastError(ev);
    const ok = e?.kind === "error" && e.error.kind === "context_overflow";
    return { pass: ok, details: { error: e } };
  });
  await mockCase("M04a", "5xx 分类", "server_error/retryable", mockServerError(), (ev) => {
    const e = lastError(ev);
    const ok = e?.kind === "error" && e.error.kind === "server_error" && e.error.retryable;
    return { pass: ok, details: { error: e } };
  });
  await mockCase("M04b", "网络错误分类", "network/retryable", mockNetworkError(), (ev) => {
    const e = lastError(ev);
    const ok = e?.kind === "error" && e.error.kind === "network" && e.error.retryable;
    return { pass: ok, details: { error: e } };
  });

  // M05：中立格式往返
  const echo = mockEcho();
  const gw = createGateway(asHandle(echo));
  const m05History: ContextItem[] = [
    { kind: "user", text: "看一下数据" },
    {
      kind: "assistant",
      reasoning: "需要先读表",
      reasoningProviderOptions: { mimo: { signature: "sig-xyz" } },
      text: "我先读一下。",
      toolCalls: [{ id: "call_1", name: "workbook_read", args: { path: "a.xlsx", range: "A1" } }],
    },
    {
      kind: "toolResult",
      toolCallId: "call_1",
      toolName: "workbook_read",
      output: { value: 42 },
    },
    { kind: "user", text: "结论？" },
  ];
  const r5 = await collect(gw, {
    model: asHandle(echo),
    history: m05History,
    tools: [wbTool],
    signal: new AbortController().signal,
  });
  const prompt = echo.doStreamCalls[0]?.prompt as Array<Record<string, unknown>> | undefined;
  const aMsg = prompt?.find((m) => m.role === "assistant");
  const tMsg = prompt?.find((m) => m.role === "tool");
  const aParts = (aMsg?.content as Array<Record<string, unknown>>) ?? [];
  const reasoningPart = aParts.find((p) => p.type === "reasoning");
  const toolCallPart = aParts.find((p) => p.type === "tool-call");
  const m05pass =
    prompt?.length === 4 &&
    prompt[0]?.role === "user" &&
    reasoningPart != null &&
    reasoningPart.text === "需要先读表" &&
    toolCallPart != null &&
    toolCallPart.toolCallId === "call_1" &&
    tMsg != null;
  push({
    id: "M05",
    provider: "mock",
    title: "中立格式往返",
    expect: "prompt 逐字段一致；思考 providerOptions/providerMetadata 原样在对应位置",
    pass: m05pass,
    durationMs: r5.totalMs,
    firstDeltaMs: r5.firstDeltaMs,
    eventKinds: kinds(r5.events),
    underlyingCalls: echo.doStreamCalls.length,
    details: { prompt, reasoningPart },
  });

  // ---------- 落盘 + 自检 ----------
  await recorder.settle();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, "cases.json"),
    JSON.stringify({ env: envSummary(), results }, null, 2),
  );
  for (const [id, ex] of Object.entries(recordings)) {
    fs.writeFileSync(path.join(FIXTURES_DIR, `${id}.json`), JSON.stringify(ex, null, 2));
  }
  const leaked = secretSelfCheck();
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} 通过；密钥自检：${leaked ? "发现泄漏!" : "干净"}`,
  );
  if (unhandled.length) console.log("unhandledRejection:", unhandled);
  process.exit(failed.length > 0 || leaked ? 1 : 0);
}

function envSummary(): Record<string, unknown> {
  return {
    node: process.version,
    platform: `${os.platform()}/${os.arch()}`,
    model: MIMO.model,
    baseURL: MIMO.baseURL ? new URL(MIMO.baseURL).host : "",
    aiSdk: {
      ai: "7.0.108",
      openaiCompatible: "3.0.53",
      provider: "4.0.17",
      providerUtils: "5.0.45",
    },
  };
}

/** 对 spike 全目录 grep 真实 Key 值；命中即失败。 */
function secretSelfCheck(): boolean {
  const key = MIMO.apiKey;
  if (!key || key.length < 8) return false;
  let leaked = false;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(ts|json|md|mjs)$/.test(e.name)) {
        if (fs.readFileSync(p, "utf8").includes(key)) {
          console.error(`密钥泄漏: ${p}`);
          leaked = true;
        }
      }
    }
  };
  walk(PKG_DIR);
  return leaked;
}

const wd = setTimeout(() => {
  console.error("watchdog: 240s");
  process.exit(3);
}, 240_000);
run().finally(() => clearTimeout(wd));
