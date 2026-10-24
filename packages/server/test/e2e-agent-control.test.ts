// 多代理控制面（审计 P1-01/02/03/05/08/10）：真实 HTTP + 真实 SQLite + 假模型。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MAX_C, MAX_R } from "@excelmanus/core";
import { describeDocChange } from "@excelmanus/kernel";
import { createApiClient } from "@excelmanus/protocol";
import { summarizeWriteSet, unionArea } from "@excelmanus/workbook";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
type Part = LanguageModelV4StreamPart;
type PromptMsg = { role: string; content: unknown };
type Rec = { seq: number; type: string; agentId: string | null; data: Record<string, unknown> };

const stream = (parts: Part[]) =>
  new ReadableStream<Part>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
/** 一直不结束、直到请求被中止的模型流。 */
const hang = (signal: AbortSignal | undefined) =>
  new ReadableStream<Part>({
    start(c) {
      c.enqueue({ type: "stream-start", warnings: [] });
      signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    },
  });
const call = (calls: { id: string; tool: string; input: unknown }[]) =>
  stream([
    { type: "stream-start", warnings: [] },
    ...calls.flatMap(
      (c) =>
        [
          { type: "tool-input-start", id: c.id, toolName: c.tool },
          { type: "tool-input-delta", id: c.id, delta: JSON.stringify(c.input) },
          { type: "tool-call", toolCallId: c.id, toolName: c.tool, input: JSON.stringify(c.input) },
        ] as Part[],
    ),
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
  ]);
const system = (p: PromptMsg[]) => {
  const s = p.find((m) => m.role === "system");
  return typeof s?.content === "string" ? s.content : "";
};


/** Read host handles only from the latest provider-visible inspect result. */
function partialCall(prompt: Array<{ role: string; content: unknown }>, prefix: string, expectedPath?: string) {
  const results = prompt.filter(m => m.role === "tool" && Array.isArray(m.content))
    .flatMap(m => m.content as Array<{ type: string; toolName?: string; output?: { type: string; value?: unknown } }>)
    .filter(p => p.type === "tool-result");
  const last = results.at(-1);
  const value = last?.output?.type === "json" ? last.output.value as {
    status?: string; data?: { action?: string; allowedOutcomes?: string[]; unverifiedObligationCount?: number;
      factSets?: Array<{ id: string }>; artifacts?: Array<{ id: string; path: string; persistence: string; validation: string }> };
  } : undefined;
  if (last?.toolName !== "deliver" || value?.data?.action !== "inspect")
    return { id: `${prefix}-inspect-${results.length}`, tool: "deliver", input: { action: "inspect" } };
  expect(value.status).toBe("ok");
  const data = value.data;
  expect(data.allowedOutcomes).toContain("partial");
  if (expectedPath) {
    expect(data.artifacts?.find(a => a.path === expectedPath)).toMatchObject({ persistence: "saved", validation: "unverified" });
    expect(data.allowedOutcomes).not.toContain("completed");
    expect(data.unverifiedObligationCount).toBeGreaterThan(0);
  }
  if ((data.unverifiedObligationCount ?? 0) > 0) expect(data.allowedOutcomes).not.toContain("completed");
  return { id: `${prefix}-partial-${results.length}`, tool: "deliver", input: {
    action: "finalize", outcome: "partial",
    artifactIds: (data.artifacts ?? []).map(a => a.id),
    factSetIds: (data.factSets ?? []).map(f => f.id),
  } };
}

interface Behaviour {
  /** main 首轮派生的子代理名单。 */
  spawn: string[];
  /** 返回 true 的子代理模型调用一直挂起到被中止。 */
  hangSub: (name: string) => boolean;
  hangMain?: boolean;
  /** main 首轮改为直接写工作簿（审批场景）。 */
  mainWrites?: boolean;
}

async function boot(b: Behaviour, maxConcurrentSubAgents: number, prompts: string[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-fix-agent-control-"));
  dirs.push(dataDir);
  let spawned = false;
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doStream: async (opts) => {
      const prompt = opts.prompt as PromptMsg[];
      const sys = system(prompt);
      const hasTool = prompt.some((m) => m.role === "tool");
      const name = sys.match(/你的任务是：写入 (\S+?) /)?.[1];
      if (name !== undefined) {
        prompts.push(sys);
        if (b.hangSub(name)) return { stream: hang(opts.abortSignal) };
        if (!hasTool) {
          return {
            stream: call([
              {
                id: `edit-${name}`,
                tool: "workbook_edit",
                input: {
                  path: `${name}.xlsx`,
                  create: true,
                  ops: [
                    {
                      op: "cells.set",
                      range: "A1",
                      values: [
                        [1, 2],
                        [3, 4],
                      ],
                    },
                  ],
                },
              },
            ]),
          };
        }
        return { stream: call([partialCall(prompt, `child-${name}`, `${name}.xlsx`)]) };
      }
      if (b.hangMain) return { stream: hang(opts.abortSignal) };
      if (b.mainWrites && !hasTool) {
        return {
          stream: call([
            {
              id: "w1",
              tool: "workbook_edit",
              input: {
                path: "m.xlsx",
                create: true,
                ops: [{ op: "cells.set", range: "A1", values: [[1]] }],
              },
            },
          ]),
        };
      }
      if (!hasTool && !spawned && b.spawn.length > 0) {
        spawned = true;
        return {
          stream: call(
            b.spawn.map((n, i) => ({
              id: `spawn-${i}`,
              tool: "agent_spawn",
              input: {
                name: n,
                role: "worker",
                task: `写入 ${n} 文件`,
                files: [`${n}.xlsx`],
                handoff: {
                  goal: "创建演示文件",
                  scope: [{ path: `${n}.xlsx`, sheet: "Sheet1", range: "A1:B2" }],
                  constraints: ["不要改原表"],
                  deliverables: [`${n}.xlsx`],
                  acceptance: ["包含四个数值单元格"],
                  evidence: ["目标文件尚未创建；没有已知 rev"],
                },
              },
            })),
          ),
        };
      }
      return { stream: call([partialCall(prompt, "main", b.mainWrites ? "m.xlsx" : undefined)]) };
    },
  });
  const server = await startServer({
    dataDir,
    resolveLanguageModel: () => model,
    maxConcurrentSubAgents,
    log: () => {},
  });
  servers.push(server);
  const api = createApiClient(server.url, server.token);
  await createTestProfile(api, {
    name: "m",
    provider: "custom-openai-compatible",
    model: "mock",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "test",
  });
  const logs = async (sessionId: string): Promise<Rec[]> => {
    const items: Rec[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await api.getSessionLog(sessionId, { limit: 500, before });
      if (!page.items.length) break;
      const next = page.items[0]!.seq;
      if (before !== undefined && next >= before) throw new Error("nonadvancing log cursor");
      items.unshift(...page.items as unknown as Rec[]);
      before = next;
      if (page.items.length < 500) break;
    }
    return items;
  };
  const waitFor = async (sessionId: string, ok: (items: Rec[]) => boolean, tries = 600) => {
    for (let i = 0; i < tries; i += 1) {
      const items = await logs(sessionId);
      if (ok(items)) return items;
      await sleep(15);
    }
    throw new Error("等待超时");
  };
  const agents = async (sessionId: string) => (await api.getSession(sessionId)).agents;
  return { api, server, dataDir, logs, waitFor, agents };
}

const statusOf = (items: { name?: string | null; status: string }[], name: string) =>
  items.find((a) => a.name === name)?.status;

describe("多代理控制面", () => {
  test("P1-01/05/10：闸门不留僵尸 queued；change.summary 来自文档日志；子代理提示词含规则", async () => {
    const prompts: string[] = [];
    const t = await boot({ spawn: ["甲", "乙", "丙"], hangSub: () => false }, 1, prompts);
    await t.api.createRule({ content: "不要改原表" });
    const { session } = await t.api.createSession({});
    await t.api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "并行" });
    const items = await t.waitFor(
      session.id,
      (all) =>
        all.filter((r) => r.type === "inbox.sent" && r.data.kind === "report").length >= 3 &&
        all.filter((r) => r.type === "turn.completed" && r.agentId === "main").length >= 2,
    );
    await sleep(200);
    const list = await t.agents(session.id);
    for (const n of ["甲", "乙", "丙"]) expect(statusOf(list, n)).toBe("idle");
    expect(list.some((a) => a.status === "queued")).toBe(false);

    expect(items.some(r => r.type === "turn.failed")).toBe(false);
    const childDeliveries = items.filter(r => r.type === "tool.result" && r.agentId !== "main" && String(r.data.toolCallId).includes("-partial-"));
    expect(childDeliveries).toHaveLength(3);
    for (const row of childDeliveries) expect(row.data.result).toMatchObject({ status: "ok", data: { finalizationStatus: "incomplete" } });
    const summaries = items.filter((r) => r.type === "change.summary");
    expect(summaries.length).toBe(3);
    const docs = summaries.flatMap(
      (r) =>
        (r.data.changes as { docs: { path: string; cellsBySheet: Record<string, number> }[] }).docs,
    );
    expect(docs.map((d) => d.path).sort()).toEqual(["丙.xlsx", "乙.xlsx", "甲.xlsx"]);
    for (const d of docs) expect(Object.values(d.cellsBySheet)).toEqual([4]);
    const report = items.find((r) => r.type === "inbox.sent" && r.data.kind === "report");
    expect(String(report?.data.message)).toMatch(/\.xlsx（修订 rev\d+）；单元格：Sheet1 4 格/);
    const db = new DatabaseSync(join(t.dataDir, "excelmanus.db"));
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM change_summaries WHERE session_id = ?")
        .get(session.id) as {
        n: number;
      }
    ).n;
    db.close();
    expect(n).toBe(3);

    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).toContain("通用原则");
      expect(p).toContain("权限说明");
      expect(p).toContain("不要改原表");
      expect(p).toContain("工作区：");
      expect(p).toContain("子代理任务说明");
      expect(p).toContain('"acceptance":["包含四个数值单元格"]');
      expect(p).toContain('"range":"A1:B2"');
      expect(p).toContain("不授予额外权限");
    }
  }, 60_000);

  test("P1-03：停止全部后闸门排队者不开跑，被停子代理的报告不唤醒 main；继续后恢复", async () => {
    let hangOn = true;
    const t = await boot({ spawn: ["甲", "乙"], hangSub: () => hangOn }, 1);
    const { session } = await t.api.createSession({});
    await t.api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "并行" });
    let list = await t.agents(session.id);
    for (let i = 0; i < 300 && statusOf(list, "乙") !== "queued"; i += 1) {
      await sleep(15);
      list = await t.agents(session.id);
    }
    expect(statusOf(list, "甲")).toBe("running");
    expect(statusOf(list, "乙")).toBe("queued");
    await t.waitFor(
      session.id,
      (all) => all.filter((r) => r.type === "turn.completed" && r.agentId === "main").length >= 1,
    );
    const stopRes = await t.api.stopAll(session.id);
    const yi = list.find((a) => a.name === "乙")?.id as string;
    const jia = list.find((a) => a.name === "甲")?.id as string;
    expect(stopRes.stopped.sort()).toEqual([jia, yi].sort());
    const before = await t.waitFor(session.id, (all) =>
      all.some((r) => r.type === "inbox.sent" && r.data.kind === "report" && r.agentId === jia),
    );
    const stopSeq = Math.max(...before.map((r) => r.seq));
    await sleep(500);
    const after = (await t.logs(session.id)).filter((r) => r.seq > stopSeq);
    expect(after.filter((r) => r.type === "turn.started")).toEqual([]);
    expect(
      (await t.logs(session.id)).some((r) => r.type === "turn.started" && r.agentId === yi),
    ).toBe(false);
    list = await t.agents(session.id);
    expect(statusOf(list, "乙")).toBe("idle");
    expect(statusOf(list, "甲")).toBe("interrupted");

    // 继续：挂起的任务派发恢复运行
    hangOn = false;
    await t.api.resumeAgent(session.id, yi);
    await t.waitFor(session.id, (all) =>
      all.some((r) => r.type === "turn.completed" && r.agentId === yi),
    );
  }, 60_000);

  test("P1-02：关闭 / 暂停运行中的子代理是持久的；父代理不能 resume 非暂停代理", async () => {
    const t = await boot({ spawn: ["甲", "乙"], hangSub: () => true }, 4);
    const { session } = await t.api.createSession({});
    await t.api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "并行" });
    let list = await t.agents(session.id);
    for (
      let i = 0;
      i < 300 && list.filter((a) => a.status === "running" && a.id !== "main").length < 2;
      i += 1
    ) {
      await sleep(15);
      list = await t.agents(session.id);
    }
    const jia = list.find((a) => a.name === "甲")?.id as string;
    const yi = list.find((a) => a.name === "乙")?.id as string;
    expect((await t.api.controlAgent(session.id, jia, { action: "close" })).status).toBe("closed");
    expect((await t.api.controlAgent(session.id, yi, { action: "pause" })).status).toBe("paused");
    await t.waitFor(session.id, (all) =>
      [jia, yi].every((id) => all.some((r) => r.type === "turn.interrupted" && r.agentId === id)),
    );
    await sleep(300);
    list = await t.agents(session.id);
    expect(statusOf(list, "甲")).toBe("closed");
    expect(statusOf(list, "乙")).toBe("paused");
    // 用户 REST resume 与工具路径同一状态检查：closed 不能继续
    await expect(t.api.controlAgent(session.id, jia, { action: "resume" })).rejects.toThrow();
    expect(statusOf(await t.agents(session.id), "甲")).toBe("closed");
  }, 60_000);

  test("变更摘要：重复写同一区域按并集计格；只列本轮实际修订", () => {
    const r = (r0: number, c0: number, r1: number, c1: number) => ({
      sheetId: "s",
      r0,
      c0,
      r1,
      c1,
    });
    expect(unionArea([r(0, 0, 1, 1), r(0, 0, 1, 1)])).toBe(4);
    expect(unionArea([r(0, 0, 1, 1), r(1, 1, 2, 2)])).toBe(7);
    expect(unionArea([r(0, 0, 0, 0), r(5, 5, 5, 5)])).toBe(2);
    expect(
      summarizeWriteSet(
        {
          ranges: [
            r(0, 0, MAX_R, MAX_C),
            r(MAX_R, MAX_C, MAX_R, MAX_C),
            r(MAX_R, MAX_C, MAX_R, MAX_C),
          ],
          structural: [{ sheetId: "s", kind: "removeSheet", index: 0, count: 0 }],
        },
        new Map([["s", "Sheet1"]]),
      ),
    ).toEqual({
      cellsBySheet: { Sheet1: 1 },
      ranges: ["Sheet1!XFD1048576"],
      structural: ["删除工作表（Sheet1）"],
      added: [],
    });
    const base = {
      docId: "d",
      path: "a.xlsx",
      cellsBySheet: {},
      ranges: [],
      structural: [],
      added: [],
    };
    expect(describeDocChange({ ...base, fromRev: 2, toRev: 3, revs: [3] })).toBe(
      "a.xlsx（修订 rev3）",
    );
    expect(describeDocChange({ ...base, fromRev: 2, toRev: 4, revs: [3, 4] })).toBe(
      "a.xlsx（修订 rev3–rev4）",
    );
    expect(describeDocChange({ ...base, fromRev: 2, toRev: 5, revs: [3, 5] })).toBe(
      "a.xlsx（修订 rev3、rev5）",
    );
  });

  test("P1-08：运行中 / 待审批时删除会话不会复活，残留审批不可再决定", async () => {
    const t = await boot({ spawn: [], hangSub: () => false, hangMain: true }, 4);
    const { session } = await t.api.createSession({});
    await t.api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "慢慢想" });
    await t.waitFor(session.id, (all) => all.some((r) => r.type === "turn.started"));
    await t.api.deleteSession(session.id);
    await sleep(400);
    expect((await t.api.listSessions()).items.some((s) => s.id === session.id)).toBe(false);

    const t2 = await boot({ spawn: [], hangSub: () => false, mainWrites: true }, 4);
    const { session: s2 } = await t2.api.createSession({ permissionMode: "confirm" });
    await t2.api.sendMessage(s2.id, "main", { clientMessageId: "m1", text: "写" });
    const items = await t2.waitFor(s2.id, (all) =>
      all.some((r) => r.type === "approval.requested"),
    );
    const approvalId = String(items.find((r) => r.type === "approval.requested")?.data.approvalId);
    await t2.api.deleteSession(s2.id);
    await expect(t2.api.decideApproval(approvalId, { decision: "approve" })).rejects.toThrow();
    await sleep(300);
    expect((await t2.api.listSessions()).items.some((s) => s.id === s2.id)).toBe(false);
    const db = new DatabaseSync(join(t2.dataDir, "excelmanus.db"));
    for (const table of ["session_log", "pending_interactions", "agents", "leases", "todos"]) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(s2.id) as {
          n: number;
        }
      ).n;
      expect(n, table).toBe(0);
    }
    db.close();
  }, 60_000);
});

