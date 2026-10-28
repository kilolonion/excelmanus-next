// 模型网关易错处回归（P0-12 脱敏、P1-41 分类、P1-42/43 转换、P1-44 探测）。
// 网关走真实 AI SDK 适配器，fetch 换成本地假响应（只替代模型服务输出）。
import type { ContextItem, ResolvedModel } from "@excelmanus/protocol";
import { StreamProviderError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, test } from "vitest";
import {
  classifyError,
  clearRegisteredSecrets,
  createGateway,
  probeModel,
  redactKnownSecrets,
  redactSecrets,
  registerModelSecrets,
  retryAfterMs,
} from "../src/index.ts";

afterEach(() => clearRegisteredSecrets());

function sse(events: string[]): Response {
  return new Response(events.map((e) => `${e}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** 记录请求体并返回固定回答的 fetch。 */
function capture(reply: () => Response) {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return reply();
  }) as typeof fetch;
  return { bodies, fetch: f };
}

const okChat = () =>
  sse([
    `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ]);

async function drain(it: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function model(over: Partial<ResolvedModel>): ResolvedModel {
  return {
    profileId: "p",
    provider: "qwen",
    model: "m",
    baseUrl: "http://fake.invalid/v1",
    apiKey: "sk-test-abcdefgh",
    ...over,
  };
}

describe("最高思考等级", () => {
  test.each([
    { provider: "openai", modelId: "gpt-6", key: "openai" },
    { provider: "anthropic", modelId: "claude-opus-5", key: "anthropic" },
    { provider: "custom-openai-compatible", modelId: "m", key: "custom-openai-compatible" },
  ])("$provider：真实 SDK 请求以 max 覆盖已有低等级", async ({ provider, modelId, key }) => {
    const cap = capture(
      () =>
        new Response(
          JSON.stringify({
            error: { type: "invalid_request_error", message: "fixture rejection" },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const events = await drain(
      createGateway().step({
        model: model({ provider, model: modelId, reasoning: "max", fetch: cap.fetch }),
        history: [{ kind: "user", text: "hi" }],
        providerOptions: {
          ...(provider === "custom-openai-compatible"
            ? { customOpenaiCompatible: { reasoningEffort: "low" } }
            : {}),
          [key]:
            provider === "anthropic"
              ? { effort: "low", thinking: { type: "disabled" } }
              : { reasoningEffort: "low" },
        },
        signal: new AbortController().signal,
      }),
    );
    expect(cap.bodies).toHaveLength(1);
    const body = cap.bodies[0];
    if (provider === "anthropic") {
      expect(body?.output_config).toMatchObject({ effort: "max" });
      expect(body?.thinking).toMatchObject({ type: "adaptive" });
    } else if (provider === "openai") {
      expect(body?.reasoning).toMatchObject({ effort: "max" });
    } else {
      expect(body?.reasoning_effort).toBe("max");
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({ kind: "invalid_request" }),
      }),
    );
  });

  test("不支持的适配器显式拒绝，不调用模型或降级", async () => {
    let requested = false;
    const events = await drain(
      createGateway({
        resolveLanguageModel: () => {
          requested = true;
          throw new Error("unexpected request");
        },
      }).step({
        model: model({ provider: "google", reasoning: "max" }),
        history: [{ kind: "user", text: "hi" }],
        signal: new AbortController().signal,
      }),
    );
    expect(requested).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({ kind: "invalid_request", retryable: false }),
      }),
    );
  });
});

describe("脱敏", () => {
  test("已登记凭据精确替换；常见密钥格式正则兜底", () => {
    registerModelSecrets({
      apiKey: "plainkey-without-prefix-123",
      extraHeaders: { authorization: "Token abcdefghij123" },
    });
    expect(redactKnownSecrets("got plainkey-without-prefix-123 and abcdefghij123")).toBe(
      "got <redacted> and <redacted>",
    );
    // 短值不登记（避免误伤正文）
    registerModelSecrets({ apiKey: "none" });
    expect(redactKnownSecrets("none of this")).toBe("none of this");
    const s = redactSecrets(
      'AIzaSyFAKEKEY1234567890abcdefXYZ9 sk-proj-ABCDEFGH1234 Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl "api_key": "zzzzzzzzzzzz" xai-AAAAAAAAAAAAAAAAAAAA',
    );
    expect(s).not.toMatch(/AIza|sk-proj|eyJ|zzzz|xai-A/);
  });

  test("classifyError 的 message/detail 按精确值脱敏", () => {
    registerModelSecrets({ apiKey: "custom-key-0123456789" });
    const r = classifyError(new Error("Incorrect API key provided: custom-key-0123456789"), false);
    expect(r.message).not.toContain("custom-key-0123456789");
  });
});

describe("错误分类（04 §9）", () => {
  test("连接被拒 → network 可重试", async () => {
    const gw = createGateway();
    const evs = await drain(
      gw.step({
        model: model({ baseUrl: "http://127.0.0.1:9/v1" }),
        history: [{ kind: "user", text: "hi" }],
        signal: new AbortController().signal,
      }),
    );
    const err = evs.find((e) => (e as { kind: string }).kind === "error") as {
      error: { kind: string; retryable: boolean };
    };
    expect(err.error).toMatchObject({ kind: "network", retryable: true });
  });

  test("流内错误块：overloaded → server_error 可重试；rate_limit → rate_limit；quota → 不重试", () => {
    const over = new StreamProviderError({ message: "Overloaded", type: "overloaded_error" });
    expect(classifyError(over, true)).toMatchObject({ kind: "server_error", retryable: true });
    const rl = new StreamProviderError({ message: "slow down", type: "rate_limit_error" });
    expect(classifyError(rl, false)).toMatchObject({ kind: "rate_limit", retryable: true });
    const quota = new StreamProviderError({
      message: "You exceeded your current quota",
      code: "insufficient_quota",
    });
    expect(classifyError(quota, false)).toMatchObject({ kind: "rate_limit", retryable: false });
  });

  test("Retry-After：秒、HTTP 日期、retry-after-ms；封顶 60 秒", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(retryAfterMs({ "retry-after": "3" }, now)).toBe(3000);
    expect(retryAfterMs({ "Retry-After": "Thu, 01 Oct 2026 00:00:05 GMT" }, now)).toBe(5000);
    expect(retryAfterMs({ "retry-after-ms": "1500", "retry-after": "9" }, now)).toBe(1500);
    expect(retryAfterMs({ "retry-after": "3600" }, now)).toBe(60_000);
    expect(retryAfterMs({ "retry-after": "garbage" }, now)).toBeUndefined();
  });
});

describe("消息转换", () => {
  const png = Buffer.from("fakepng").toString("base64");
  const history: ContextItem[] = [
    { kind: "user", text: "截图" },
    { kind: "assistant", toolCalls: [{ id: "t1", name: "workbook_render", args: {} }] },
    {
      kind: "toolResult",
      toolCallId: "t1",
      toolName: "workbook_render",
      output: { status: "ok", images: [{ mediaType: "image/png", data: png }] },
    },
    { kind: "assistant" },
    { kind: "user", text: "说说看" },
  ];

  test("unknown vision does not transmit tool image bytes and gives a configuration hint", async () => {
    const cap = capture(okChat);
    await drain(
      createGateway().step({
        model: model({ fetch: cap.fetch }),
        history,
        signal: new AbortController().signal,
      }),
    );
    expect(JSON.stringify(cap.bodies)).not.toContain(png);
    expect(JSON.stringify(cap.bodies)).toContain("视觉能力尚未确认");
  });

  test.each([undefined, false, true])(
    "error receipt never sends image as JSON or pixels (vision=%s)",
    async (vision) => {
      const cap = capture(okChat);
      const error: ContextItem = {
        kind: "toolResult",
        toolCallId: "t1",
        toolName: "workbook_render",
        isError: true,
        output: {
          status: "error",
          data: { ordinaryText: "keep this" },
          error: { code: "TIMEOUT", message: "failed", retryable: true },
          images: [{ mediaType: "image/png", data: png }],
        },
      };
      await drain(
        createGateway().step({
          model: model({ fetch: cap.fetch, vision }),
          history: [history[0]!, history[1]!, error],
          signal: new AbortController().signal,
        }),
      );
      expect(JSON.stringify(cap.bodies)).not.toContain(png);
      expect(JSON.stringify(cap.bodies)).toContain("keep this");
      expect(JSON.stringify(cap.bodies)).toContain("TIMEOUT");
    },
  );

  test.each(["custom-openai-compatible", "anthropic", "openai"])(
    "%s serializes real PNG bytes as a multimodal block, never tool JSON",
    async (provider) => {
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      const cap = capture(
        () =>
          new Response(JSON.stringify({ error: { message: "fixture stop" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      );
      await drain(
        createGateway().step({
          model: model({ provider, vision: true, fetch: cap.fetch }),
          history: [
            history[0]!,
            history[1]!,
            {
              ...history[2]!,
              output: {
                status: "ok",
                images: [{ mediaType: "image/png", data: bytes.toString("base64") }],
              },
            } as ContextItem,
          ],
          signal: new AbortController().signal,
        }),
      );
      const body = cap.bodies[0]!;
      const serialized = JSON.stringify(body);
      expect(serialized).toContain(
        provider === "anthropic"
          ? '"type":"image"'
          : provider === "openai"
            ? '"type":"input_image"'
            : '"type":"image_url"',
      );
      const candidates: string[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (!value || typeof value !== "object") return;
        const obj = value as Record<string, unknown>;
        if (obj.type === "image" && obj.source && typeof obj.source === "object")
          candidates.push(String((obj.source as Record<string, unknown>).data));
        if (obj.type === "image_url")
          candidates.push(String((obj.image_url as { url: string }).url).split(",")[1]!);
        if (obj.type === "input_image") candidates.push(String(obj.image_url).split(",")[1]!);
        Object.values(obj).forEach(visit);
      };
      visit(body);
      expect(candidates).toHaveLength(1);
      expect(Buffer.from(candidates[0]!, "base64")).toEqual(bytes);
    },
  );

  test("openai-compatible：tool 消息不含 base64，图片放在随后的 user 消息；空 assistant 被跳过", async () => {
    const cap = capture(okChat);
    await drain(
      createGateway().step({
        model: model({ fetch: cap.fetch, vision: true }),
        history,
        signal: new AbortController().signal,
      }),
    );
    const msgs = cap.bodies[0]?.messages as { role: string; content: unknown }[];
    const tool = msgs.find((m) => m.role === "tool");
    expect(String(tool?.content)).not.toContain(png);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const last = JSON.stringify(msgs[3]?.content);
    expect(last).toContain("image_url");
    expect(last).toContain("说说看");
  });

  test("anthropic：不发送空 assistant 消息", async () => {
    const cap = capture(() =>
      sse([
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } })}`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      ]),
    );
    await drain(
      createGateway().step({
        model: model({
          provider: "anthropic",
          baseUrl: "http://fake.invalid/v1",
          fetch: cap.fetch,
        }),
        history: [{ kind: "user", text: "a" }, { kind: "assistant" }, { kind: "user", text: "b" }],
        signal: new AbortController().signal,
      }),
    );
    const msgs = cap.bodies[0]?.messages as { role: string; content: unknown[] }[];
    expect(msgs.every((m) => m.content.length > 0)).toBe(true);
    expect(msgs.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("能力探测（09 §1）", () => {
  test("an explicit synthetic vision probe opts in only its image request", async () => {
    const flags: (boolean | undefined)[] = [];
    const gw = {
      async *step(req: { model: ResolvedModel; history: ContextItem[] }) {
        if (req.history.some((item) => item.kind === "user" && item.images?.length))
          flags.push(req.model.vision);
        yield { kind: "text.delta" as const, text: "OK" };
      },
    };
    await probeModel(gw, model({}), "openai-compatible", 1000, 1);
    expect(flags).toEqual([true]);
  });
  test("工具/视觉探测遇到限流记为未知（null），不是不支持", async () => {
    let n = 0;
    const gw = {
      async *step() {
        n += 1;
        if (n === 1) {
          yield { kind: "text.delta" as const, text: "OK" };
          return;
        }
        yield {
          kind: "error" as const,
          error: { kind: "rate_limit" as const, retryable: true, message: "429", retryAfterMs: 1 },
        };
      },
    };
    const r = await probeModel(gw, model({}), "openai-compatible", 1000, 1);
    expect(r.connectivity.value).toBe(true);
    expect(r.tools.value).toBeNull();
    expect(r.vision.value).toBeNull();
    expect(r.tools.detail).toContain("429");
    // 连通 1 次 + 工具/视觉/思考各 2 次（延后重试一次）
    expect(n).toBe(7);
  });

  test("请求被接口明确拒绝（invalid_request）仍记为不支持", async () => {
    let n = 0;
    const gw = {
      async *step() {
        n += 1;
        if (n === 1) {
          yield { kind: "text.delta" as const, text: "OK" };
          return;
        }
        yield {
          kind: "error" as const,
          error: {
            kind: "invalid_request" as const,
            retryable: false,
            message: "does not support tools",
          },
        };
      },
    };
    const r = await probeModel(gw, model({}), "openai-compatible", 1000, 1);
    expect(r.tools.value).toBe(false);
  });
});

test("取消不合作且尚未返回流的模型，不等待提供商放行", async () => {
  const ctrl = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gateway = createGateway({
    resolveLanguageModel: () =>
      new MockLanguageModelV4({
        doStream: async () => {
          started();
          return new Promise<never>(() => {});
        },
      }),
  });
  const pending = drain(
    gateway.step({
      model: model({}),
      history: [{ kind: "user", text: "hi" }],
      signal: ctrl.signal,
    }),
  );
  await entered;
  ctrl.abort();
  expect(await pending).toContainEqual(
    expect.objectContaining({ kind: "error", error: expect.objectContaining({ kind: "aborted" }) }),
  );
}, 3000);

test("模型无输出超时会结束等待，不留下无限调用", async () => {
  let transportSignal: AbortSignal | undefined;
  const gateway = createGateway({
    idleTimeoutMs: 30,
    resolveLanguageModel: () =>
      new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => {
          transportSignal = abortSignal;
          return new Promise<never>(() => {});
        },
      }),
  });
  const events = await drain(
    gateway.step({
      model: model({}),
      history: [{ kind: "user", text: "hi" }],
      signal: new AbortController().signal,
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "error",
      error: expect.objectContaining({
        kind: "network",
        retryable: false,
        message: expect.stringContaining("未返回"),
      }),
    }),
  );
  expect(transportSignal?.aborted).toBe(true);
}, 1000);

test("连续有输出时重置空闲计时，不按总耗时打断", async () => {
  const gateway = createGateway({
    idleTimeoutMs: 100,
    resolveLanguageModel: () =>
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "text-start", id: "t" });
              for (let i = 0; i < 5; i++) {
                await new Promise((resolve) => setTimeout(resolve, 30));
                controller.enqueue({ type: "text-delta", id: "t", delta: "x" });
              }
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        }),
      }),
  });
  const events = await drain(
    gateway.step({
      model: model({}),
      history: [{ kind: "user", text: "hi" }],
      signal: new AbortController().signal,
    }),
  );
  expect(events.filter((e) => (e as { kind: string }).kind === "text.delta")).toHaveLength(5);
  expect(events).not.toContainEqual(expect.objectContaining({ kind: "error" }));
});

test("configured maximum output reaches the actual compatible SDK request", async () => {
  const cap = capture(okChat);
  await drain(
    createGateway().step({
      model: model({
        provider: "custom-openai-compatible",
        maxOutputTokens: 2048,
        fetch: cap.fetch,
      }),
      history: [{ kind: "user", text: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );
  expect(cap.bodies[0]?.max_tokens).toBe(2048);
});

test("tool image bytes are bounded before provider serialization and malformed image fields never become text", async () => {
  const { toModelMessages } = await import("../src/gateway/convert.ts");
  const item = (data: unknown): ContextItem => ({
    kind: "toolResult",
    toolCallId: "r",
    toolName: "workbook_render",
    output: { status: "ok", images: [{ mediaType: "image/png", data }] },
  });
  expect(() => toModelMessages([item("A".repeat(12 * 1024 * 1024))], { vision: true })).toThrow(
    /8MiB/,
  );
  expect(() =>
    toModelMessages(
      [
        item("A".repeat(8 * 1024 * 1024)),
        item("A".repeat(8 * 1024 * 1024)),
        item("A".repeat(8 * 1024 * 1024)),
      ],
      { vision: true },
    ),
  ).toThrow(/16MiB/);
  expect(() => toModelMessages([item({ secret: "not-an-image" })], { vision: true })).toThrow(
    /图片字段/,
  );
  expect(
    JSON.stringify(toModelMessages([item("A".repeat(12 * 1024 * 1024))], { vision: false })),
  ).not.toContain("AAAA");
});
