import { createTestProfile } from "./fixtures/create-model.ts";
// M2a 活文档同步 e2e：假模型走 workbook_read → workbook_edit（真实 HTTP/WS/SQLite），
// 另一个 WS 客户端订阅 doc:<id> 收 doc.op、doc.submit 冲突与续传。

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createApiClient, type RecMsg, type ServerMessage } from "@excelmanus/protocol";
import { importXlsx } from "@excelmanus/workbook";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";

const SAMPLE_XLSX = fileURLToPath(new URL("../../../samples/sales.xlsx", import.meta.url));

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const streamOf = (parts: LanguageModelV4StreamPart[]) =>
  new ReadableStream<LanguageModelV4StreamPart>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

const toolCall = (id: string, toolName: string, input: string): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName, input },
  { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
];

/** 第一步读 overview，第二步写 D2，第三步文本收尾。 */
function makeDocMockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-doc",
    doStream: async (opts) => {
      const prompt = opts.prompt as Array<{ role: string; content: unknown }>;
      const toolResults = prompt.filter((m) => m.role === "tool").length;
      if (toolResults === 0) {
        return {
          stream: streamOf(
            toolCall("tc-read", "workbook_read", '{"path":"sales.xlsx","mode":"overview"}'),
          ),
        };
      }
      if (toolResults === 1) {
        return {
          stream: streamOf(
            toolCall(
              "tc-edit",
              "workbook_edit",
              '{"path":"sales.xlsx","ops":[{"op":"cells.set","range":"销售!D2","values":[["e2e写入"]]}]}',
            ),
          ),
        };
      }
      return {
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "已写入。" },
          { type: "text-end", id: "t1" },
          { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
        ]),
      };
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TestWs {
  readonly msgs: ServerMessage[] = [];
  private ws!: WebSocket;

  static async connect(url: string): Promise<TestWs> {
    const c = new TestWs();
    c.ws = new WebSocket(url);
    c.ws.on("message", (data) => c.msgs.push(JSON.parse(String(data)) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      c.ws.once("open", () => resolve());
      c.ws.once("error", reject);
    });
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(pred: (m: ServerMessage) => boolean, what: string, timeoutMs = 15_000) {
    const t0 = Date.now();
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `等待超时：${what}；已收到 ${JSON.stringify(this.msgs.map((x) => x.type))}`,
        );
      }
      await sleep(10);
    }
  }

  close(): void {
    this.ws.close();
  }
}

const servers: RunningServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("e2e：活文档写入 + doc: 同步", () => {
  test("公式派生回传被拒绝；渲染→真实用户冲突→局部重读→格式修复贯通真实边界", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-observed-write-"));
    dirs.push(dataDir);
    const path = "报表.xlsx";
    const deferred = () => {
      let resolve: (() => void) | undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve: () => resolve?.() };
    };
    const beforeRender = deferred();
    const beforeFix = deferred();
    let userRev = 0;
    let step = 0;
    const fix = [
      { op: "style.set", range: "C17:E17", numFmt: "#,##0" },
      { op: "style.set", range: "F17", numFmt: "0.0%" },
      { op: "style.set", range: "H17:I17", fill: "#FFE699" },
    ];
    const model = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-observation",
      doStream: async () => {
        step++;
        if (step === 3) await beforeRender.promise;
        if (step === 4) await beforeFix.promise;
        const calls = [
          { name: "workbook_edit", args: { path, create: true, ops: [] } },
          {
            name: "workbook_edit",
            args: {
              path,
              ops: [
                { op: "sheet.rename", sheet: "Sheet1", name: "销售报表" },
                {
                  op: "cells.set",
                  range: "C5:F17",
                  values: Array.from({ length: 13 }, (_, i) => [
                    10000 + i,
                    20000 + i,
                    `=C${i + 5}+D${i + 5}`,
                    `=C${i + 5}/D${i + 5}`,
                  ]),
                },
                {
                  op: "cells.set",
                  range: "H4:I10",
                  values: Array.from({ length: 7 }, (_, i) => [`指标${i}`, "=SUM(C5:C17)"]),
                },
                { op: "cells.set", range: "A19", values: [["说明"]] },
                { op: "style.set", range: "C5:E16", numFmt: "#,##0" },
                { op: "style.set", range: "F5:F16", numFmt: "0.0%" },
              ],
            },
          },
          { name: "workbook_render", args: { path, sheet: "销售报表", range: "A1:I19" } },
          { name: "workbook_edit", args: { path, ops: fix } },
          {
            name: "workbook_read",
            args: {
              path,
              sheet: "销售报表",
              range: "A15:I19",
              mode: "range",
              facets: ["values", "formulas", "layout"],
            },
          },
          { name: "workbook_edit", args: { path, baseRev: userRev, ops: fix } },
          { name: "workbook_render", args: { path, sheet: "销售报表", range: "A16:I17" } },
        ];
        const call = calls[step - 1];
        return {
          stream: streamOf(
            call
              ? toolCall(`observed-${step}`, call.name, JSON.stringify(call.args))
              : [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "end" },
                  { type: "text-delta", id: "end", delta: "完成" },
                  { type: "text-end", id: "end" },
                  { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
                ],
          ),
        };
      },
    });
    const srv = await startServer({ dataDir, resolveLanguageModel: () => model, log: () => {} });
    servers.push(srv);
    const api = createApiClient(srv.url, srv.token);
    await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock-observation",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    const { ticket } = await api.createTicket();
    const ws = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    try {
      await ws.waitFor((m) => m.type === "hello", "hello");
      ws.send({ type: "sub", topic: "app" });
      ws.send({ type: "sub", topic: `session:${session.id}`, cursor: 0 });
      await ws.waitFor((m) => m.type === "sub.ok" && m.topic === "app", "renderer");
      await ws.waitFor(
        (m) => m.type === "sub.ok" && m.topic === `session:${session.id}`,
        "session",
      );
      await api.sendMessage(session.id, "main", {
        clientMessageId: "observed",
        text: "填充内容并核对合计行格式",
      });
      await ws.waitFor(
        (m) =>
          m.type === "rec" &&
          m.record.type === "tool.result" &&
          m.record.data.toolCallId === "observed-2",
        "populate",
      );
      const { document } = await api.openDoc(session.workspaceId, { path });
      const { snapshot } = await api.getDocSnapshot(session.workspaceId, document.id);
      const sheets = snapshot.sheets as Record<string, { id: string }>;
      const sid = Object.keys(sheets)[0] as string;
      const params = { unitId: snapshot.id, subUnitId: sid };
      ws.send({ type: "sub", topic: `doc:${document.id}`, cursor: document.rev });
      await ws.waitFor((m) => m.type === "sub.ok" && m.topic === `doc:${document.id}`, "doc");
      for (const [i, mutation] of [
        {
          id: "formula.mutation.set-formula-data",
          params: { formulaData: { [String(snapshot.id)]: { [sid]: {} } } },
        },
        {
          id: "formula.mutation.set-array-formula-data",
          params: { arrayFormulaRange: {}, arrayFormulaCellData: {} },
        },
        {
          id: "sheet.mutation.set-range-values",
          params: { ...params, cellValue: { 16: { 2: { v: 999999, t: 2, s: null } } } },
        },
        {
          id: "sheet.mutation.set-range-values",
          params: { ...params, cellValue: { 16: { 4: { f: "=C17+D17", si: null } } } },
        },
      ].entries()) {
        ws.send({
          type: "doc.submit",
          docId: document.id,
          clientOpId: `derived-${i}`,
          baseRev: document.rev,
          mutations: [mutation],
        });
        const reject = await ws.waitFor(
          (m) => m.type === "doc.reject" && m.clientOpId === `derived-${i}`,
          "derived reject",
        );
        expect(reject).toMatchObject({ conflict: { code: "UNSUPPORTED_FEATURE" } });
      }
      const db = new DatabaseSync(join(dataDir, "excelmanus.db"));
      try {
        expect(
          db
            .prepare("SELECT COUNT(*) AS n FROM doc_ops WHERE doc_id=? AND source_kind='user'")
            .get(document.id),
        ).toMatchObject({ n: 0 });
      } finally {
        db.close();
      }
      beforeRender.resolve();
      const firstImage = await ws.waitFor((m) => m.type === "render.request", "first render");
      if (firstImage.type !== "render.request") throw new Error("missing render");
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      ws.send({ type: "render.result", requestId: firstImage.requestId, png });
      await ws.waitFor(
        (m) =>
          m.type === "rec" &&
          m.record.type === "tool.result" &&
          m.record.data.toolCallId === "observed-3",
        "render result",
      );
      const current = await api.getDocSnapshot(session.workspaceId, document.id);
      ws.send({
        type: "doc.submit",
        docId: document.id,
        clientOpId: "actual-user",
        baseRev: current.document.rev,
        mutations: [
          {
            id: "sheet.mutation.set-range-values",
            params: {
              ...params,
              trigger: "sheet.command.set-range-values",
              cellValue: { 16: { 2: { v: 123456, t: 2 } } },
            },
          },
        ],
      });
      const ack = await ws.waitFor(
        (m) => m.type === "doc.ack" && m.clientOpId === "actual-user",
        "true user edit",
      );
      if (ack.type !== "doc.ack") throw new Error("missing ack");
      userRev = ack.rev;
      beforeFix.resolve();
      const secondImage = await ws.waitFor(
        (m) => m.type === "render.request" && m.requestId !== firstImage.requestId,
        "format render",
      );
      if (secondImage.type !== "render.request") throw new Error("missing final render");
      expect(secondImage.layout.cells.map((c) => c.text)).toContain("123,456");
      expect(secondImage.layout.cells.map((c) => c.text)).toContain("20,012");
      expect(secondImage.layout.cells.map((c) => c.text)).toContain("616.9%");
      expect(secondImage.layout.cells.filter((c) => c.fill === "#FFE699")).toHaveLength(2);
      ws.send({ type: "render.result", requestId: secondImage.requestId, png });
      await ws.waitFor((m) => m.type === "rec" && m.record.type === "turn.completed", "done");
      const records = ws.msgs.flatMap((m) => (m.type === "rec" ? [m.record] : []));
      const result = (n: number) =>
        records.find((r) => r.type === "tool.result" && r.data.toolCallId === `observed-${n}`)?.data
          .result;
      expect(result(4)).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
      expect(result(5)).toMatchObject({ status: "ok" });
      expect(result(6)).toMatchObject({ status: "ok" });
      // 冲突条「保留我的」：同一格带旧 baseRev 先被拒绝并指出冲突区域，带 overwrite 重发则通过
      const stale = {
        type: "doc.submit",
        docId: document.id,
        baseRev: current.document.rev,
        mutations: [
          {
            id: "sheet.mutation.set-range-values",
            params: {
              ...params,
              trigger: "sheet.command.set-range-values",
              cellValue: { 16: { 2: { v: 123456, t: 2 } } },
            },
          },
        ],
      };
      ws.send({ ...stale, clientOpId: "stale-user" });
      const staleReject = await ws.waitFor(
        (m) => m.type === "doc.reject" && m.clientOpId === "stale-user",
        "stale reject",
      );
      expect(staleReject).toMatchObject({
        conflict: { code: "VERSION_CONFLICT", conflicts: [{ cells: ["'销售报表'!C17"] }] },
      });
      ws.send({ ...stale, clientOpId: "keep-mine", overwrite: true });
      const kept = await ws.waitFor(
        (m) => m.type === "doc.ack" && m.clientOpId === "keep-mine",
        "keep mine ack",
      );
      if (kept.type !== "doc.ack") throw new Error("missing ack");
      expect(kept.rev).toBeGreaterThan(userRev);
      const meta = (await api.getDocSnapshot(session.workspaceId, document.id)).document;
      await ws.waitFor(
        (m) => m.type === "doc.checkpoint" && m.checkpointRev === meta.rev,
        "checkpoint",
      );
      const disk = importXlsx(readFileSync(join(srv.workspaceRoot, path)), path).snapshot;
      const cell = disk.sheets.s0?.cellData?.[16]?.[2];
      expect(cell?.v).toBe(123456);
      const style = typeof cell?.s === "string" ? disk.styles?.[cell.s] : cell?.s;
      expect(style).toMatchObject({ n: { pattern: "#,##0" } });
      const percent = disk.sheets.s0?.cellData?.[16]?.[5];
      expect(percent?.f).toBe("=C17/D17");
      expect(percent?.v).toBeCloseTo(123456 / 20012, 6);
      const percentStyle = typeof percent?.s === "string" ? disk.styles?.[percent.s] : percent?.s;
      expect(percentStyle).toMatchObject({ n: { pattern: "0.0%" } });
    } finally {
      beforeRender.resolve();
      beforeFix.resolve();
      ws.close();
    }
  }, 60_000);

  test("空工作簿创建、错误纠正、结构修改与即时回读贯通 HTTP/WS/SQLite，重启仍一致", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-empty-workbook-"));
    dirs.push(dataDir);
    const path = "空工作簿.xlsx";
    const calls = [
      {
        name: "workbook_edit",
        args: { path, create: true, ops: [{ op: "sheet.add", name: "Sheet1" }] },
      },
      { name: "workbook_edit", args: { path, create: true, ops: [] } },
      { name: "workbook_read", args: { path, mode: "overview" } },
      {
        name: "workbook_edit",
        args: {
          path,
          ops: [
            { op: "sheet.rename", sheet: "Sheet1", name: "空白" },
            { op: "sheet.add", name: "临时1" },
            { op: "sheet.add", name: "临时2" },
            { op: "cells.set", range: "空白!A1:B1", values: [[1, "=A1+1"]] },
            { op: "cells.set", range: "空白!A1", values: [[2]] },
          ],
        },
      },
      { name: "workbook_read", args: { path, mode: "overview" } },
      {
        name: "workbook_edit",
        args: {
          path,
          ops: [
            { op: "cells.clear", range: "空白!A1:B1", what: "contents" },
            { op: "sheet.delete", sheet: "临时1" },
            { op: "sheet.delete", sheet: "临时2" },
          ],
        },
      },
      { name: "workbook_read", args: { path, mode: "overview" } },
      { name: "workbook_edit", args: { path, ops: [{ op: "sheet.delete", sheet: "空白" }] } },
      { name: "workbook_edit", args: { path, ops: [] } },
      { name: "workbook_edit", args: { path: "预览.xlsx", create: true, dryRun: true, ops: [] } },
    ];
    let step = 0;
    const model = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-empty",
      doStream: async () => {
        const call = calls[step++];
        return {
          stream: streamOf(
            call
              ? toolCall(`empty-${step}`, call.name, JSON.stringify(call.args))
              : [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "done" },
                  { type: "text-delta", id: "done", delta: "已完成空工作簿操作。" },
                  { type: "text-end", id: "done" },
                  { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
                ],
          ),
        };
      },
    });
    const srv = await startServer({ dataDir, resolveLanguageModel: () => model, log: () => {} });
    servers.push(srv);
    const api = createApiClient(srv.url, srv.token);
    await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock-empty",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    const { ticket } = await api.createTicket();
    const ws = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    await ws.waitFor((m) => m.type === "hello", "hello");
    ws.send({ type: "sub", topic: `session:${session.id}`, cursor: 0 });
    await ws.waitFor((m) => m.type === "sub.ok", "sub.ok");
    await api.sendMessage(session.id, "main", { clientMessageId: "empty", text: "生成空工作簿" });
    await ws.waitFor(
      (m) => m.type === "rec" && m.record.type === "change.summary",
      "change.summary",
    );
    const records = ws.msgs.flatMap((m) => (m.type === "rec" ? [m.record] : []));
    const result = (n: number) =>
      records.find((r) => r.type === "tool.result" && r.data.toolCallId === `empty-${n}`)?.data
        .result as {
        status: string;
        error?: { code: string; hint?: string };
        data: Record<string, unknown>;
      };
    expect(result(1).status).toBe("error");
    expect(result(1).error?.hint).toContain("ops=[]");
    expect(result(2)).toMatchObject({
      status: "ok",
      data: {
        created: true,
        sheets: [{ name: "Sheet1", cells: 0, formulas: 0 }],
        changes: { cellsBySheet: {}, ranges: [], structural: ["新增工作表（Sheet1）"] },
      },
    });
    const docId = result(2).data.docId as string;
    expect(result(2).data.docRevs).toEqual({ [docId]: 1 });
    expect(result(3)).toMatchObject({
      status: "ok",
      data: { sheets: [{ name: "Sheet1", cells: 0, formulas: 0 }] },
    });
    expect(result(4).data.changes).toMatchObject({ cellsBySheet: { 空白: 2 } });
    expect(result(5).data.sheets).toEqual([
      expect.objectContaining({ name: "空白", cells: 2, formulas: 1 }),
      expect.objectContaining({ name: "临时1", cells: 0 }),
      expect.objectContaining({ name: "临时2", cells: 0 }),
    ]);
    expect(result(6).data.changes).toEqual({
      cellsBySheet: { 空白: 2 },
      ranges: ["'空白'!A1:B1"],
      structural: ["删除工作表（临时1）", "删除工作表（临时2）"],
      added: [],
    });
    expect(result(7)).toMatchObject({
      status: "ok",
      data: { sheets: [{ name: "空白", cells: 0, formulas: 0 }], docRevs: { [docId]: 3 } },
    });
    expect(result(8).status).toBe("error");
    expect(result(9).error?.code).toBe("INVALID_ARGUMENT");
    expect(result(10)).toMatchObject({
      status: "ok",
      data: { dryRun: true, created: true, sheets: [{ name: "Sheet1", cells: 0 }] },
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(srv.workspaceRoot, "预览.xlsx"))).toBe(false);
    const summary = records.find((r) => r.type === "change.summary")?.data.changes as {
      docs: { cellsBySheet: unknown; structural: string[]; revs: number[] }[];
    };
    expect(summary.docs[0]).toMatchObject({ cellsBySheet: { 空白: 2 }, revs: [1, 2, 3] });
    expect(summary.docs[0]?.structural).toContain("删除工作表（临时1）");
    ws.send({ type: "sub", topic: `doc:${docId}`, cursor: 0 });
    await ws.waitFor(
      (m) =>
        m.type === "doc.op" && m.rev === 3 && (!m.chunk || m.chunk.index === m.chunk.total - 1),
      "replay rev3",
    );
    expect([...new Set(ws.msgs.filter((m) => m.type === "doc.op").map((m) => m.rev))]).toEqual([
      1, 2, 3,
    ]);
    const verifyDb = new DatabaseSync(join(dataDir, "excelmanus.db"));
    expect(
      verifyDb.prepare("SELECT COUNT(*) AS n FROM doc_ops WHERE doc_id=?").get(docId),
    ).toMatchObject({ n: 3 });
    expect(
      verifyDb.prepare("SELECT COUNT(*) AS n FROM documents WHERE path='预览.xlsx'").get(),
    ).toMatchObject({ n: 0 });
    expect(
      verifyDb
        .prepare("SELECT COUNT(*) AS n FROM backups WHERE kind='backup' AND original_path=?")
        .get(path),
    ).toMatchObject({ n: 0 });
    verifyDb.close();
    ws.close();
    await srv.close();
    servers.splice(servers.indexOf(srv), 1);
    const disk = importXlsx(readFileSync(join(srv.workspaceRoot, path)), path);
    expect(disk.snapshot.sheetOrder.length).toBe(1);
    expect(disk.snapshot.sheets.s0?.name).toBe("空白");
    expect(disk.cellCounts["空白"]).toBe(0);
    const restarted = await startServer({
      dataDir,
      resolveLanguageModel: () => model,
      log: () => {},
    });
    servers.push(restarted);
    const api2 = createApiClient(restarted.url, restarted.token);
    const { snapshot, document } = await api2.getDocSnapshot(session.workspaceId, docId);
    expect(document.rev).toBe(3);
    const restored = snapshot as {
      sheetOrder: string[];
      sheets: Record<string, { name: string; cellData: unknown }>;
    };
    expect(restored.sheetOrder.length).toBe(1);
    expect(restored.sheets[restored.sheetOrder[0] ?? ""]?.name).toBe("空白");
    expect(restored.sheets[restored.sheetOrder[0] ?? ""]?.cellData).toEqual({});
  }, 60_000);

  test("代理写文档 → doc.op 广播 → doc.submit 冲突/续传", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-e2e-doc-"));
    dirs.push(dataDir);
    const srv = await startServer({
      dataDir,
      retryBaseMs: 10,
      resolveLanguageModel: () => makeDocMockModel(),
      log: () => {},
    });
    servers.push(srv);
    copyFileSync(SAMPLE_XLSX, join(srv.workspaceRoot, "sales.xlsx"));

    const api = createApiClient(srv.url, srv.token);
    await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock-doc",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "sk-test-1234",
    });
    const { session } = await api.createSession({});
    const wsId = session.workspaceId;

    // REST 打开文档（rev 0）
    const { document } = await api.openDoc(wsId, { path: "sales.xlsx" });
    const docId = document.id;

    // 文档订阅客户端
    const { ticket } = await api.createTicket();
    const wsDoc = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    await wsDoc.waitFor((m) => m.type === "hello", "hello");
    wsDoc.send({ type: "sub", topic: `doc:${docId}`, cursor: 0 });
    await wsDoc.waitFor((m) => m.type === "sub.ok" && m.topic === `doc:${docId}`, "doc sub.ok");

    // 会话客户端
    const { ticket: t2 } = await api.createTicket();
    const wsSess = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${t2}`);
    await wsSess.waitFor((m) => m.type === "hello", "hello2");
    wsSess.send({ type: "sub", topic: `session:${session.id}`, cursor: 0 });

    // 发消息：read → edit → done
    await api.sendMessage(session.id, "main", {
      clientMessageId: "m1",
      text: "在 D2 写入 e2e写入",
    });
    await wsSess.waitFor(
      (m) =>
        m.type === "rec" &&
        (m as RecMsg).record.type === "tool.result" &&
        ((m as RecMsg).record.data as { toolCallId?: string }).toolCallId === "tc-edit",
      "edit tool.result",
    );
    await wsSess.waitFor(
      (m) => m.type === "rec" && (m as RecMsg).record.type === "turn.completed",
      "turn.completed",
    );

    // 11 §3.4：执行期间推 workbook_activity 瞬时增量（start/end），读与写分别带区域
    const activity = wsSess.msgs.filter(
      (m) => m.type === "delta" && (m as { kind?: string }).kind === "workbook_activity",
    ) as unknown as {
      payload: {
        phase: string;
        toolCallId: string;
        kind?: string;
        ranges?: string[];
        path?: string;
      };
    }[];
    const editStart = activity.find(
      (m) => m.payload.toolCallId === "tc-edit" && m.payload.phase === "start",
    );
    expect(editStart?.payload).toMatchObject({
      kind: "write",
      path: "sales.xlsx",
      ranges: ["销售!D2"],
    });
    expect(
      activity.some((m) => m.payload.toolCallId === "tc-edit" && m.payload.phase === "end"),
    ).toBe(true);
    expect(
      activity.find((m) => m.payload.toolCallId === "tc-read" && m.payload.phase === "start")
        ?.payload,
    ).toMatchObject({ kind: "read", ranges: [] });
    // 瞬时增量不入日志
    const log = await api.getSessionLog(session.id, { limit: 500 });
    expect(JSON.stringify(log).includes("workbook_activity")).toBe(false);
    // tool.result 带执行耗时（不含审批等待）
    const editResult = wsSess.msgs.find(
      (m) =>
        m.type === "rec" &&
        (m as RecMsg).record.type === "tool.result" &&
        ((m as RecMsg).record.data as { toolCallId?: string }).toolCallId === "tc-edit",
    ) as RecMsg;
    expect(typeof (editResult.record.data as { durationMs?: unknown }).durationMs).toBe("number");
    // 07 §7.4：修订 1 的修改前的值来自逆操作，等于原文件 D2
    const orig = importXlsx(readFileSync(SAMPLE_XLSX), "sales.xlsx").snapshot.sheets.s0
      ?.cellData?.[1]?.[3]?.v;
    const before = await api.getDocRevBefore(wsId, docId, 1);
    expect(before.cells).toEqual([
      expect.objectContaining({ sheet: "销售", row: 1, col: 3, value: orig ?? null }),
    ]);

    // 文档客户端收到 doc.op rev=1
    const op1 = (await wsDoc.waitFor(
      (m) => m.type === "doc.op" && (m as { rev?: number }).rev === 1,
      "doc.op rev1",
    )) as { mutations: Array<{ id: string; params: { unitId: string; subUnitId: string } }> };
    expect(op1.mutations.length).toBeGreaterThan(0);
    const first = op1.mutations[0];
    if (first === undefined) throw new Error("doc.op 无 mutation");
    const { unitId, subUnitId } = first.params;

    // M2b: await the real debounce checkpoint, then verify disk and backup from SQLite.
    await wsDoc.waitFor(
      (m) => m.type === "doc.checkpoint" && m.checkpointRev === 1,
      "checkpoint rev1",
    );
    const disk = importXlsx(readFileSync(join(srv.workspaceRoot, "sales.xlsx")), "sales.xlsx");
    expect(disk.snapshot.sheets.s0?.cellData?.[1]?.[3]?.v).toBe("e2e写入");
    const verifyDb = new DatabaseSync(join(dataDir, "excelmanus.db"));
    try {
      const backup = verifyDb
        .prepare(
          "SELECT backup_path FROM backups WHERE kind='backup' AND original_path='sales.xlsx'",
        )
        .get() as { backup_path: string };
      expect(readFileSync(join(srv.workspaceRoot, backup.backup_path))).toEqual(
        readFileSync(SAMPLE_XLSX),
      );
      expect(
        verifyDb.prepare("SELECT checkpoint_rev FROM documents WHERE id=?").get(docId),
      ).toMatchObject({ checkpoint_rev: 1 });
    } finally {
      verifyDb.close();
    }

    // baseRev=0 写同一格 D2 → reject
    wsDoc.send({
      type: "doc.submit",
      docId,
      clientOpId: "c1",
      baseRev: 0,
      mutations: [
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId,
            subUnitId,
            trigger: "sheet.command.set-range-values",
            cellValue: { 1: { 3: { v: "冲突写" } } },
          },
        },
      ],
    });
    const reject = (await wsDoc.waitFor((m) => m.type === "doc.reject", "doc.reject")) as {
      clientOpId: string;
      conflict: { code: string };
    };
    expect(reject.clientOpId).toBe("c1");
    expect(reject.conflict.code).toBe("VERSION_CONFLICT");

    // baseRev=0 写不重叠的 A11 → ack rev=2，且广播 doc.op rev=2
    wsDoc.send({
      type: "doc.submit",
      docId,
      clientOpId: "c2",
      baseRev: 0,
      mutations: [
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId,
            subUnitId,
            trigger: "sheet.command.set-range-values",
            cellValue: { 10: { 0: { v: "另一处" } } },
          },
        },
      ],
    });
    const ack = (await wsDoc.waitFor((m) => m.type === "doc.ack", "doc.ack")) as {
      clientOpId: string;
      rev: number;
    };
    expect(ack).toMatchObject({ clientOpId: "c2", rev: 2 });
    await wsDoc.waitFor(
      (m) => m.type === "doc.op" && (m as { rev?: number }).rev === 2,
      "doc.op rev2",
    );

    // 断开后 cursor=1 重订阅：只补发 rev=2
    wsDoc.close();
    const { ticket: t3 } = await api.createTicket();
    const wsDoc2 = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${t3}`);
    await wsDoc2.waitFor((m) => m.type === "hello", "hello3");
    wsDoc2.send({ type: "sub", topic: `doc:${docId}`, cursor: 1 });
    await wsDoc2.waitFor((m) => m.type === "sub.ok" && m.topic === `doc:${docId}`, "resub ok");
    await wsDoc2.waitFor((m) => m.type === "doc.op", "replay op");
    const ops = wsDoc2.msgs.filter((m) => m.type === "doc.op") as { rev: number }[];
    expect(ops.map((o) => o.rev)).toEqual([2]);
    await wsDoc2.waitFor(
      (m) => m.type === "doc.checkpoint" && m.checkpointRev === 2,
      "checkpoint rev2",
    );
    wsDoc2.close();
    wsSess.close();
    // A fresh server opens the checkpoint and preserves document ids/revision without duplicating writes.
    await srv.close();
    servers.splice(servers.indexOf(srv), 1);
    const restarted = await startServer({
      dataDir,
      resolveLanguageModel: () => makeDocMockModel(),
      log: () => {},
    });
    servers.push(restarted);
    const snap = await createApiClient(restarted.url, restarted.token).getDocSnapshot(wsId, docId);
    expect(snap.document.rev).toBe(2);
    expect(snap.document.checkpointRev).toBe(2);
    expect(
      (
        snap.snapshot as {
          sheets: Record<string, { cellData: Record<number, Record<number, { v: unknown }>> }>;
        }
      ).sheets[subUnitId]?.cellData[10]?.[0]?.v,
    ).toBe("另一处");
  }, 30_000);
});
