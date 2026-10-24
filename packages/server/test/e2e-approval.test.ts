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
    // 两次 boot 共享 calls：先写入，再从真实可见目录 inspect → finalize partial。
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
          let toolCallId: string;
          let input: string;
          if (calls.length === 2) {
            toolCallId = "approval-inspect";
            input = JSON.stringify({ action: "inspect" });
          } else if (calls.length === 3) {
            const inspected = opts.prompt
              .flatMap((message) => (message.role === "tool" ? message.content : []))
              .find(
                (part) => part.type === "tool-result" && part.toolCallId === "approval-inspect",
              );
            if (!inspected || inspected.type !== "tool-result" || inspected.output.type !== "json")
              throw new Error("missing provider-visible inspect result");
            const result = inspected.output.value as {
              status?: string;
              data?: {
                action?: string;
                allowedOutcomes?: string[];
                artifacts?: { id: string; path: string; persistence: string; validation: string }[];
              };
            };
            expect(result).toMatchObject({
              status: "ok",
              data: {
                action: "inspect",
                artifacts: [{ path: "note.txt", persistence: "saved", validation: "unverified" }],
              },
            });
            expect(result.data?.allowedOutcomes).toContain("partial");
            expect(result.data?.allowedOutcomes).not.toContain("completed");
            if (!result.data?.artifacts?.length) throw new Error("missing inspected saved artifact");
            toolCallId = "approval-finalize";
            input = JSON.stringify({
              action: "finalize",
              outcome: "partial",
              artifactIds: result.data.artifacts.map((artifact) => artifact.id),
            });
          } else {
            throw new Error("typed partial delivery must end the resumed turn");
          }
          return {
            stream: stream([
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: toolCallId, toolName: "deliver" },
              { type: "tool-input-delta", id: toolCallId, delta: input },
              { type: "tool-call", toolCallId, toolName: "deliver", input },
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
    expect(items.filter((r) => r.type === "tool.intent" && r.data.toolName === "write")).toHaveLength(1);
    expect(
      items.filter((r) => r.type === "tool.result" && r.data.toolCallId === "write-1"),
    ).toHaveLength(1);
    const delivery = items.find(
      (r) => r.type === "tool.result" && r.data.toolCallId === "approval-finalize",
    );
    expect(delivery?.data.result).toMatchObject({
      status: "ok",
      data: {
        outcome: "partial",
        finalizationStatus: "incomplete",
        artifacts: [{ path: "note.txt", persistence: "saved", validation: "unverified" }],
      },
    });
    const finalOutput = items.find(
      (r) => r.type === "model.output" && r.data.sourceToolCallId === "approval-finalize",
    );
    expect(finalOutput?.data.deliveryStatus).toBe("incomplete");
    expect(items.filter((r) => r.type === "turn.completed")).toHaveLength(1);
    expect(items.filter((r) => r.type === "turn.failed")).toHaveLength(0);
    expect(calls).toHaveLength(3);
    // turn.completed 只表示本轮正常终结；无 verification 的写入仍是 partial。
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
