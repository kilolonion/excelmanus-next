import { createTestProfile } from "./create-model.ts";
// 真实后端/HTTP/WS/SQLite；只把模型服务换成可中止的长响应。
import { resolve } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { startServer } from "../../src/index.ts";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("dataDir required");
const server = await startServer({
  dataDir, port: 0, dev: true, webDist: resolve("packages/web/dist"), log: () => {},
  resolveLanguageModel: () => new MockLanguageModelV4({
    provider: "mock", modelId: "composer-pending",
    doStream: async (options) => {
      const user = options.prompt.filter((p) => p.role === "user").at(-1);
      const content = user?.role === "user" ? user.content.flatMap((p) => p.type === "text" ? [p.text] : []).join("\n") : "";
      const text = content.trim().split(/\n+/).at(-1) ?? "";
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: text.includes("长任务") ? "正在处理长任务…" : `收到：${text}` });
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({ type: "finish", usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          }, finishReason: { unified: "stop", raw: "stop" } });
          controller.close();
        };
        const timer = setTimeout(finish, text.includes("长任务") ? 60000 : 10);
        options.abortSignal?.addEventListener("abort", finish, { once: true });
      } }) };
    },
  }),
});
const api = createApiClient(server.url, server.token);
for (const [name, reasoning] of [["GPT-6.1 Sol", "high"], ["GPT-6 Astra", "low"], ["GPT-6 Sol", "medium"]] as const) {
  const { profile } = await createTestProfile(api, { name, reasoning, provider: "custom-openai-compatible", model: "composer-pending", baseUrl: "https://mock.invalid/v1", apiKey: "fixture-only" });
  await api.overrideCapabilities(profile.id, { vision: true, tools: true, reasoning: true });
}
await api.createSession({ title: "气泡验收" });
process.stdout.write(`${JSON.stringify({ url: server.url })}\n`);
