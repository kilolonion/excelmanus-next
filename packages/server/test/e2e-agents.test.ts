import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { importXlsx } from "@excelmanus/workbook";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

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
    const child = typeof system?.content === "string" && system.content.includes("角色的子代理");
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
    await createTestProfile(api, {
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

describe("P0-01 / P0-11 回归：工具调用与结果之间不插入收件箱；非法参数不毒化会话", () => {
  test("spawn → agent_wait 期间报告到达，之后 main 正常完成；截断 JSON 参数写 intent+INVALID_ARGUMENT", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-fix-agent-loop-"));
    dirs.push(dataDir);
    let mainStep = 0;
    const m = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-agents",
      doStream: async (opts) => {
        const prompt = opts.prompt as PromptMsg[];
        if (promptSystem(prompt).includes("角色的子代理")) {
          await sleep(300);
          return { stream: textReply("子代理完成") };
        }
        mainStep += 1;
        if (mainStep === 1)
          return {
            stream: stream(
              toolCall("spawn-1", "agent_spawn", '{"name":"甲","role":"reader","task":"核对"}'),
            ),
          };
        if (mainStep === 2)
          return {
            stream: stream(
              toolCall("wait-1", "agent_wait", '{"for":"any_message","timeoutSeconds":10}'),
            ),
          };
        if (mainStep === 3)
          return { stream: stream(toolCall("bad-1", "memory", '{"action":"search","que')) };
        return { stream: textReply("已汇总") };
      },
    });
    const server = await startServer({ dataDir, resolveLanguageModel: () => m, log: () => {} });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "agents",
      provider: "custom-openai-compatible",
      model: "mock-agents",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "派生并等待" });
    const items = await waitLog(api, session.id, (all) =>
      all.some(
        (r) => r.agentId === "main" && (r.type === "turn.completed" || r.type === "turn.failed"),
      ),
    );
    const mainItems = items.filter((r) => r.agentId === "main");
    expect(mainItems.some((r) => r.type === "turn.failed")).toBe(false);
    expect(mainItems.some((r) => r.type === "turn.completed")).toBe(true);
    // 报告在等待结束之后的步骤边界才投递
    const waitResult = mainItems.findIndex(
      (r) =>
        r.type === "tool.result" && (r.data as { toolCallId?: string }).toolCallId === "wait-1",
    );
    const delivered = mainItems.findIndex((r) => r.type === "inbox.delivered");
    expect(waitResult).toBeGreaterThan(-1);
    expect(delivered).toBeGreaterThan(waitResult);
    // 截断 JSON：先 intent 后 result，INVALID_ARGUMENT
    const badIntent = mainItems.findIndex(
      (r) => r.type === "tool.intent" && (r.data as { toolCallId?: string }).toolCallId === "bad-1",
    );
    const badResult = mainItems.find(
      (r) => r.type === "tool.result" && (r.data as { toolCallId?: string }).toolCallId === "bad-1",
    );
    expect(badIntent).toBeGreaterThan(-1);
    expect(
      (badResult?.data as { result?: { error?: { code?: string } } } | undefined)?.result?.error
        ?.code,
    ).toBe("INVALID_ARGUMENT");
  }, 60_000);
});

/** 多 spawn 的流片段：每个 name/task 一对（tool-input-start/delta + tool-call）。 */
function spawnCalls(items: { name: string; role: string; task: string; files?: string[] }[]) {
  return items.flatMap((item, i) => {
    const input = JSON.stringify({
      name: item.name,
      role: item.role,
      task: item.task,
      ...(item.files ? { files: item.files } : {}),
    });
    const id = `spawn-${i + 1}`;
    return [
      { type: "tool-input-start", id, toolName: "agent_spawn" },
      { type: "tool-input-delta", id, delta: input },
      { type: "tool-call", toolCallId: id, toolName: "agent_spawn", input },
    ] as LanguageModelV4StreamPart[];
  });
}

function textReply(text: string): ReadableStream<LanguageModelV4StreamPart> {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
    { type: "text-end", id: "answer" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
  ]);
}

function toolCall(id: string, toolName: string, input: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: input },
    { type: "tool-call", toolCallId: id, toolName, input },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
  ];
}

type PromptMsg = { role: string; content: unknown };
const promptText = (prompt: PromptMsg[]): string => JSON.stringify(prompt);
const promptSystem = (prompt: PromptMsg[]): string => {
  const sys = prompt.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
};

/** 轮询会话日志直到条件满足或超时。 */
async function waitLog(
  api: ReturnType<typeof createApiClient>,
  sessionId: string,
  match: (items: { type: string; agentId: string | null; data: unknown }[]) => boolean,
  tries = 800,
): Promise<{ type: string; agentId: string | null; data: unknown }[]> {
  for (let i = 0; i < tries; i += 1) {
    const logs = await api.getSessionLog(sessionId, { limit: 500 });
    const items = logs.items as { type: string; agentId: string | null; data: unknown }[];
    if (match(items)) return items;
    await sleep(15);
  }
  return (await api.getSessionLog(sessionId, { limit: 500 })).items as {
    type: string;
    agentId: string | null;
    data: unknown;
  }[];
}

describe("M4 多代理：并发闸门 / 完成报告 / 租约 / 用户控制", () => {
  test("场景13：12 文件并发闸门 ≤2 + 每代理写自己的输出文件 + 完成报告 + control REST", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-agents-gate-"));
    dirs.push(dataDir);
    let inflight = 0;
    let peak = 0;
    const mainPrompts: string[] = [];
    const childPrompts: string[] = [];
    let spawnedOnce = false;
    const outFiles = Array.from({ length: 12 }, (_, index) => `out-${index + 1}.xlsx`);
    const gateModel = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-agents",
      doStream: async (opts) => {
        const prompt = opts.prompt as PromptMsg[];
        const sys = promptSystem(prompt);
        if (sys.includes("角色的子代理")) {
          inflight += 1;
          peak = Math.max(peak, inflight);
          await sleep(50);
          inflight -= 1;
          childPrompts.push(promptText(prompt));
          const file = sys.match(/out-\d+\.xlsx/)?.[0];
          const hasTool = prompt.some((m) => m.role === "tool");
          const lastUser = [...prompt].reverse().find((m) => m.role === "user");
          const userText = JSON.stringify(lastUser?.content ?? "");
          // 第一步：workbook_edit create 自己的输出文件；第二步及续跑轮：文字回复
          if (!hasTool && file && !userText.includes("补充")) {
            return {
              stream: stream(
                toolCall(
                  `edit-${file}`,
                  "workbook_edit",
                  JSON.stringify({
                    path: file,
                    create: true,
                    ops: [{ op: "cells.set", range: "A1", values: [[file]] }],
                  }),
                ),
              ),
            };
          }
          return { stream: textReply(`完成 ${file ?? ""}`) };
        }
        mainPrompts.push(promptText(prompt));
        const hasTool = prompt.some((m) => m.role === "tool");
        if (!hasTool && !spawnedOnce) {
          spawnedOnce = true;
          return {
            stream: stream([
              { type: "stream-start", warnings: [] },
              ...spawnCalls(
                outFiles.map((file, index) => ({
                  name: `w${index + 1}`,
                  role: "worker",
                  task: `写入 ${file} 并汇报`,
                  files: [file],
                })),
              ),
              { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
            ]),
          };
        }
        return { stream: textReply("已汇总") };
      },
    });
    const server = await startServer({
      dataDir,
      resolveLanguageModel: () => gateModel,
      maxConcurrentSubAgents: 2,
      log: () => {},
    });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "agents",
      provider: "custom-openai-compatible",
      model: "mock-agents",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", {
      clientMessageId: "m1",
      text: "并行整理十二个文件",
    });

    const isReport = (r: { type: string; data: unknown }) =>
      r.type === "inbox.sent" && (r.data as { kind?: string }).kind === "report";
    const items = await waitLog(api, session.id, (all) => {
      const spawned = all.filter((r) => r.type === "agent.spawned" && r.agentId !== "main");
      const reports = all.filter(isReport);
      const childDone = spawned.every((s) =>
        all.some((r) => r.type === "turn.completed" && r.agentId === s.agentId),
      );
      const mainDone2 =
        all.filter((r) => r.type === "turn.completed" && r.agentId === "main").length >= 2;
      return spawned.length >= 12 && reports.length >= 12 && childDone && mainDone2;
    });

    // 闸门：同时处于模型调用中的子代理峰值恰为 2（上限生效且确有并行）
    expect(peak).toBe(2);
    const spawned = items.filter((r) => r.type === "agent.spawned" && r.agentId !== "main");
    expect(spawned.length).toBe(12);
    const reports = items.filter(isReport);
    expect(reports.length).toBe(12);
    for (const r of reports) {
      const data = r.data as { fromAgentId: string; toAgentId: string; message: string };
      expect(data.toAgentId).toBe("main");
      expect(data.message).toContain("本轮已完成");
      expect(data.message).toContain("【最终回复】");
      expect(data.message).toContain("【变更摘要】");
      // 报告含该子代理输出文件路径与"修订"字样（05 §4.3）
      expect(data.message).toMatch(/out-\d+\.xlsx（修订 rev\d+）/);
    }
    // 十二个输出文件真实落盘并校验内容
    for (const f of outFiles) {
      expect(existsSync(join(server.workspaceRoot, f))).toBe(true);
      const workbook = importXlsx(readFileSync(join(server.workspaceRoot, f)), f).snapshot;
      const sheet = workbook.sheets[workbook.sheetOrder[0] ?? ""];
      expect(sheet?.cellData?.[0]?.[0]?.v).toBe(f);
    }
    // 每个子代理的步数 ≤ 60（step.started 计数）
    for (const s of spawned) {
      const steps = items.filter(
        (r) => r.type === "step.started" && r.agentId === s.agentId,
      ).length;
      expect(steps).toBeGreaterThan(0);
      expect(steps).toBeLessThanOrEqual(60);
    }
    // 报告经 inbox 投影进入 main 上下文：main 最后一轮 prompt 含报告正文
    expect(mainPrompts.at(-1)).toContain("本轮已完成");
    expect(mainPrompts.at(-1)).toContain("out-1.xlsx");

    // 用户控制 REST：pause → paused；resume → 恢复；main 不可 close（409）
    const detail = await api.getSession(session.id);
    const childId = detail.agents.find((a) => a.id !== "main")?.id;
    expect(childId).toBeDefined();
    const paused = await api.controlAgent(session.id, childId as string, { action: "pause" });
    expect(paused.status).toBe("paused");
    await api.controlAgent(session.id, childId as string, { action: "resume" });
    await waitLog(
      api,
      session.id,
      (all) =>
        all.some(
          (r) =>
            r.type === "agent.status" &&
            r.agentId === childId &&
            (r.data as { status?: string }).status === "idle",
        ),
      200,
    );
    await expect(api.controlAgent(session.id, "main", { action: "close" })).rejects.toThrow();

    // 用户直接给子代理发消息：开新一轮且该消息进入其 prompt
    await api.sendMessage(session.id, childId as string, {
      clientMessageId: "u2",
      text: "补充检查一下",
    });
    for (let i = 0; i < 200 && !childPrompts.some((p) => p.includes("补充检查一下")); i += 1)
      await sleep(15);
    expect(childPrompts.at(-1)).toContain("补充检查一下");
  }, 60_000);

  test("场景14：租约持有者拦截 path 与 docId 两种写入，B 可发消息给持有者", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-agents-lease-"));
    dirs.push(dataDir);
    let mainCalls = 0;
    let bCalls = 0;
    const leaseModel = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-agents",
      doStream: async (opts) => {
        const prompt = opts.prompt as PromptMsg[];
        const sys = promptSystem(prompt);
        if (sys.includes("持有共享文件")) {
          return { stream: textReply("已持有") };
        }
        if (sys.includes("尝试写入共享文件")) {
          bCalls += 1;
          if (bCalls === 1) {
            return {
              stream: stream(
                toolCall(
                  "b-edit-path",
                  "workbook_edit",
                  JSON.stringify({
                    path: "shared.xlsx",
                    ops: [{ op: "cells.set", range: "A2", values: [["B"]] }],
                  }),
                ),
              ),
            };
          }
          if (bCalls === 2) {
            return {
              stream: stream(
                toolCall(
                  "b-read",
                  "workbook_read",
                  JSON.stringify({ path: "shared.xlsx", mode: "overview" }),
                ),
              ),
            };
          }
          if (bCalls === 3) {
            // 从上一步 tool 结果里取 docId，用 docId 形式再写一次（验证租约解析 targets）
            const toolMsgs = prompt.filter((m) => m.role === "tool");
            const last = toolMsgs.at(-1);
            const content = last?.content as
              | { type: string; output?: { value?: unknown } }[]
              | undefined;
            let value = content?.[0]?.output?.value;
            if (typeof value === "string") {
              try {
                value = JSON.parse(value);
              } catch {
                value = undefined;
              }
            }
            // tool-result 的 output.value 是整个 ToolResult：{status, data:{docId,...}}
            const data =
              typeof value === "object" && value !== null
                ? ((value as { data?: unknown }).data ?? value)
                : undefined;
            const docId =
              typeof data === "object" && data !== null
                ? (data as { docId?: unknown }).docId
                : undefined;
            if (typeof docId !== "string") return { stream: textReply("拿不到 docId") };
            return {
              stream: stream(
                toolCall(
                  "b-edit-doc",
                  "workbook_edit",
                  JSON.stringify({
                    docId,
                    ops: [{ op: "cells.set", range: "A2", values: [["B"]] }],
                  }),
                ),
              ),
            };
          }
          if (bCalls === 4) {
            return {
              stream: stream(
                toolCall(
                  "b-send",
                  "agent_send",
                  JSON.stringify({ to: "持有方", message: "请代写 shared.xlsx!A2" }),
                ),
              ),
            };
          }
          return { stream: textReply("已转交") };
        }
        mainCalls += 1;
        if (mainCalls === 1) {
          return {
            stream: stream(
              toolCall(
                "m-create",
                "workbook_edit",
                JSON.stringify({
                  path: "shared.xlsx",
                  create: true,
                  ops: [{ op: "cells.set", range: "A1", values: [["x"]] }],
                }),
              ),
            ),
          };
        }
        if (mainCalls === 2) {
          return {
            stream: stream([
              { type: "stream-start", warnings: [] },
              ...spawnCalls([
                { name: "持有方", role: "worker", task: "持有共享文件", files: ["shared.xlsx"] },
              ]),
              { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
            ]),
          };
        }
        if (mainCalls === 3) {
          return {
            stream: stream([
              { type: "stream-start", warnings: [] },
              ...spawnCalls([{ name: "写入方", role: "worker", task: "尝试写入共享文件" }]),
              { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
            ]),
          };
        }
        return { stream: textReply("好") };
      },
    });
    const server = await startServer({
      dataDir,
      resolveLanguageModel: () => leaseModel,
      log: () => {},
    });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "agents",
      provider: "custom-openai-compatible",
      model: "mock-agents",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "建文件并分工" });

    const items = await waitLog(api, session.id, (all) => {
      const leased = all.filter(
        (r) =>
          r.type === "tool.result" &&
          (r.data as { result?: { error?: { code?: string } } }).result?.error?.code ===
            "FILE_LEASED",
      );
      const inboxToA = all.some(
        (r) =>
          r.type === "inbox.sent" &&
          (r.data as { kind?: string }).kind === "agent" &&
          (r.data as { message?: string }).message === "请代写 shared.xlsx!A2",
      );
      return leased.length >= 2 && inboxToA;
    });

    const detail = await api.getSession(session.id);
    const a = detail.agents.find((x) => x.name === "持有方");
    const b = detail.agents.find((x) => x.name === "写入方");
    expect(a?.role).toBe("worker");
    const leased = items.filter(
      (r) =>
        r.type === "tool.result" &&
        (r.data as { result?: { error?: { code?: string } } }).result?.error?.code ===
          "FILE_LEASED",
    );
    expect(leased.length).toBe(2);
    for (const r of leased) {
      expect(r.agentId).toBe(b?.id);
      const data = r.data as { result?: { data?: { holder?: { agentId?: string } } } };
      expect(data.result?.data?.holder?.agentId).toBe(a?.id);
    }
    // docId 调用确曾发生（覆盖 targets 解析），且对应 intent 的 args 里是 docId 不是 path
    const docIntent = items.find(
      (r) =>
        r.type === "tool.intent" &&
        r.agentId === b?.id &&
        typeof (r.data as { args?: { docId?: unknown } }).args?.docId === "string",
    );
    expect(docIntent).toBeDefined();
    // B → A 的 inbox 已投递
    expect(
      items.some(
        (r) =>
          r.type === "inbox.delivered" && (r.data as { toAgentId?: string }).toAgentId === a?.id,
      ),
    ).toBe(true);
  }, 60_000);
});
