// 输入框验收：真实后端与模型网关，假模型只替代提供商输出。
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { startServer } from "../../src/index.ts";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: composer-settings-server.ts <dataDir>");
const server = await startServer({
  dataDir,
  port: 0,
  dev: true,
  webDist: resolve("packages/web/dist"),
  log: () => {},
  resolveLanguageModel: (model) => new MockLanguageModelV4({
    provider: "mock",
    modelId: "composer-settings",
    doStream: async (options) => {
      if (model.reasoning === "max") {
        assert.equal(options.reasoning, undefined);
        const key = model.provider.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        assert.equal(options.providerOptions?.[key]?.reasoningEffort, "max");
      } else {
        assert.equal(options.reasoning, model.reasoning === "provider-default" ? undefined : model.reasoning);
      }
      const user = options.prompt.filter((p) => p.role === "user").at(-1);
      const images = user?.role === "user" ? user.content.filter((p) => p.type === "file").length : 0;
      const content = user?.role === "user" ? user.content.flatMap((p) => p.type === "text" ? [p.text] : []).join("\n") : "";
      const references = content.split("\n").filter((line) => line.startsWith("@")).length;
      const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: `模型等级：${model.reasoning ?? "provider-default"}；收到图片：${images}；文件引用：${references}` },
        { type: "text-end", id: "t" },
        { type: "finish", usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        }, finishReason: { unified: "stop", raw: "stop" } },
      ];
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      } }) };
    },
  }),
});
const api = createApiClient(server.url, server.token);
const profile = await api.createModelProfile({ name: "输入框验收模型", provider: "custom-openai-compatible", model: "composer-settings", baseUrl: "https://mock.invalid/v1", apiKey: "fixture-only", reasoning: "low" });
await api.overrideCapabilities(profile.profile.id, { vision: true, tools: true, reasoning: true });
await api.createModelProfile({ name: "备用验收模型", provider: "custom-openai-compatible", model: "composer-secondary", baseUrl: "https://mock.invalid/v1", apiKey: "fixture-only", reasoning: "minimal" });
const { items } = await api.listWorkspaces();
const workspace = items.find((w) => w.isDefault);
if (!workspace) throw new Error("default workspace missing");
writeFileSync(resolve(workspace.path, "existing.txt"), "original fixture bytes");
const { session } = await api.createSession({ title: "输入框验收" });
await api.createSession({ title: "隔离会话" });
process.stdout.write(`${JSON.stringify({ url: server.url, sessionId: session.id })}\n`);
