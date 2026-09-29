// Mock 模型构造——criteria 允许 fixtures 文件 import ai/test。
// 每个 mock 只替代模型输出（doStream/doGenerate），不替代我们自己的代码。

import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelHandle } from "../neutral.ts";

const usage: LanguageModelV4Usage = {
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

const okFinish: LanguageModelV4StreamPart = {
  type: "finish",
  usage,
  finishReason: { unified: "stop", raw: "stop" },
};

function errStream(parts: LanguageModelV4StreamPart[], err: unknown) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.enqueue({ type: "error", error: err });
      c.close();
    },
  });
}

export function mockHello(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({
      stream: streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "你好" },
        { type: "text-delta", id: "t1", delta: "，世界" },
        { type: "text-end", id: "t1" },
        okFinish,
      ]),
    }),
  });
}

/** M01：429 + Retry-After: 2 */
export function mockRateLimit(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => {
      throw new APICallError({
        message: "Too Many Requests",
        url: "https://mock.invalid/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after": "2" },
        responseBody: '{"error":{"message":"rate limited"}}',
        isRetryable: true,
      });
    },
  });
}

/** M02：3 个 text-delta 后流以 error 部分结束 */
export function mockStreamInterrupted(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({
      stream: errStream(
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "a" },
          { type: "text-delta", id: "t1", delta: "b" },
          { type: "text-delta", id: "t1", delta: "c" },
        ],
        new Error("socket hangup"),
      ),
    }),
  });
}

/** M03：400 + context_length_exceeded */
export function mockContextOverflow(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => {
      throw new APICallError({
        message: "context_length_exceeded: maximum context length is 8192",
        url: "https://mock.invalid/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: {},
        responseBody:
          '{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
        isRetryable: false,
      });
    },
  });
}

/** M04a：500 */
export function mockServerError(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => {
      throw new APICallError({
        message: "Internal Server Error",
        url: "https://mock.invalid/chat/completions",
        requestBodyValues: {},
        statusCode: 500,
        responseHeaders: {},
        responseBody: '{"error":"boom"}',
        isRetryable: true,
      });
    },
  });
}

/** M04b：TypeError fetch failed（网络层） */
export function mockNetworkError(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => {
      throw new TypeError("fetch failed");
    },
  });
}

/** M05：回显——正常结束，调用方检查 doStreamCalls[0].prompt */
export function mockEcho(): MockLanguageModelV4 {
  return mockHello();
}

export function asHandle(m: MockLanguageModelV4): ModelHandle {
  return m as unknown as ModelHandle;
}
