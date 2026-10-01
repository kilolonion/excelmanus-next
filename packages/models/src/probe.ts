// 能力探测（09 §6）：连通、工具调用、视觉、思考四项，单项超时 20 秒，不执行任何真实工具。
// 视觉用随机排列的色块图片（防止盲猜），工具调用要求回传随机标记。

import { randomBytes, randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { ContextItem, ResolvedModel, StepEvent, ToolSpec } from "@excelmanus/protocol";

export interface ProbeGateway {
  step(req: {
    model: ResolvedModel;
    system?: string;
    history: ContextItem[];
    tools?: ToolSpec[];
    providerOptions?: Record<string, unknown>;
    signal: AbortSignal;
  }): AsyncIterable<StepEvent>;
}

export interface ProbeItem {
  value: boolean | null;
  detail?: string;
}

export interface ProbeResult {
  connectivity: ProbeItem;
  tools: ProbeItem;
  vision: ProbeItem;
  reasoning: ProbeItem;
}

const COLORS: Record<string, [number, number, number]> = {
  红: [220, 30, 30],
  绿: [30, 170, 60],
  蓝: [30, 70, 220],
  黄: [240, 210, 30],
};

// ---------- 最小 PNG 编码（RGB，无依赖） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 横向排列的色块图（每块 64×64）。 */
export function colorStripPng(colors: [number, number, number][]): Buffer {
  const block = 64;
  const w = block * colors.length;
  const h = block;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const c = colors[Math.floor(x / block)] ?? [0, 0, 0];
      raw.set(c, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 探测 ----------

async function run(
  gateway: ProbeGateway,
  model: ResolvedModel,
  history: ContextItem[],
  opts: { tools?: ToolSpec[]; providerOptions?: Record<string, unknown>; timeoutMs: number },
): Promise<{
  text: string;
  reasoning: string;
  calls: { name: string; args: unknown }[];
  error?: string;
  /** 请求被接口明确拒绝（invalid_request，如"该模型不支持 tools"）：可作为"不支持"的证据。 */
  rejected?: boolean;
  /** 可重试的错误（限流、5xx、网络）：值得延后再试一次。 */
  transient?: boolean;
  retryAfterMs?: number;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  let text = "";
  let reasoning = "";
  const calls: { name: string; args: unknown }[] = [];
  let error: string | undefined;
  let rejected = false;
  let transient = false;
  let retryAfterMs: number | undefined;
  try {
    for await (const ev of gateway.step({
      model,
      history,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
      signal: ctrl.signal,
    })) {
      if (ev.kind === "text.delta") text += ev.text;
      else if (ev.kind === "reasoning.delta") reasoning += ev.text;
      else if (ev.kind === "tool.call") calls.push({ name: ev.toolName, args: ev.args });
      else if (ev.kind === "error") {
        if (ctrl.signal.aborted) {
          error = `超时（${Math.round(opts.timeoutMs / 1000)} 秒）`;
        } else {
          error = ev.error.message;
          rejected = ev.error.kind === "invalid_request";
          transient = ev.error.retryable;
          retryAfterMs = ev.error.retryAfterMs;
        }
      }
    }
  } catch (e) {
    error = ctrl.signal.aborted
      ? `超时（${Math.round(opts.timeoutMs / 1000)} 秒）`
      : e instanceof Error
        ? e.message
        : String(e);
  } finally {
    clearTimeout(timer);
  }
  return {
    text,
    reasoning,
    calls,
    ...(error !== undefined ? { error, rejected, transient } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** 限流/服务端暂时错误时延后重试一次（09 §6）；超时不重试（已等满单项时限）。 */
async function runOnceMore(
  gateway: ProbeGateway,
  model: ResolvedModel,
  history: ContextItem[],
  opts: { tools?: ToolSpec[]; providerOptions?: Record<string, unknown>; timeoutMs: number },
  retryDelayMs: number,
): ReturnType<typeof run> {
  const first = await run(gateway, model, history, opts);
  if (!first.error || !first.transient) return first;
  await new Promise((r) => setTimeout(r, Math.min(first.retryAfterMs ?? retryDelayMs, 10_000)));
  return run(gateway, model, history, opts);
}

/**
 * 探测请求出错时的结论（09 §1"未知就是未知"）：接口明确拒绝该请求才算"不支持"；
 * 限流、5xx、网络、超时等记为未知（value=null，保留原因），不覆盖目录证据。
 */
function failedItem(r: { error?: string; rejected?: boolean }): ProbeItem {
  return r.rejected
    ? { value: false, detail: r.error ?? "" }
    : { value: null, detail: `探测未完成：${r.error ?? ""}` };
}

/** 各提供商开启思考的 providerOptions（未知提供商按 openai 兼容处理）。 */
function reasoningOptions(adapter: string): Record<string, unknown> {
  switch (adapter) {
    case "anthropic":
      return { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } };
    case "google":
      return { google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } } };
    case "openai":
    case "chatgpt":
      return { openai: { reasoningEffort: "low", reasoningSummary: "auto" } };
    default:
      return {};
  }
}

export async function probeModel(
  gateway: ProbeGateway,
  model: ResolvedModel,
  adapter: string,
  timeoutMs = 20_000,
  retryDelayMs = 2_000,
): Promise<ProbeResult> {
  const conn = await runOnceMore(
    gateway,
    model,
    [{ kind: "user", text: "只回复 OK" }],
    { timeoutMs },
    retryDelayMs,
  );
  const connectivity: ProbeItem = conn.error
    ? { value: false, detail: conn.error }
    : { value: conn.text.trim().length > 0 || conn.reasoning.length > 0 };
  if (!connectivity.value) {
    const unknown = { value: null, detail: "连通失败，未探测" };
    return { connectivity, tools: unknown, vision: unknown, reasoning: unknown };
  }

  const marker = randomBytes(4).toString("hex");
  const toolRun = await runOnceMore(
    gateway,
    model,
    [
      {
        kind: "user",
        text: `请调用工具 echo_marker，参数 marker 设为 "${marker}"。不要回复其他内容。`,
      },
    ],
    {
      timeoutMs,
      tools: [
        {
          name: "echo_marker",
          description: "回传一个标记字符串",
          inputSchema: {
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
          },
        },
      ],
    },
    retryDelayMs,
  );
  const tools: ProbeItem = toolRun.error
    ? failedItem(toolRun)
    : {
        value: toolRun.calls.some(
          (c) => c.name === "echo_marker" && JSON.stringify(c.args ?? "").includes(marker),
        ),
      };

  const names = Object.keys(COLORS);
  const order = Array.from({ length: 4 }, () => names[randomInt(names.length)] as string);
  const png = colorStripPng(order.map((n) => COLORS[n] as [number, number, number]));
  // 图片放在 user 消息里发送：视觉判定不依赖工具调用能力（工具结果图片的发送方式由网关按适配器处理）
  const visionRun = await runOnceMore(
    gateway,
    model,
    [
      {
        kind: "user",
        text: `图片从左到右有 4 个色块，颜色只可能是 ${names.join("、")}。按顺序只用这四个字回答，用顿号分隔。`,
        images: [{ sha256: "probe", mediaType: "image/png", data: png.toString("base64") }],
      },
    ],
    { timeoutMs },
    retryDelayMs,
  );
  const answer = [...visionRun.text].filter((ch) => names.includes(ch));
  const vision: ProbeItem = visionRun.error
    ? failedItem(visionRun)
    : { value: answer.slice(0, 4).join("") === order.join(""), detail: `期望 ${order.join("、")}` };

  const reasonRun = await runOnceMore(
    gateway,
    model,
    [{ kind: "user", text: "17 × 23 等于多少？只给出数字。" }],
    {
      timeoutMs,
      providerOptions: reasoningOptions(adapter),
    },
    retryDelayMs,
  );
  const reasoning: ProbeItem = reasonRun.error
    ? { value: null, detail: `探测未完成：${reasonRun.error}` }
    : { value: reasonRun.reasoning.trim().length > 0 };

  return { connectivity, tools, vision, reasoning };
}
