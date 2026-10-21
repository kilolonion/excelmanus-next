import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient, type LogRecord } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stream(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("ask_user 阻塞与恢复", () => {
  test("问题回答前 actor 保持 blocked，回答后继续并写入 tool.result", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-question-"));
    dirs.push(dataDir);
    const model = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-question",
      doStream: async (opts) => {
        const prompt = opts.prompt as Array<{ role: string }>;
        if (!prompt.some((message) => message.role === "tool")) {
          return {
            stream: stream([
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "question-1", toolName: "ask_user" },
              {
                type: "tool-input-delta",
                id: "question-1",
                delta: '{"type":"choice","spec":{"question":"继续？"}}',
              },
              {
                type: "tool-call",
                toolCallId: "question-1",
                toolName: "ask_user",
                input: '{"type":"choice","spec":{"question":"继续？"}}',
              },
              {
                type: "finish",
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
              },
            ]),
          };
        }
        return {
          stream: stream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "已收到回答" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: "stop" },
            },
          ]),
        };
      },
    });
    const server = await startServer({ dataDir, resolveLanguageModel: () => model });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "question",
      provider: "custom-openai-compatible",
      model: "mock-question",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session, agents } = await api.createSession({ permissionMode: "auto" });
    const agent = agents[0];
    if (!agent) throw new Error("主代理缺失");
    await api.sendMessage(session.id, agent.id, {
      clientMessageId: "question-1",
      text: "请问我",
    });

    let asked: LogRecord | undefined;
    for (let i = 0; i < 300 && !asked; i++) {
      asked = (await api.getSessionLog(session.id)).items.find((r) => r.type === "question.asked");
      if (!asked) await sleep(10);
    }
    expect(asked).toBeDefined();
    const questionId = String((asked as LogRecord).data.questionId);
    expect((await api.getSession(session.id)).agents[0]?.status).toBe("blocked");
    expect((await api.getSessionLog(session.id)).items.some((r) => r.type === "tool.result")).toBe(
      false,
    );

    const answered = await api.answerQuestion(questionId, { answer: "yes", rev: 2 });
    expect(answered.question.status).toBe("approved");
    for (let i = 0; i < 300; i++) {
      const items = (await api.getSessionLog(session.id)).items;
      if (items.some((r) => r.type === "tool.result")) break;
      await sleep(10);
    }
    const items = (await api.getSessionLog(session.id)).items;
    const toolResult = items.find((r) => r.type === "tool.result");
    expect(toolResult?.data).toMatchObject({
      toolCallId: "question-1",
      result: { status: "ok", data: { questionId, status: "answered", answer: "yes", rev: 2 } },
    });
    expect(items.some((r) => r.type === "turn.completed")).toBe(true);
  }, 30_000);
});
