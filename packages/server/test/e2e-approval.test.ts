import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stream(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

type Prompt = Array<{ role: string; content: unknown }>;

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("审批持久化闭环", () => {
  test("confirm 模式暂停写入，重启批准后执行并继续本轮收口（场景 9）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-approval-"));
    dirs.push(dataDir);
    // 两次 boot 共享 calls：第 1 次模型调用发写工具，之后回文本。
    const calls: Prompt[] = [];
    const makeModel = () =>
      new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-approval",
        doStream: async (opts) => {
          calls.push([...(opts.prompt as Prompt)]);
          if (calls.length === 1) {
            return {
              stream: stream([
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "write-1", toolName: "write" },
                {
                  type: "tool-input-delta",
                  id: "write-1",
                  delta: '{"path":"note.txt","content":"approved"}',
                },
                {
                  type: "tool-call",
                  toolCallId: "write-1",
                  toolName: "write",
                  input: '{"path":"note.txt","content":"approved"}',
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
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "已写入" },
              { type: "text-end", id: "t1" },
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
    const server = await startServer({
      dataDir,
      gateway: undefined,
      resolveLanguageModel: () => makeModel(),
    });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "approval",
      provider: "custom-openai-compatible",
      model: "mock-approval",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({ permissionMode: "confirm" });
    await api.sendMessage(session.id, "main", { clientMessageId: "approval-1", text: "写文件" });
    let approval: LogRecord | undefined;
    for (let i = 0; i < 400 && !approval; i++) {
      const log = await api.getSessionLog(session.id);
      approval = log.items.find((r) => r.type === "approval.requested");
      if (!approval) await sleep(10);
    }
    expect(approval).toBeDefined();
    const approvalId = String((approval as LogRecord).data.approvalId);
    expect(readFileSafe(server.workspaceRoot)).toBeUndefined();
    // 模拟进程重启：pending_interactions 留在真实 SQLite 中，新的 runtime 接管批准。
    servers.pop();
    await server.close();
    const restarted = await startServer({ dataDir, resolveLanguageModel: () => makeModel() });
    servers.push(restarted);
    const apiAfterRestart = createApiClient(restarted.url, restarted.token);
    const decided = await apiAfterRestart.decideApproval(approvalId, { decision: "approve" });
    expect(decided.approval.status).toBe("approved");
    const again = await apiAfterRestart.decideApproval(approvalId, { decision: "approve" });
    expect(again.idempotent).toBe(true);
    // 场景 9（04 §5.2）：批准后写 tool.result 并继续本轮到收口，全程只有一个 turn.started。
    let items: LogRecord[] = [];
    for (let i = 0; i < 400; i++) {
      const log = await apiAfterRestart.getSessionLog(session.id);
      items = log.items;
      if (items.some((r) => r.type === "turn.completed")) break;
      await sleep(10);
    }
    expect(readFileSafe(restarted.workspaceRoot)).toBe("approved");
    expect(items.filter((r) => r.type === "turn.started")).toHaveLength(1);
    expect(items.some((r) => r.type === "turn.completed")).toBe(true);
    const toolResult = items.find(
      (r) => r.type === "tool.result" && r.data.toolCallId === "write-1",
    );
    expect(toolResult?.data.status).toBe("ok");
    // 批准后同一轮继续推进了下一步模型调用，且 prompt 含该工具结果
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(calls[1])).toContain("write-1");
  }, 30_000);
});

function readFileSafe(root: string): string | undefined {
  try {
    return readFileSync(join(root, "note.txt"), "utf8");
  } catch {
    return undefined;
  }
}
