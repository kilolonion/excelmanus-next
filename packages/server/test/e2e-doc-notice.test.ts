// 02 §4.7：用户改了代理读过的区域时，代理下一步收到 context.notice（kind=doc.edited）。

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createApiClient, type LogRecord } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, expect, test } from "vitest";
import { WebSocket } from "ws";
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

/** 起服务、建会话、打开 sales.xlsx，并提供经同步通道提交用户编辑的 submit。 */
async function setup(model: MockLanguageModelV4) {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-doc-history-"));
  dirs.push(dataDir);
  const srv = await startServer({ dataDir, resolveLanguageModel: () => model, log: () => {} });
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
  const { session } = await api.createSession({});
  const { document } = await api.openDoc(session.workspaceId, { path: "sales.xlsx" });
  const snap = await api.getDocSnapshot(session.workspaceId, document.id);
  const book = snap.snapshot as { id: string; sheetOrder: string[] };
  const { ticket } = await api.createTicket();
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
  const acks: string[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as { type: string; clientOpId?: string };
    if (m.type === "doc.ack" && m.clientOpId) acks.push(m.clientOpId);
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "sub", topic: `doc:${document.id}`, cursor: 0 }));
  let rev = snap.document.rev;
  const submit = async (id: string, row: number, col: number) => {
    ws.send(
      JSON.stringify({
        type: "doc.submit",
        docId: document.id,
        clientOpId: id,
        baseRev: rev,
        mutations: [
          {
            id: "sheet.mutation.set-range-values",
            params: {
              unitId: book.id,
              subUnitId: book.sheetOrder[0],
              trigger: "sheet.command.set-range-values",
              cellValue: { [row]: { [col]: { v: `用户${id}` } } },
            },
          },
        ],
      }),
    );
    await until(async () => acks.includes(id), `ack ${id}`);
    rev += 1;
  };
  const cell = async (row: number, col: number) => {
    const s = (await api.getDocSnapshot(session.workspaceId, document.id)).snapshot as {
      sheets: Record<string, { cellData?: Record<number, Record<number, { v?: unknown }>> }>;
    };
    return s.sheets[book.sheetOrder[0] ?? ""]?.cellData?.[row]?.[col]?.v;
  };
  return { api, session, document, submit, cell, root: srv.workspaceRoot, close: () => ws.close() };
}

test("用户改了代理读过的单元格：下一步通知代理，未重读前不重复通知", async () => {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doStream: async (opts) => {
      const prompt = opts.prompt as Array<{ role: string; content: unknown }>;
      prompts.push(JSON.stringify(prompt));
      const users = prompt.filter((m) => m.role === "user").length;
      const tools = prompt.filter((m) => m.role === "tool").length;
      if (users === 1 && tools === 0)
        return {
          stream: stream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "tc-read",
              toolName: "workbook_read",
              input: '{"path":"sales.xlsx","mode":"range","range":"销售!A1:D5"}',
            },
            { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "x" } },
          ]),
        };
      return { stream: stream(text("好的")) };
    },
  });
  const { api, session, document, submit, close } = await setup(model);
  const records = async () => (await api.getSessionLog(session.id, { limit: 500 })).items;
  const notices = async () =>
    (await records()).filter(
      (r: LogRecord) =>
        r.type === "context.notice" && (r.data as { kind?: string }).kind === "doc.edited",
    );

  await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "看看前几行" });
  await until(async () => (await records()).some((r) => r.type === "turn.completed"), "首轮完成");
  await submit("far", 30, 0);
  await submit("b2", 1, 1);
  await until(async () => (await notices()).length === 1, "doc.edited 通知");
  await submit("b3", 2, 1);
  close();

  const list = await notices();
  expect(list).toHaveLength(1);
  expect(list[0]?.agentId).toBe("main");
  expect(list[0]?.data).toMatchObject({ docId: document.id, ranges: ["'销售'!B2"] });

  await api.sendMessage(session.id, "main", { clientMessageId: "m2", text: "继续" });
  await until(
    async () => (await records()).filter((r) => r.type === "turn.completed").length === 2,
    "第二轮完成",
  );
  expect(prompts.at(-1)).toContain("用户修改了 '销售'!B2");
}, 60_000);

test("撤销修订：之后没有改到同一区域才能撤销，撤销后列表标注", async () => {
  const { api, session, document, submit, cell, close } = await setup(
    new MockLanguageModelV4({ provider: "mock", modelId: "mock" }),
  );
  const original = await cell(1, 2);
  await submit("r1", 1, 1);
  await submit("r2", 1, 2);
  await submit("r3", 1, 1);
  close();
  const wsId = session.workspaceId;

  const before = await api.listDocRevisions(wsId, document.id);
  expect(before.items.map((r) => r.rev)).toEqual([3, 2, 1]);
  expect(before.items[0]?.changes.ranges).toEqual(["'销售'!B2"]);

  await expect(api.undoDocRevision(wsId, document.id, 1)).rejects.toMatchObject({ status: 409 });
  const undo = await api.undoDocRevision(wsId, document.id, 2);
  expect(undo).toMatchObject({ rev: 4, reverted: 2 });
  expect(await cell(1, 2)).toBe(original);
  expect(await cell(1, 1)).toBe("用户r3");
  await expect(api.undoDocRevision(wsId, document.id, 2)).rejects.toMatchObject({ status: 409 });

  const after = await api.listDocRevisions(wsId, document.id, { limit: 2 });
  expect(after.items.map((r) => [r.rev, r.reverts, r.revertedBy])).toEqual([
    [4, 2, null],
    [3, null, null],
  ]);
  expect((await api.listDocRevisions(wsId, document.id)).items[2]).toMatchObject({
    rev: 2,
    revertedBy: 4,
  });
}, 60_000);

test("新建空文件、文件来源历史与最近打开时间", async () => {
  const { api, session, submit, root, close } = await setup(
    new MockLanguageModelV4({ provider: "mock", modelId: "mock" }),
  );
  const wsId = session.workspaceId;
  await submit("h1", 1, 1);
  close();
  copyFileSync(SAMPLE_XLSX, join(root, "原始.xlsx"));
  const diff = await api.compareDocs(wsId, {
    left: { path: "原始.xlsx" },
    right: { path: "sales.xlsx" },
  });
  expect(diff.sheets.filter((s) => s.changed > 0)).toEqual([
    expect.objectContaining({
      name: "销售",
      status: "both",
      changed: 1,
      cells: [
        expect.objectContaining({ cell: "B2", kind: "modified", right: { value: "用户h1" } }),
      ],
    }),
  ]);
  expect(await api.createFile(wsId, "新表.xlsx")).toMatchObject({ path: "新表.xlsx" });
  expect(await api.createFile(wsId, "备注.md")).toMatchObject({ path: "备注.md", size: 0 });
  await expect(api.createFile(wsId, "新表.xlsx")).rejects.toMatchObject({ status: 409 });
  await expect(api.createFile(wsId, "a.exe")).rejects.toMatchObject({ status: 400 });
  const opened = await api.openDoc(wsId, { path: "新表.xlsx" });
  expect(opened.document.rev).toBe(0);

  const files = await api.listFiles(wsId);
  expect(files.items.find((f) => f.path === "sales.xlsx")?.openedAt).toBeTypeOf("string");
  expect(files.items.find((f) => f.path === "备注.md")?.openedAt).toBeUndefined();

  const history = await api.fileHistory(wsId, "sales.xlsx");
  expect(history.events[0]).toMatchObject({
    kind: "modified",
    source: "user",
    rev: 1,
    changes: { ranges: ["'销售'!B2"] },
  });
}, 60_000);
