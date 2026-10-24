// 第 7 类：客户端断线，不是模型断流或后端重启。只替代模型输出，
// 消息、运行时、工作簿写入、检查点、WS 续传和 SQLite 均走真实实现。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient, type RecMsg, type ServerMessage } from "@excelmanus/protocol";
import { importCsv, importXlsx } from "@excelmanus/workbook";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { minimalXlsx } from "../../modules/workbook/src/checkpoint.ts";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const waitOptions = { timeout: 10_000, interval: 10 };

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function toolOutput(id: string, toolName: string, args: unknown) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({
          type: "tool-call",
          toolCallId: id,
          toolName,
          input: JSON.stringify(args),
        });
        controller.enqueue({
          type: "finish",
          usage,
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
        });
        controller.close();
      },
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected an object in the provider-visible tool result");
  return value as Record<string, unknown>;
}

function visibleToolResult(
  prompt: readonly { role: string; content: unknown }[],
  toolCallId: string,
): Record<string, unknown> {
  for (const message of prompt) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      const part = record(item);
      if (part.type !== "tool-result" || part.toolCallId !== toolCallId) continue;
      const output = record(part.output);
      if (output.type !== "json") throw new Error("expected a successful JSON tool result");
      return record(output.value);
    }
  }
  throw new Error(`inspect result is not visible to the provider: ${toolCallId}`);
}

class RecoveryClient {
  readonly messages: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(message);
      if (message.type === "ping") this.send({ type: "pong" });
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    const client = new RecoveryClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  records() {
    return this.messages.filter((message): message is RecMsg => message.type === "rec");
  }

  async disconnect() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.terminate();
    await closed;
  }
}

test("写后客户端断线不停止任务，游标重连与同消息重发不重复插行或写文件", async () => {
  // 若 WS close 停止 actor、消息去重重新 enqueue，或 replay 丢失/重复记录，
  // 此测试将分别在运行状态、单次非幂等插行、日志逐条对齐处失败。
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-session-recovery-"));
  const afterWrite = gate();
  const finish = gate();
  const clients: RecoveryClient[] = [];
  let server: RunningServer | undefined;
  let db: DatabaseSync | undefined;
  let step = 0;
  let awaitingAfterWrite = false;
  let awaitingFinish = false;
  const filename = "client-recovery.xlsx";
  const editId = "client-recovery-edit";
  const prefix = "已插入一行，";
  const suffix = "原有内容已保留。";
  const reasoningPrefix = "正在整理已保存结果，未验证事项仍保留。";
  const inspectId = "client-recovery-inspect";
  const finalizeId = "client-recovery-finalize";
  const expectNoDraftText = (messages: readonly ServerMessage[]) => {
    for (const message of messages) {
      let displayedText = "";
      if (message.type === "snapshot") displayedText = message.text;
      if (message.type === "delta" && message.kind === "text" && typeof message.payload === "string")
        displayedText = message.payload;
      if (message.type === "rec" && message.record.type === "model.output") {
        const text = message.record.data.text;
        if (typeof text === "string") displayedText = text;
      }
      expect(displayedText).not.toContain(prefix);
      expect(displayedText).not.toContain(suffix);
    }
  };
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "client-recovery",
    doStream: async (opts) => {
      step++;
      if (step === 1)
        return toolOutput("client-recovery-read", "workbook_read", {
          path: filename,
          mode: "range",
          range: "Sheet1!A1:B3",
        });
      if (step === 2)
        return toolOutput(editId, "workbook_edit", {
          path: filename,
          ops: [
            { op: "rows.insert", sheet: "Sheet1", at: 2, count: 1 },
            { op: "cells.set", range: "Sheet1!A2", values: [["applied-once"]] },
          ],
        });
      if (step === 3) {
        awaitingAfterWrite = true;
        await afterWrite.promise;
        return toolOutput("client-recovery-verify", "workbook_read", {
          path: filename,
          mode: "range",
          range: "Sheet1!A1:B4",
        });
      }
      if (step === 5) return toolOutput(inspectId, "deliver", { action: "inspect" });
      if (step === 6) {
        // Handles come only from the actual model prompt, never the test's SQLite probes.
        const inspected = visibleToolResult(opts.prompt, inspectId);
        expect(inspected.status).toBe("ok");
        const data = record(inspected.data);
        expect(data.action).toBe("inspect");
        expect(data.allowedOutcomes).toContain("partial");
        expect(data.allowedOutcomes).not.toContain("completed");
        expect(data.unverifiedObligationCount).toBeGreaterThan(0);
        if (!Array.isArray(data.artifacts)) throw new Error("missing visible artifact directory");
        const artifacts = data.artifacts.map(record).filter((artifact) => artifact.path === filename);
        expect(artifacts).toHaveLength(1);
        const artifact = artifacts[0]!;
        expect(artifact).toMatchObject({
          path: filename, execution: "succeeded", persistence: "saved", validation: "unverified",
        });
        if (typeof artifact.id !== "string") throw new Error("missing inspected artifact handle");
        return toolOutput(finalizeId, "deliver", {
          action: "finalize", outcome: "partial", artifactIds: [artifact.id],
        });
      }
      if (step !== 4) throw new Error("客户端重连不应启动计划外的模型步骤");
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "reasoning-start", id: "recovery-reasoning" });
            controller.enqueue({ type: "reasoning-delta", id: "recovery-reasoning", delta: reasoningPrefix });
            controller.enqueue({ type: "text-start", id: "reply" });
            controller.enqueue({ type: "text-delta", id: "reply", delta: prefix });
            awaitingFinish = true;
            // 流正常保持打开；客户端断开不能 abort 该请求，也不调用 stop/resume。
            await finish.promise;
            controller.enqueue({ type: "text-delta", id: "reply", delta: suffix });
            controller.enqueue({ type: "text-end", id: "reply" });
            controller.enqueue({ type: "reasoning-end", id: "recovery-reasoning" });
            controller.enqueue({
              type: "finish",
              usage,
              finishReason: { unified: "stop", raw: "stop" },
            });
            controller.close();
          },
        }),
      };
    },
  });

  try {
    server = await startServer({ dataDir, resolveLanguageModel: () => model, log: () => {} });
    const srv = server;
    const api = createApiClient(srv.url, srv.token);
    await createTestProfile(api, {
      name: "客户端恢复隔离测试",
      provider: "custom-openai-compatible",
      model: "client-recovery",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    const file = join(srv.workspaceRoot, filename);
    const original = minimalXlsx(
      importCsv(
        new TextEncoder().encode("marker,keep\noriginal-one,untouched-one\ntail,untouched-tail\n"),
        "client-recovery.csv",
      ).snapshot,
    );
    writeFileSync(file, original);
    const { document } = await api.openDoc(session.workspaceId, { path: filename });
    db = new DatabaseSync(join(dataDir, "excelmanus.db"), { readOnly: true });
    const probe = db;
    const docState = () =>
      probe
        .prepare("SELECT rev, head_rev, checkpoint_rev FROM documents WHERE id = ?")
        .get(document.id);
    const docOps = () =>
      probe
        .prepare(
          "SELECT rev, source_kind, session_id, tool_call_id FROM doc_ops WHERE doc_id = ? ORDER BY rev",
        )
        .all(document.id);
    const backups = () =>
      probe
        .prepare(
          "SELECT backup_path FROM backups WHERE session_id = ? AND original_path = ? AND kind = 'backup'",
        )
        .all(session.id, filename);
    const connect = async () => {
      const { ticket } = await api.createTicket();
      const client = await RecoveryClient.connect(
        `ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`,
      );
      clients.push(client);
      return client;
    };
    const first = await connect();
    first.send({ type: "sub", topic: `session:${session.id}`, cursor: 0 });
    first.send({ type: "sub", topic: `doc:${document.id}`, cursor: 0 });
    await vi.waitFor(
      () => expect(first.messages.filter((m) => m.type === "sub.ok")).toHaveLength(2),
      waitOptions,
    );
    const body = {
      clientMessageId: "client-recovery-message",
      text: "在第 2 行前插入一行并写入 applied-once，保留原有内容",
    };
    const accepted = await api.sendMessage(session.id, "main", body);
    expect(accepted.deduplicated).toBe(false);
    await vi.waitFor(() => {
      expect(awaitingAfterWrite).toBe(true);
      expect(
        first
          .records()
          .some((m) => m.record.type === "tool.result" && m.record.data.toolCallId === editId),
      ).toBe(true);
      expect(first.messages.some((m) => m.type === "doc.op" && m.rev === 1)).toBe(true);
    }, waitOptions);
    const cursor = Math.max(...first.records().map((m) => m.seq));
    const docCursor = 1;
    await first.disconnect();
    expect(srv.hasRunningAgents()).toBe(true);
    expect((await api.getSession(session.id)).agents[0]?.status).toBe("running");

    // 没有业务 WS 客户端时继续真实只读核对与流式思考；自由终稿仍受交付门控。
    afterWrite.open();
    await vi.waitFor(async () => {
      expect(awaitingFinish).toBe(true);
      const { items } = await api.getSessionLog(session.id, { limit: 500 });
      expect(
        items.some(
          (r) => r.type === "tool.result" && r.data.toolCallId === "client-recovery-verify",
        ),
      ).toBe(true);
      expect(
        items.some(
          (r) =>
            r.type === "turn.completed" ||
            r.type === "turn.interrupted" ||
            r.type === "turn.failed",
        ),
      ).toBe(false);
      expect(docState()).toMatchObject({ rev: 1, head_rev: 1, checkpoint_rev: 1 });
    }, waitOptions);
    expect(srv.hasRunningAgents()).toBe(true);
    const committed = readFileSync(file);
    const disk = importXlsx(committed, filename).snapshot;
    const sheet = disk.sheets[disk.sheetOrder[0] ?? ""];
    expect([0, 1, 2, 3].map((r) => sheet?.cellData?.[r]?.[0]?.v)).toEqual([
      "marker",
      "applied-once",
      "original-one",
      "tail",
    ]);
    expect([0, 1, 2, 3].map((r) => sheet?.cellData?.[r]?.[1]?.v)).toEqual([
      "keep",
      undefined,
      "untouched-one",
      "untouched-tail",
    ]);
    expect(docOps()).toEqual([
      { rev: 1, source_kind: "agent", session_id: session.id, tool_call_id: editId },
    ]);
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(srv.workspaceRoot, String(backups()[0]?.backup_path)))).toEqual(
      Buffer.from(original),
    );

    // 新建 HTTP/WS 客户端，原消息键与原游标恢复；不是原连接的内存重用。
    const refreshedApi = createApiClient(srv.url, srv.token);
    const retry = await refreshedApi.sendMessage(session.id, "main", body);
    expect(retry).toMatchObject({ deduplicated: true, dispatch: { id: accepted.dispatch.id } });
    const reconnected = await connect();
    reconnected.send({ type: "sub", topic: `session:${session.id}`, cursor });
    reconnected.send({ type: "sub", topic: `doc:${document.id}`, cursor: docCursor });
    const offlineLog = (await refreshedApi.getSessionLog(session.id, { limit: 500 })).items;
    const missed = offlineLog.filter((r) => r.seq > cursor);
    expect(
      missed.some(
        (r) => r.type === "tool.result" && r.data.toolCallId === "client-recovery-verify",
      ),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(reconnected.records().map((m) => m.record)).toEqual(missed);
      expect(
        reconnected.messages.some(
          (m) => m.type === "snapshot" && m.reasoning === reasoningPrefix && m.text === "",
        ),
      ).toBe(true);
      expectNoDraftText(reconnected.messages);
      expect(reconnected.messages.filter((m) => m.type === "sub.ok")).toHaveLength(2);
    }, waitOptions);
    expect(reconnected.messages.filter((m) => m.type === "doc.op")).toHaveLength(0);
    const snapshot = await refreshedApi.getDocSnapshot(session.workspaceId, document.id);
    expect(snapshot.document).toMatchObject({ rev: 1, checkpointRev: 1 });
    expect(snapshot.document.checkpointError).toBeUndefined();
    const restored = snapshot.snapshot as unknown as ReturnType<typeof importXlsx>["snapshot"];
    const restoredSheet = restored.sheets[restored.sheetOrder[0] ?? ""];
    expect(
      [0, 1, 2, 3].map((r) => [
        restoredSheet?.cellData?.[r]?.[0]?.v,
        restoredSheet?.cellData?.[r]?.[1]?.v,
      ]),
    ).toEqual(
      [0, 1, 2, 3].map((r) => [sheet?.cellData?.[r]?.[0]?.v, sheet?.cellData?.[r]?.[1]?.v]),
    );

    finish.open();
    await vi.waitFor(async () => {
      expect(srv.hasRunningAgents()).toBe(false);
      const all = (await refreshedApi.getSessionLog(session.id, { limit: 500 })).items;
      expect(all.filter((r) => r.type === "turn.completed")).toHaveLength(1);
      expect(reconnected.records().map((m) => m.record)).toEqual(all.filter((r) => r.seq > cursor));
    }, waitOptions);
    const completed = (await refreshedApi.getSessionLog(session.id, { limit: 500 })).items;
    expect(completed.filter((r) => r.type === "user.message")).toHaveLength(1);
    expect(completed.filter((r) => r.type === "turn.started")).toHaveLength(1);
    expect(
      completed.filter((r) =>
        ["turn.failed", "turn.interrupted", "retry.scheduled"].includes(r.type),
      ),
    ).toHaveLength(0);
    for (const type of ["tool.intent", "tool.result"]) {
      expect(completed.filter((r) => r.type === type && r.data.toolCallId === editId)).toHaveLength(
        1,
      );
    }
    expect(
      completed.find((r) => r.type === "tool.result" && r.data.toolCallId === editId)?.data,
    ).toMatchObject({
      status: "ok",
      result: { status: "ok", data: { docRevs: { [document.id]: 1 } } },
    });
    // The draft is recorded as withheld, never rendered as a successful final reply.
    expect(
      completed.filter((r) => r.type === "model.output" && r.data.withheldText === prefix + suffix),
    ).toHaveLength(1);
    expect(
      completed.filter((r) => r.type === "model.output" && r.data.deliveryStatus === "rejected"),
    ).toHaveLength(1);
    const delivered = completed.find(
      (r) => r.type === "tool.result" && r.data.toolCallId === finalizeId,
    );
    expect(delivered?.data).toMatchObject({
      status: "ok",
      result: { status: "ok", data: { outcome: "partial", finalizationStatus: "incomplete" } },
    });
    const finalOutputs = completed.filter(
      (r) => r.type === "model.output" && r.data.sourceToolCallId === finalizeId,
    );
    expect(finalOutputs).toHaveLength(1);
    expect(completed.filter((r) => r.type === "model.output").at(-1)).toEqual(finalOutputs[0]);
    expect(finalOutputs[0]?.data).toMatchObject({ deliveryStatus: "incomplete", text: expect.any(String) });
    for (const toolCallId of [inspectId, finalizeId])
      for (const type of ["tool.intent", "tool.result"])
        expect(completed.filter((r) => r.type === type && r.data.toolCallId === toolCallId)).toHaveLength(1);
    expect(new Set(reconnected.records().map((r) => r.seq)).size).toBe(
      reconnected.records().length,
    );
    expect(
      probe
        .prepare("SELECT id, status FROM dispatches WHERE session_id = ? AND client_message_id = ?")
        .all(session.id, body.clientMessageId),
    ).toEqual([{ id: accepted.dispatch.id, status: "applied" }]);
    expect(
      probe.prepare("SELECT tool_call_id FROM open_intents WHERE session_id = ?").all(session.id),
    ).toEqual([]);
    expect((await refreshedApi.getSession(session.id)).agents[0]?.status).toBe("idle");

    // 终态的重复发送及第二次重订阅也不能新增轮次、修订或检查点文件写入。
    expect(await refreshedApi.sendMessage(session.id, "main", body)).toMatchObject({
      deduplicated: true,
      dispatch: { id: accepted.dispatch.id },
    });
    await reconnected.disconnect();
    const finalClient = await connect();
    finalClient.send({ type: "sub", topic: `session:${session.id}`, cursor: 0 });
    finalClient.send({ type: "ping" });
    await vi.waitFor(() => {
      expect(finalClient.records().map((m) => m.record)).toEqual(completed);
      // pong 在同步的历史回放/snapshot 帧之后，避免过早检查“无旧 snapshot”。
      expect(finalClient.messages.some((m) => m.type === "pong")).toBe(true);
    }, waitOptions);
    expect(finalClient.messages.filter((m) => m.type === "snapshot")).toHaveLength(0);
    expect((await refreshedApi.getSessionLog(session.id, { limit: 500 })).items).toEqual(completed);
    expect(docState()).toMatchObject({ rev: 1, head_rev: 1, checkpoint_rev: 1 });
    expect(docOps()).toHaveLength(1);
    expect(backups()).toHaveLength(1);
    expect(readFileSync(file)).toEqual(committed);
    for (const client of clients) expectNoDraftText(client.messages);
    expect(step).toBe(6);
  } finally {
    afterWrite.open();
    finish.open();
    for (const client of clients) await client.disconnect();
    await server?.close();
    db?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 25_000);
