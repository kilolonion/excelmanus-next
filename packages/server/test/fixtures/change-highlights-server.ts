// 改动高亮验收：真实 HTTP/WS/SQLite/工作簿工具，只有模型服务输出由夹具替代。
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { startServer } from "../../src/index.ts";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: change-highlights-server.ts <dataDir>");
const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
let calls = 0;
const server = await startServer({
  dataDir,
  port: 0,
  webDist: resolve("packages/web/dist"),
  dev: true,
  log: () => {},
  resolveLanguageModel: () => new MockLanguageModelV4({
    provider: "mock",
    modelId: "change-highlights",
    doStream: async (options) => {
      const lastUser = options.prompt.map((p) => p.role).lastIndexOf("user");
      const step = options.prompt.slice(lastUser).filter((p) => p.role === "tool").length;
      const multi = JSON.stringify(options.prompt[lastUser]?.content).includes("连续");
      const writing = step < (multi ? 3 : 1);
      if (writing) await new Promise((done) => setTimeout(done, 800));
      const range = multi && step === 0 ? "销售!D2:D4" : "销售!D3:E5";
      const parts: LanguageModelV4StreamPart[] = writing ? [{
        type: "tool-call",
        toolCallId: `write-${++calls}`,
        toolName: "workbook_edit",
        input: JSON.stringify({ path: "sales.xlsx", ops: [{
          op: "cells.set", range,
          values: range.endsWith("D4") ? [[calls], [calls], [calls]] : [[calls, calls], [calls, calls], [calls, calls]],
        }] }),
      }] : [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "已提交修改，可在下方变更导航查看。" },
        { type: "text-end", id: "t" },
      ];
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) c.enqueue(part);
        c.enqueue({ type: "finish", usage, finishReason: writing ? { unified: "tool-calls", raw: "tool_calls" } : { unified: "stop", raw: "stop" } });
        c.close();
      } }) };
    },
  }),
});
const api = createApiClient(server.url, server.token);
const { items } = await api.listWorkspaces();
const workspace = items.find((w) => w.isDefault);
if (!workspace) throw new Error("default workspace missing");
copyFileSync(resolve("samples/sales.xlsx"), resolve(workspace.path, "sales.xlsx"));
await api.createModelProfile({ name: "高亮验收模型", provider: "custom-openai-compatible", model: "change-highlights", baseUrl: "https://mock.invalid/v1", apiKey: "fixture-only" });
const { session } = await api.createSession({ title: "改动高亮验收", permissionMode: "standard" });
process.stdout.write(`${JSON.stringify({ url: server.url, sessionId: session.id })}\n`);
