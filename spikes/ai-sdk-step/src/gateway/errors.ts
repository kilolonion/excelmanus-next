// 错误分类（04 §9 词表）。只做分类，不做重试。
// 敏感信息：message/detail 走 sanitizeErrorText，不携带密钥与请求头。

import { AISDKError, APICallError } from "ai";
import type { ClassifiedError, ErrorKind } from "../neutral.ts";

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /too many tokens/i,
  /prompt is too long/i,
];

const CONTENT_FILTER_PATTERNS = [/content[_ ]?filter/i, /content_policy/i, /safety/i];

function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "<redacted>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .slice(0, 500);
}

function bodyHints(text?: string): string {
  if (!text) return "";
  return scrubSecrets(text.slice(0, 400));
}

export function classifyError(err: unknown, sawContent: boolean): ClassifiedError {
  if (err instanceof APICallError) {
    const status = err.statusCode;
    const body = typeof err.responseBody === "string" ? err.responseBody : "";
    const msg = scrubSecrets(err.message);
    const detail = bodyHints(body);
    if (status === 401 || status === 403) {
      return { kind: "auth", retryable: false, message: msg, statusCode: status, detail };
    }
    if (status === 429) {
      return {
        kind: "rate_limit",
        retryable: true,
        retryAfterMs: retryAfterMs(err.responseHeaders),
        message: msg,
        statusCode: status,
        detail,
      };
    }
    if (status === 404) {
      return {
        kind: "model_not_found",
        retryable: false,
        message: msg,
        statusCode: status,
        detail,
      };
    }
    if (status === 400) {
      if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(body) || p.test(err.message))) {
        return {
          kind: "context_overflow",
          retryable: true,
          message: msg,
          statusCode: status,
          detail,
        };
      }
      if (CONTENT_FILTER_PATTERNS.some((p) => p.test(body))) {
        return {
          kind: "content_filter",
          retryable: false,
          message: msg,
          statusCode: status,
          detail,
        };
      }
      return {
        kind: "invalid_request",
        retryable: false,
        message: msg,
        statusCode: status,
        detail,
      };
    }
    if (status != null && status >= 500) {
      return { kind: "server_error", retryable: true, message: msg, statusCode: status, detail };
    }
    return { kind: "invalid_request", retryable: false, message: msg, statusCode: status, detail };
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
  if (
    err instanceof TypeError &&
    /fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(err.message)
  ) {
    return { kind: "network", retryable: true, message: scrubSecrets(err.message) };
  }
  if (err instanceof Error && /abort/i.test(err.name + " " + err.message)) {
    return { kind: "aborted", retryable: false, message: scrubSecrets(err.message) };
  }
  const kind: ErrorKind = sawContent ? "stream_interrupted" : "unknown";
  return {
    kind,
    retryable: sawContent,
    message: scrubSecrets(err instanceof Error ? err.message : String(err)),
  };
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const v = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!v) return undefined;
  const s = Number(v);
  return Number.isFinite(s) ? Math.round(s * 1000) : undefined;
}
