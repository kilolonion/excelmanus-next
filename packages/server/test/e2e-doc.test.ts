// M2a 活文档同步 e2e：假模型走 workbook_read → workbook_edit（真实 HTTP/WS/SQLite），
// 另一个 WS 客户端订阅 doc:<id> 收 doc.op、doc.submit 冲突与续传。

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createApiClient, type RecMsg, type ServerMessage } from "@excelmanus/protocol";
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
    await api.createModelProfile({
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

    // 文档客户端收到 doc.op rev=1
    const op1 = (await wsDoc.waitFor(
      (m) => m.type === "doc.op" && (m as { rev?: number }).rev === 1,
      "doc.op rev1",
    )) as { mutations: Array<{ id: string; params: { unitId: string; subUnitId: string } }> };
    expect(op1.mutations.length).toBeGreaterThan(0);
    const first = op1.mutations[0];
    if (first === undefined) throw new Error("doc.op 无 mutation");
    const { unitId, subUnitId } = first.params;

    // baseRev=0 写同一格 D2 → reject
    wsDoc.send({
      type: "doc.submit",
      docId,
      clientOpId: "c1",
      baseRev: 0,
      mutations: [
        {
          id: "sheet.mutation.set-range-values",
          params: { unitId, subUnitId, cellValue: { 1: { 3: { v: "冲突写" } } } },
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
          params: { unitId, subUnitId, cellValue: { 10: { 0: { v: "另一处" } } } },
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
    wsDoc2.close();
  });
});
