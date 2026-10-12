// 一代功能的后端适配：计划/只读问答模式、自动会话标题、回复反馈与 JSON 导出。

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createApiClient, type LogRecord } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";

const SAMPLE_XLSX = fileURLToPath(new URL("../../../samples/sales.xlsx", import.meta.url));
const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const stream = (parts: LanguageModelV4StreamPart[]) =>
  new ReadableStream<LanguageModelV4StreamPart>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: t },
  { type: "text-end", id: "t" },
  { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
];

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const until = async (check: () => Promise<boolean>, what: string) => {
  const t0 = Date.now();
  while (!(await check())) {
    if (Date.now() - t0 > 15_000) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("计划模式拒绝写入；首轮后自动起标题；反馈与 JSON 导出", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-chat-modes-"));
  dirs.push(dataDir);
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doStream: async (opts) => {
      const prompt = opts.prompt as Array<{ role: string; content: unknown }>;
      const system = prompt.find((m) => m.role === "system");
      if (JSON.stringify(system?.content ?? "").includes("起一个简短的中文标题"))
        return { stream: stream(text("《修改销售表》")) };
      const tools = prompt.filter((m) => m.role === "tool").length;
      if (tools === 0)
        return {
          stream: stream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "tc-edit",
              toolName: "workbook_edit",
              input:
                '{"path":"sales.xlsx","ops":[{"op":"cells.set","range":"销售!D2","values":[["计划里不该写"]]}]}',
            },
            { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "x" } },
          ]),
        };
      return { stream: stream(text("计划：把 D2 改成目标值。")) };
    },
  });
  const srv = await startServer({
    dataDir,
    resolveLanguageModel: () => model,
    log: () => {},
    autoTitle: true,
  });
  servers.push(srv);
  copyFileSync(SAMPLE_XLSX, join(srv.workspaceRoot, "sales.xlsx"));
  const api = createApiClient(srv.url, srv.token);
  await api.createModelProfile({
    name: "mock",
    provider: "custom-openai-compatible",
    model: "mock",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "sk-test-1234",
  });
  const { session } = await api.createSession({ permissionMode: "auto" });
  const records = async () => (await api.getSessionLog(session.id, { limit: 500 })).items;

  await api.sendMessage(session.id, "main", {
    clientMessageId: "m1",
    text: "把 D2 改一下",
    chatMode: "plan",
  });
  await until(async () => (await records()).some((r) => r.type === "turn.completed"), "计划轮完成");
  const result = (await records()).find((r: LogRecord) => r.type === "tool.result") as LogRecord;
  expect(result.data).toMatchObject({
    status: "error",
    result: { error: { code: "APPROVAL_DENIED" } },
  });
  expect(JSON.stringify(result.data)).toContain("计划模式");
  const { document } = await api.openDoc(session.workspaceId, { path: "sales.xlsx" });
  expect(document.rev).toBe(0);

  await until(
    async () => (await api.getSession(session.id)).session.title === "修改销售表",
    "自动标题",
  );

  const reply = (await records()).filter(
    (r) => r.type === "model.output" && (r.data as { text?: string }).text,
  )[0] as LogRecord;
  await api.sendFeedback(session.id, { seq: reply.seq, rating: "down", comment: "没执行" });
  await expect(api.sendFeedback(session.id, { seq: 1, rating: "up" })).rejects.toMatchObject({
    status: 404,
  });

  const exported = await api.exportSessionJson(session.id);
  expect(exported.session.title).toBe("修改销售表");
  expect(exported.records.at(-1)).toMatchObject({
    type: "feedback.given",
    agentId: "main",
    data: { seq: reply.seq, rating: "down" },
  });
}, 60_000);
