// 流式滚动浏览器验收：真实 HTTP/WS/SQLite，只有模型输出是夹具。
// node packages/server/test/fixtures/chat-scroll-server.ts <dataDir> [port]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { startServer } from "../../src/index.ts";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: chat-scroll-server.ts <dataDir> [port]");
const usage: LanguageModelV4Usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 80, reasoning: 20 },
};
let turn = 0;
const server = await startServer({
  dataDir,
  port: Number(process.argv[3] ?? 0),
  webDist: resolve("packages/web/dist"),
  dev: true,
  log: () => {},
  resolveLanguageModel: () =>
    new MockLanguageModelV4({
      provider: "mock",
      modelId: "chat-scroll",
      doStream: async (options) => {
        const current = ++turn;
        const last = [...options.prompt].reverse().find((message) => message.role === "user");
        const slow = JSON.stringify(last?.content).includes("持续");
        const lastUserIndex = options.prompt.findLastIndex((message) => message.role === "user");
        if (
          JSON.stringify(last?.content).includes("历史工具") &&
          !options.prompt.slice(lastUserIndex).some((message) => message.role === "tool")
        ) {
          const input = JSON.stringify({ path: ".", contains: "验收检索字段".repeat(700) });
          return {
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "tool-input-start", id: `find-${current}`, toolName: "find" });
                controller.enqueue({ type: "tool-input-delta", id: `find-${current}`, delta: input });
                controller.enqueue({ type: "tool-call", toolCallId: `find-${current}`, toolName: "find", input });
                controller.enqueue({ type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } });
                controller.close();
              },
            }),
          };
        }
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            async start(controller) {
              const enqueue = (part: LanguageModelV4StreamPart) => controller.enqueue(part);
              enqueue({ type: "stream-start", warnings: [] });
              enqueue({ type: "reasoning-start", id: "r" });
              for (let i = 0; i < (slow ? 60 : 10); i++) {
                if (options.abortSignal?.aborted) break;
                enqueue({ type: "reasoning-delta", id: "r", delta: `思考 ${current}-${i}\n` });
                if (slow) await new Promise((done) => setTimeout(done, 80));
              }
              enqueue({ type: "reasoning-end", id: "r" });
              enqueue({ type: "text-start", id: "t" });
              for (let i = 0; i < (slow ? 400 : 12); i++) {
                if (options.abortSignal?.aborted) break;
                enqueue({
                  type: "text-delta",
                  id: "t",
                  delta: `第 ${current} 轮 · 段落 ${i}：用于检查历史阅读位置与流式跟随。\n\n`,
                });
                if (slow) await new Promise((done) => setTimeout(done, 120));
              }
              enqueue({ type: "text-end", id: "t" });
              enqueue({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } });
              controller.close();
            },
          }),
        };
      },
    }),
});
writeFileSync(resolve(dataDir, "workspace", "scroll.csv"), "A,B\n1,2\n");
const api = createApiClient(server.url, server.token);
await api.createModelProfile({
  name: "滚动验收模型",
  provider: "custom-openai-compatible",
  model: "chat-scroll",
  baseUrl: "https://mock.invalid/v1",
  apiKey: "scroll-fixture-only",
});
const { session } = await api.createSession({ title: "流式滚动验收" });
for (let i = 0; i < 8; i++) {
  await api.sendMessage(session.id, "main", {
    clientMessageId: `history-${i}`,
    text: i === 3 ? "历史工具" : `历史 ${i}`,
  });
  const deadline = Date.now() + 5000;
  while ((await api.getSessionLog(session.id)).items.filter((r) => r.type === "turn.completed").length <= i) {
    if (Date.now() > deadline) throw new Error("history seed timeout");
    await new Promise((done) => setTimeout(done, 20));
  }
}
process.stdout.write(`${JSON.stringify({ url: server.url, sessionId: session.id })}\n`);
