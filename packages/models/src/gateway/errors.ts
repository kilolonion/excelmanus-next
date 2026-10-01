// 错误分类（04 §9 词表）。只做分类，不做重试。
// 敏感信息：message/detail 走 sanitizeErrorText，不携带密钥与请求头。

import type { ClassifiedError, ErrorKind } from "@excelmanus/protocol";
import { AISDKError, APICallError, StreamProviderError } from "ai";
import { redactSecrets } from "../secrets.ts";

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /too many tokens/i,
  /prompt is too long/i,
];

const CONTENT_FILTER_PATTERNS = [/content[_ ]?filter/i, /content_policy/i, /safety/i];

// 额度不足（04 §9：不重试）
const QUOTA_PATTERNS = [/insufficient[_ ]quota/i, /exceeded your current quota/i, /billing/i];

// 网络层错误（无 HTTP 状态）
const NETWORK_PATTERNS =
  /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|other side closed|terminated|Cannot connect/i;

// 流内错误块的类型 → 等效 HTTP 状态（Anthropic / OpenAI 兼容的常见取值）
const STREAM_ERROR_STATUS: [RegExp, number][] = [
  [/overloaded/i, 529],
  [/rate[_ ]?limit/i, 429],
  [/insufficient[_ ]quota/i, 429],
  [/authentication|unauthorized|invalid[_ ]api[_ ]key/i, 401],
  [/permission/i, 403],
  [/not[_ ]found/i, 404],
  [/request[_ ]too[_ ]large/i, 413],
  [/invalid[_ ]request/i, 400],
  [/api[_ ]error|server[_ ]error|internal/i, 500],
];

/** Retry-After 等待上限：超过的按上限等，避免一轮挂起数小时。 */
const MAX_RETRY_AFTER_MS = 60_000;

function scrubSecrets(text: string): string {
  return redactSecrets(text).slice(0, 500);
}

function bodyHints(text?: string): string {
  if (!text) return "";
  return scrubSecrets(text.slice(0, 400));
}

function causeText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    const code = (cur as { code?: unknown }).code;
    parts.push(`${cur.name} ${cur.message}${typeof code === "string" ? ` ${code}` : ""}`);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/** 无状态码或 2xx（响应已开始后读取失败）：按是否已流出内容归为流中断或网络错误。 */
function transportError(
  sawContent: boolean,
  msg: string,
  statusCode?: number,
  detail?: string,
): ClassifiedError {
  return {
    kind: sawContent ? "stream_interrupted" : "network",
    retryable: true,
    message: msg,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(detail ? { detail } : {}),
  };
}

function byStatus(
  status: number,
  ctx: {
    msg: string;
    rawMsg: string;
    body: string;
    detail: string;
    headers?: Record<string, string>;
    sdkRetryable: boolean;
    sawContent: boolean;
  },
): ClassifiedError {
  const { msg, rawMsg, body, detail } = ctx;
  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: false, message: msg, statusCode: status, detail };
  }
  if (status === 429) {
    if (QUOTA_PATTERNS.some((p) => p.test(body) || p.test(rawMsg))) {
      return {
        kind: "rate_limit",
        retryable: false,
        message: `额度不足：${msg}`,
        statusCode: status,
        detail,
      };
    }
    const wait = retryAfterMs(ctx.headers);
    return {
      kind: "rate_limit",
      retryable: true,
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      message: msg,
      statusCode: status,
      detail,
    };
  }
  if (status === 413) {
    return { kind: "context_overflow", retryable: true, message: msg, statusCode: status, detail };
  }
  if (status === 404) {
    return { kind: "model_not_found", retryable: false, message: msg, statusCode: status, detail };
  }
  if (status === 400) {
    if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(body) || p.test(rawMsg))) {
      return {
        kind: "context_overflow",
        retryable: true,
        message: msg,
        statusCode: status,
        detail,
      };
    }
    if (CONTENT_FILTER_PATTERNS.some((p) => p.test(body))) {
      return { kind: "content_filter", retryable: false, message: msg, statusCode: status, detail };
    }
    return { kind: "invalid_request", retryable: false, message: msg, statusCode: status, detail };
  }
  if (status >= 500) {
    const wait = retryAfterMs(ctx.headers);
    return {
      kind: "server_error",
      retryable: true,
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      message: msg,
      statusCode: status,
      detail,
    };
  }
  if (status < 300) return transportError(ctx.sawContent, msg, status, detail);
  // 408/409 等 SDK 判为可重试的状态：按网络错误重试
  if (ctx.sdkRetryable) return transportError(ctx.sawContent, msg, status, detail);
  return { kind: "invalid_request", retryable: false, message: msg, statusCode: status, detail };
}

export function classifyError(err: unknown, sawContent: boolean): ClassifiedError {
  if (err instanceof APICallError) {
    const status = err.statusCode;
    const body = typeof err.responseBody === "string" ? err.responseBody : "";
    const msg = scrubSecrets(err.message);
    const detail = bodyHints(body);
    if (/AbortError/.test(causeText(err.cause))) {
      return { kind: "aborted", retryable: false, message: msg };
    }
    if (status === undefined) {
      // fetch 失败被 SDK 包装成无状态码的 APICallError
      return transportError(sawContent, msg, undefined, bodyHints(causeText(err.cause)));
    }
    return byStatus(status, {
      msg,
      rawMsg: err.message,
      body,
      detail,
      headers: err.responseHeaders,
      sdkRetryable: err.isRetryable,
      sawContent,
    });
  }
  if (err instanceof StreamProviderError) {
    // 流内错误块（Anthropic overloaded_error / rate_limit_error、兼容接口 200 流内 error）
    const body = err.data === undefined ? "" : safeJson(err.data);
    const hint = `${err.type ?? ""} ${err.code ?? ""} ${err.message}`;
    const status =
      err.statusCode ?? STREAM_ERROR_STATUS.find(([re]) => re.test(hint) || re.test(body))?.[1];
    const msg = scrubSecrets(err.message);
    const detail = bodyHints(body || hint);
    if (status !== undefined) {
      return byStatus(status, {
        msg,
        rawMsg: hint,
        body,
        detail,
        sdkRetryable: err.isRetryable,
        sawContent,
      });
    }
    if (err.isRetryable) return transportError(sawContent, msg, undefined, detail);
    return { kind: "unknown", retryable: false, message: msg, detail };
  }
  if (err instanceof AISDKError) {
    const name = err.name;
    if (name === "AbortError" || /abort/i.test(err.message)) {
      return { kind: "aborted", retryable: false, message: scrubSecrets(err.message) };
    }
    if (name === "NoSuchModelError") {
      return { kind: "model_not_found", retryable: false, message: scrubSecrets(err.message) };
    }
    return { kind: "unknown", retryable: false, message: scrubSecrets(err.message), detail: name };
  }
  if (err instanceof Error && /abort/i.test(`${err.name} ${err.message}`)) {
    return { kind: "aborted", retryable: false, message: scrubSecrets(err.message) };
  }
  if (err instanceof Error && NETWORK_PATTERNS.test(causeText(err))) {
    return transportError(sawContent, scrubSecrets(err.message));
  }
  const kind: ErrorKind = sawContent ? "stream_interrupted" : "unknown";
  return {
    kind,
    retryable: sawContent,
    message: scrubSecrets(err instanceof Error ? err.message : String(err)),
  };
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Retry-After（秒或 HTTP 日期）与 retry-after-ms（OpenAI）；封顶 MAX_RETRY_AFTER_MS。导出供测试。 */
export function retryAfterMs(
  headers: Record<string, string> | undefined,
  now = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string) =>
    Object.entries(headers)
      .find(([k]) => k.toLowerCase() === name)?.[1]
      ?.trim();
  let ms: number | undefined;
  const msHeader = get("retry-after-ms");
  if (msHeader && Number.isFinite(Number(msHeader))) ms = Number(msHeader);
  const v = get("retry-after");
  if (ms === undefined && v) {
    if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
    else {
      const at = Date.parse(v);
      if (Number.isFinite(at)) ms = Math.max(0, at - now);
    }
  }
  if (ms === undefined || ms < 0) return undefined;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}
