import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function stream(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

const model = new MockLanguageModelV4({
  provider: "mock",
  modelId: "mock-agents",
  doStream: async (opts) => {
    const prompt = opts.prompt as Array<{ role: string; content: unknown }>;
    const system = prompt.find((m) => m.role === "system");
    const child = typeof system?.content === "string" && system.content.includes("子代理");
    const hasToolResult = prompt.some((m) => m.role === "tool");
    if (!hasToolResult && !child) {
      return {
        stream: stream([
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "spawn-1", toolName: "agent_spawn" },
          {
            type: "tool-input-delta",
            id: "spawn-1",
            delta: '{"name":"核对员","role":"reader","task":"检查表头"}',
          },
          {
            type: "tool-call",
            toolCallId: "spawn-1",
            toolName: "agent_spawn",
            input: '{"name":"核对员","role":"reader","task":"检查表头"}',
          },
          { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
        ]),
      };
    }
    if (!hasToolResult && child) {
      return {
        stream: stream([
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "send-1", toolName: "agent_send" },
          {
            type: "tool-input-delta",
            id: "send-1",
            delta: '{"to":"parent","message":"表头已核对"}',
          },
          {
            type: "tool-call",
            toolCallId: "send-1",
            toolName: "agent_send",
            input: '{"to":"parent","message":"表头已核对"}',
          },
          { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
        ]),
      };
    }
    return {
      stream: stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "完成" },
        { type: "text-end", id: "answer" },
        { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
      ]),
    };
  },
});

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("M3 多代理真实服务纵切", () => {
  test("main 派生 reader，子代理向 parent 投递 inbox", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-agents-e2e-"));
    dirs.push(dataDir);
    const server = await startServer({ dataDir, resolveLanguageModel: () => model, log: () => {} });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    await api.createModelProfile({
      name: "agents",
      provider: "custom-openai-compatible",
      model: "mock-agents",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "spawn", text: "拆分任务" });
    let logs = await api.getSessionLog(session.id);
    for (let i = 0; i < 500 && !logs.items.some((r) => r.type === "inbox.sent"); i += 1) {
      await sleep(10);
      logs = await api.getSessionLog(session.id);
    }
    expect(logs.items.some((r) => r.type === "agent.spawned" && r.agentId !== "main")).toBe(true);
    expect(logs.items.some((r) => r.type === "inbox.sent")).toBe(true);
    const detail = await api.getSession(session.id);
    const child = detail.agents.find((agent) => agent.id !== "main");
    expect(child).toMatchObject({ parentId: "main", role: "reader" });
    expect(logs.items.some((r) => r.type === "inbox.delivered")).toBe(true);
  }, 30_000);

  test("服务重启把持久化 waiting 代理恢复为 interrupted", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-restart-agents-"));
    dirs.push(dataDir);
    const first = await startServer({ dataDir, log: () => {} });
    const firstApi = createApiClient(first.url, first.token);
    const { session } = await firstApi.createSession({});
    await first.close();
    const db = new DatabaseSync(join(dataDir, "excelmanus.db"));
    db.prepare("UPDATE agents SET status = 'waiting' WHERE session_id = ? AND id = 'main'").run(
      session.id,
    );
    db.close();
    const restarted = await startServer({ dataDir, log: () => {} });
    servers.push(restarted);
    const detail = await createApiClient(restarted.url, restarted.token).getSession(session.id);
    expect(detail.agents.find((agent) => agent.id === "main")?.status).toBe("interrupted");
  });
});
