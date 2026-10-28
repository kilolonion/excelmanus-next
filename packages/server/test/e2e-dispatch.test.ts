import { createTestProfile } from "./fixtures/create-model.ts";
// M3 消息派发三策略集成测试（04 §4.1–4.3、§8.3，14 场景 8；ADR 0006：
// 真实 HTTP/WebSocket/SQLite 文件 + MockLanguageModelV4 只替代模型输出）。
// 假模型用可控 gate 卡住 doStream，记录每次调用的 prompt 以断言注入时机。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { kernelProjections, SessionLog } from "@excelmanus/kernel";
import {
  type ApiClient,
  createApiClient,
  type LogRecord,
  type RecMsg,
  type ServerMessage,
} from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function streamOf(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

type Prompt = Array<{ role: string; content: unknown }>;
type ModelOut = { stream: ReadableStream<LanguageModelV4StreamPart> };

const textOut = (text: string, id = "t1"): ModelOut => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ]),
});

const toolCallOut = (toolCallId: string, toolName: string, input: string): ModelOut => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input },
    { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
  ]),
});

/** 外部可控闸门：doStream 内 await，测试里 resolve 放行。 */
class Gate {
  readonly promise: Promise<void>;
  private release!: () => void;
  constructor() {
    this.promise = new Promise((r) => {
      this.release = r;
    });
  }
  open(): void {
    this.release();
  }
}

type CallHandler = (prompt: Prompt) => Promise<ModelOut> | ModelOut;

/** 记录每次模型调用 prompt，并按调用序号分派给 handlers。 */
function makeGatedModel(
  handlers: CallHandler[],
  calls: Prompt[] = [],
): {
  model: MockLanguageModelV4;
  calls: Prompt[];
} {
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-dispatch",
    doStream: async (opts) => {
      const prompt = [...(opts.prompt as Prompt)];
      calls.push(prompt);
      const handler = handlers[calls.length - 1] ?? (() => textOut("…"));
      return handler(prompt);
    },
  });
  return { model, calls };
}

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const parts = m.content as Array<{ type: string; text?: string }>;
    return parts.map((p) => p.text ?? "").join("");
  }
  return "";
}

/** prompt 中所有 user 消息拼接（断言某消息是否进入过模型上下文）。 */
function allUserText(prompt: Prompt): string {
  return prompt
    .filter((m) => m?.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join(""),
    )
    .join("\n");
}

const servers: RunningServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function boot(
  handlers: CallHandler[],
  opts: { permissionMode?: "standard" | "confirm"; calls?: Prompt[] } = {},
): Promise<{ srv: RunningServer; api: ApiClient; sessionId: string; calls: Prompt[] }> {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-dispatch-"));
  dirs.push(dataDir);
  const calls = opts.calls ?? [];
  const srv = await startServer({
    dataDir,
    retryBaseMs: 10,
    resolveLanguageModel: () => makeGatedModel(handlers, calls).model,
    log: () => {},
  });
  servers.push(srv);
  const api = createApiClient(srv.url, srv.token);
  await createTestProfile(api, {
    name: "mock",
    provider: "custom-openai-compatible",
    model: "mock-dispatch",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "test",
  });
  const { session } = await api.createSession(
    opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {},
  );
  return { srv, api, sessionId: session.id, calls };
}

/** 轮询会话日志直到谓词命中；返回最新日志快照。 */
async function waitLog(
  api: ApiClient,
  sessionId: string,
  pred: (items: LogRecord[]) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<LogRecord[]> {
  const t0 = Date.now();
  for (;;) {
    const { items } = await api.getSessionLog(sessionId, { limit: 500 });
    if (pred(items)) return items;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待超时：${what}；types=${JSON.stringify(items.map((i) => i.type))}`);
    }
    await sleep(20);
  }
}

const dispatchStatus = (items: LogRecord[], dispatchId: string): string | undefined => {
  let status: string | undefined;
  for (const r of items) {
    if (r.type === "dispatch.updated" && r.data.dispatchId === dispatchId) {
      status = String(r.data.status);
    }
  }
  return status;
};

class TestWs {
  readonly msgs: ServerMessage[] = [];
  private ws!: WebSocket;
  private constructor() {}

  static async connect(url: string): Promise<TestWs> {
    const c = new TestWs();
    c.ws = new WebSocket(url);
    c.ws.on("message", (data) => {
      c.msgs.push(JSON.parse(String(data)) as ServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once("open", () => resolve());
      c.ws.once("error", reject);
    });
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  recs(): RecMsg[] {
    return this.msgs.filter((m): m is RecMsg => m.type === "rec");
  }

  async waitFor(pred: (m: ServerMessage) => boolean, what: string, timeoutMs = 15_000) {
    const t0 = Date.now();
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
      await sleep(10);
    }
  }

  async waitRec(pred: (r: RecMsg) => boolean, what: string, timeoutMs = 15_000): Promise<RecMsg> {
    const t0 = Date.now();
    for (;;) {
      const m = this.recs().find(pred);
      if (m) return m;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `等待超时：${what}；recs=${JSON.stringify(this.recs().map((x) => x.record.type))}`,
        );
      }
      await sleep(10);
    }
  }

  close(): void {
    this.ws.close();
  }
}

const AGENT = "main";

describe("M3 消息派发三策略（04 §4.1–4.3）", () => {
  test("默认派发、原子编辑/打断、幂等与已生效冲突，投影可重建", async () => {
    const gate = new Gate();
    const { srv, api, sessionId, calls } = await boot([
      async () => {
        await gate.promise;
        return textOut("旧轮结束");
      },
      () => textOut("新轮结束"),
    ]);
    const { ticket } = await api.createTicket();
    const ws = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    ws.send({ type: "sub", topic: `session:${sessionId}`, cursor: 0 });
    await ws.waitFor((m) => m.type === "sub.ok", "sub.ok");
    try {
      await api.updateSettings({ defaultDispatchMode: "queue" });
      expect((await api.getSettings()).settings.defaultDispatchMode).toBe("queue");
      await api.sendMessage(sessionId, AGENT, { clientMessageId: "initial", text: "当前任务" });
      await waitLog(api, sessionId, (i) => i.some((r) => r.type === "step.started"), "step");
      await sleep(30);
      const original = await api.sendMessage(sessionId, AGENT, {
        clientMessageId: "pending",
        text: "待处理原文",
      });
      expect(original.dispatch.mode).toBe("queue");
      const image = await api.uploadAttachment({
        name: "fixture.png",
        data: new Blob(
          [
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
          ],
          { type: "image/png" },
        ),
      });
      const workspace = (await api.listWorkspaces()).items.find((w) => w.isDefault);
      if (!workspace) throw new Error("default workspace missing");
      await api.uploadFile(workspace.id, { name: "data.csv", data: new Blob(["a,b\n1,2\n"]) });
      const { document } = await api.openDoc(workspace.id, { path: "data.csv" });
      const context = [{ docId: document.id, rev: document.rev, range: "A1:B2" }];
      const editBody = {
        clientMessageId: "edited",
        text: "已编辑正文 @data.csv",
        replacesDispatchId: original.dispatch.id,
        mode: "queue" as const,
        attachments: [image],
        context,
      };
      const responses = await Promise.all([
        api.sendMessage(sessionId, AGENT, editBody),
        api.sendMessage(sessionId, AGENT, editBody),
      ]);
      expect(new Set(responses.map((r) => r.dispatch.id)).size).toBe(1);
      expect(responses.filter((r) => r.deduplicated)).toHaveLength(1);
      const edited = responses[0];
      if (!edited) throw new Error("missing replacement response");
      await ws.waitRec(
        (r) =>
          r.record.type === "dispatch.updated" &&
          r.record.data.dispatchId === original.dispatch.id &&
          r.record.data.status === "cancelled",
        "旧派发撤回",
      );
      const retry = await api.sendMessage(sessionId, AGENT, editBody);
      expect(retry.deduplicated).toBe(true);
      expect(retry.dispatch.id).toBe(edited.dispatch.id);
      await expect(
        api.sendMessage(sessionId, AGENT, { ...editBody, replacesDispatchId: "other" }),
      ).rejects.toThrow();
      await expect(
        api.sendMessage(sessionId, AGENT, { ...editBody, clientMessageId: "late-original" }),
      ).rejects.toThrow();
      const logs = (await api.getSessionLog(sessionId, { limit: 500 })).items;
      expect(dispatchStatus(logs, original.dispatch.id)).toBe("cancelled");
      const cancellation = logs.find(
        (r) =>
          r.type === "dispatch.updated" &&
          r.data.dispatchId === original.dispatch.id &&
          r.data.status === "cancelled",
      );
      const replacement = logs.find(
        (r) => r.type === "user.message" && r.data.dispatchId === edited.dispatch.id,
      );
      expect(replacement?.seq).toBe((cancellation?.seq ?? 0) + 1);
      expect(replacement?.data.attachments).toEqual([image]);
      expect(replacement?.data.context).toEqual(context);
      const interrupted = await api.sendMessage(sessionId, AGENT, {
        ...editBody,
        clientMessageId: "interrupt",
        replacesDispatchId: edited.dispatch.id,
        mode: "interrupt",
      });
      gate.open();
      const done = await waitLog(
        api,
        sessionId,
        (i) =>
          dispatchStatus(i, interrupted.dispatch.id) === "applied" &&
          i.some((r) => r.type === "turn.completed"),
        "打断派发生效",
      );
      expect(dispatchStatus(done, edited.dispatch.id)).toBe("cancelled");
      expect(calls.slice(1).every((prompt) => !allUserText(prompt).includes("待处理原文"))).toBe(
        true,
      );
      expect(allUserText(calls.at(-1) ?? [])).toContain("已编辑正文 @data.csv");
      await expect(
        api.sendMessage(sessionId, AGENT, {
          ...editBody,
          clientMessageId: "late-applied",
          replacesDispatchId: interrupted.dispatch.id,
        }),
      ).rejects.toThrow();
      expect((await api.sendMessage(sessionId, AGENT, editBody)).dispatch.id).toBe(
        edited.dispatch.id,
      );
      const db = new DatabaseSync(join(srv.dataDir, "excelmanus.db"));
      const snapshot = () => ({
        dispatches: db
          .prepare("SELECT * FROM dispatches WHERE session_id = ? ORDER BY id")
          .all(sessionId),
        context: db
          .prepare("SELECT * FROM agent_context WHERE session_id = ? ORDER BY agent_id, idx")
          .all(sessionId),
      });
      const before = snapshot();
      new SessionLog(db, { projections: kernelProjections() }).rebuild(sessionId);
      expect(snapshot()).toEqual(before);
      db.close();
    } finally {
      gate.open();
      ws.close();
    }
  }, 30_000);

  test("steer：运行中受理 queued，下一步骤边界注入同一轮", async () => {
    const gate = new Gate();
    const { srv, api, sessionId, calls } = await boot([
      async () => {
        await gate.promise;
        return toolCallOut("tc1", "find", '{"path":"."}');
      },
      () => textOut("带引导的回答"),
    ]);
    const { ticket } = await api.createTicket();
    const ws = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    ws.send({ type: "sub", topic: `session:${sessionId}`, cursor: 0 });
    await ws.waitFor((m) => m.type === "sub.ok", "sub.ok");

    const first = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "s1",
      text: "先列目录",
    });
    expect(first.dispatch.status).toBe("accepted");
    // 等第一次模型调用确实卡住再发引导
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "step.started"), "step1");
    await sleep(30); // 让 doStream 进入 gate 等待

    const steer = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "s2",
      text: "顺便确认有没有 note.txt",
      mode: "steer",
    });
    expect(steer.dispatch.status).toBe("queued");
    gate.open();

    await ws.waitRec((r) => r.record.type === "turn.completed", "turn.completed");
    ws.close();

    expect(calls.length).toBe(2);
    // 同一轮内没有第二个 turn.started；steer 文本出现在第二次调用 prompt
    const log = await api.getSessionLog(sessionId, { limit: 500 });
    expect(log.items.filter((r) => r.type === "turn.started").length).toBe(1);
    expect(lastUserText(calls[1] ?? [])).toContain("顺便确认有没有 note.txt");
    expect(dispatchStatus(log.items, steer.dispatch.id)).toBe("applied");
  }, 30_000);

  test("steer 残留：无工具的最后一步期间发送，轮结束后进下一轮", async () => {
    const gate = new Gate();
    const { api, sessionId, calls } = await boot([
      async () => {
        await gate.promise;
        return textOut("第一轮回答");
      },
      () => textOut("第二轮回答"),
    ]);
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "r1", text: "问一句" });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "step.started"), "step");
    await sleep(30);

    const steer = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "r2",
      text: "补充一句",
      mode: "steer",
    });
    expect(steer.dispatch.status).toBe("queued");
    gate.open();

    const items = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 2,
      "两轮完成",
    );
    expect(items.filter((r) => r.type === "turn.started").length).toBe(2);
    expect(calls.length).toBe(2);
    expect(lastUserText(calls[1] ?? [])).toContain("补充一句");
    expect(dispatchStatus(items, steer.dispatch.id)).toBe("applied");
  }, 30_000);

  test("queue：运行中两条排队消息不进当前轮，轮后按序各自开轮", async () => {
    const gate1 = new Gate();
    const gate2 = new Gate();
    const { api, sessionId, calls } = await boot([
      async () => {
        await gate1.promise;
        return toolCallOut("tc1", "find", '{"path":"."}');
      },
      async () => {
        await gate2.promise;
        return textOut("第一轮完成");
      },
      () => textOut("第二轮回答"),
      () => textOut("第三轮回答"),
    ]);
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "q0", text: "初始任务" });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "step.started"), "step1");
    await sleep(30);

    const qa = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "q1",
      text: "队列消息A",
      mode: "queue",
    });
    const qb = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "q2",
      text: "队列消息B",
      mode: "queue",
    });
    expect(qa.dispatch.status).toBe("queued");
    expect(qb.dispatch.status).toBe("queued");

    gate1.open();
    await waitLog(api, sessionId, () => calls.length >= 2, "第二次模型调用");
    // 当前轮第二步的 prompt 不含排队消息（守住 user.message 提前入场的根因）
    expect(allUserText(calls[1] ?? [])).not.toContain("队列消息A");
    expect(allUserText(calls[1] ?? [])).not.toContain("队列消息B");

    gate2.open();
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 3,
      "三轮完成",
    );
    expect(items.filter((r) => r.type === "turn.started").length).toBe(3);
    expect(calls.length).toBe(4);
    // A 的轮在 B 之前：第三次调用 prompt 末位是 A 且不含 B；第四次含 B
    expect(lastUserText(calls[2] ?? [])).toContain("队列消息A");
    expect(allUserText(calls[2] ?? [])).not.toContain("队列消息B");
    expect(lastUserText(calls[3] ?? [])).toContain("队列消息B");
    expect(dispatchStatus(items, qa.dispatch.id)).toBe("applied");
    expect(dispatchStatus(items, qb.dispatch.id)).toBe("applied");
  }, 30_000);

  test("interrupt：模型请求中打断，写 turn.interrupted 后立即开新轮", async () => {
    const gate = new Gate();
    const { srv, api, sessionId, calls } = await boot([
      async () => {
        await gate.promise;
        return textOut("本应被丢弃的回答");
      },
      () => textOut("打断后的回答"),
    ]);
    const { ticket } = await api.createTicket();
    const ws = await TestWs.connect(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    ws.send({ type: "sub", topic: `session:${sessionId}`, cursor: 0 });
    await ws.waitFor((m) => m.type === "sub.ok", "sub.ok");

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "i1", text: "慢任务" });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "step.started"), "step");
    await sleep(30);

    const interrupt = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "i2",
      text: "打断：改做这个",
      mode: "interrupt",
    });
    expect(interrupt.dispatch.status).toBe("queued");
    gate.open();

    await ws.waitRec((r) => r.record.type === "turn.interrupted", "turn.interrupted");
    await ws.waitRec((r) => r.record.type === "turn.completed", "打断后轮完成");
    ws.close();

    const log = await api.getSessionLog(sessionId, { limit: 500 });
    const types = log.items.map((r) => r.type);
    const interruptedIdx = types.indexOf("turn.interrupted");
    expect(interruptedIdx).toBeGreaterThan(-1);
    expect(types.indexOf("turn.started", interruptedIdx)).toBeGreaterThan(interruptedIdx);
    expect(log.items.filter((r) => r.type === "turn.started").length).toBe(2);
    expect(calls.length).toBe(2);
    expect(lastUserText(calls[1] ?? [])).toContain("打断：改做这个");
    expect(dispatchStatus(log.items, interrupt.dispatch.id)).toBe("applied");
  }, 30_000);

  test("interrupt：等待审批时打断，审批以「用户发送了新指令」拒绝", async () => {
    const { api, sessionId, calls } = await boot(
      [
        () => toolCallOut("w1", "write", '{"path":"g.txt","content":"x"}'),
        () => textOut("新指令的回答"),
      ],
      { permissionMode: "confirm" },
    );
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "a1", text: "写入文件" });
    await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "approval.requested"),
      "approval.requested",
    );
    await sleep(30);

    const interrupt = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "a2",
      text: "别写了，先回答",
      mode: "interrupt",
    });
    expect(interrupt.dispatch.status).toBe("queued");

    const items = await waitLog(
      api,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 1,
      "打断后轮完成",
    );
    const decided = items.find((r) => r.type === "approval.decided");
    expect(decided?.data.decision).toBe("denied");
    expect(decided?.data.reason).toBe("用户发送了新指令");
    const deniedResult = items.find(
      (r) =>
        r.type === "tool.result" &&
        (r.data.result as { error?: { code?: string } }).error?.code === "APPROVAL_DENIED",
    );
    expect(deniedResult).toBeDefined();
    expect(items.some((r) => r.type === "turn.interrupted")).toBe(true);
    expect(items.filter((r) => r.type === "turn.started").length).toBe(2);
    expect(calls.length).toBe(2);
    expect(lastUserText(calls[1] ?? [])).toContain("别写了，先回答");
    expect(dispatchStatus(items, interrupt.dispatch.id)).toBe("applied");
  }, 30_000);

  test("撤回：queued 派发 DELETE 后 cancelled，不进任何 prompt；幂等与已应用 409", async () => {
    const gate1 = new Gate();
    const gate2 = new Gate();
    const { api, sessionId, calls } = await boot([
      async () => {
        await gate1.promise;
        return toolCallOut("tc1", "find", '{"path":"."}');
      },
      async () => {
        await gate2.promise;
        return textOut("完成");
      },
    ]);
    const first = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "c1",
      text: "跑一轮",
    });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "step.started"), "step");
    await sleep(30);

    const queued = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "c2",
      text: "这条会被撤回",
      mode: "queue",
    });
    expect(queued.dispatch.status).toBe("queued");

    const cancelled = await api.cancelDispatch(sessionId, queued.dispatch.id);
    expect(cancelled.dispatch.status).toBe("cancelled");
    // 重复撤回幂等
    const again = await api.cancelDispatch(sessionId, queued.dispatch.id);
    expect(again.dispatch.id).toBe(queued.dispatch.id);
    expect(again.dispatch.status).toBe("cancelled");
    // 已应用派发撤回 409
    await expect(api.cancelDispatch(sessionId, first.dispatch.id)).rejects.toMatchObject({
      status: 409,
    });

    gate1.open();
    gate2.open();
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "turn.completed",
    );
    await sleep(300); // 给 pump 一个窗口：cancelled 派发不应再开轮
    const later = await api.getSessionLog(sessionId, { limit: 500 });
    expect(later.items.filter((r) => r.type === "turn.started").length).toBe(1);
    expect(dispatchStatus(items, queued.dispatch.id)).toBe("cancelled");
    for (const prompt of calls) {
      expect(allUserText(prompt)).not.toContain("这条会被撤回");
    }
  }, 30_000);

  test("停止挂起：stop 收尾当前轮、队列保持 queued，resume 后才运行", async () => {
    const gate = new Gate();
    const { api, sessionId, calls } = await boot([
      async () => {
        await gate.promise;
        return textOut("被停止的回答");
      },
      () => textOut("恢复后的回答"),
    ]);
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "t1", text: "跑一轮" });
    await waitLog(api, sessionId, (i) => i.some((r) => r.type === "step.started"), "step");
    await sleep(30);

    const queued = await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "t2",
      text: "停止期间排队的消息",
      mode: "queue",
    });
    expect(queued.dispatch.status).toBe("queued");

    const stopped = await api.stopAgent(sessionId, AGENT);
    expect(stopped.stopped).toBe(true);
    gate.open();

    await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.interrupted"),
      "interrupted",
    );
    await sleep(300);
    let items = (await api.getSessionLog(sessionId, { limit: 500 })).items;
    // 停止不自动消费队列：没有新轮，派发保持 queued
    expect(items.filter((r) => r.type === "turn.started").length).toBe(1);
    expect(dispatchStatus(items, queued.dispatch.id)).toBe("queued");
    expect(calls.length).toBe(1);

    const resumed = await api.resumeAgent(sessionId, AGENT);
    expect(resumed).toMatchObject({ ok: true, resumed: 1, started: true });
    items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "恢复后轮完成",
    );
    expect(calls.length).toBe(2);
    expect(lastUserText(calls[1] ?? [])).toContain("停止期间排队的消息");
    expect(dispatchStatus(items, queued.dispatch.id)).toBe("applied");
  }, 30_000);

  test("跨进程：queued 派发随重启保留且不自动运行，resume 后执行", async () => {
    const gate = new Gate(); // 永不放行：doStream 随旧进程悬挂
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-dispatch-restart-"));
    dirs.push(dataDir);
    const calls: Prompt[] = [];
    const srv1 = await startServer({
      dataDir,
      retryBaseMs: 10,
      resolveLanguageModel: () =>
        makeGatedModel(
          [
            async () => {
              await gate.promise;
              return textOut("永远不会到达");
            },
          ],
          calls,
        ).model,
      log: () => {},
    });
    const api1 = createApiClient(srv1.url, srv1.token);
    await createTestProfile(api1, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock-dispatch",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api1.createSession({});
    const sessionId = session.id;
    await api1.sendMessage(sessionId, AGENT, { clientMessageId: "p1", text: "卡住的任务" });
    await waitLog(api1, sessionId, (i) => i.some((r) => r.type === "step.started"), "step");
    await sleep(30);
    const queued = await api1.sendMessage(sessionId, AGENT, {
      clientMessageId: "p2",
      text: "重启前排队的消息",
      mode: "queue",
    });
    expect(queued.dispatch.status).toBe("queued");

    // 不做任何清理直接关闭（模型调用仍悬挂），用同一 SQLite 重启
    await srv1.close();
    const srv2 = await startServer({
      dataDir,
      retryBaseMs: 10,
      resolveLanguageModel: () => makeGatedModel([() => textOut("重启后的回答")], calls).model,
      log: () => {},
    });
    servers.push(srv2);
    const api2 = createApiClient(srv2.url, srv2.token);

    await sleep(400);
    let items = (await api2.getSessionLog(sessionId, { limit: 500 })).items;
    // 恢复只写 turn.interrupted；queued 派发仍在且不自动开轮
    expect(items.some((r) => r.type === "turn.interrupted")).toBe(true);
    expect(items.filter((r) => r.type === "turn.started").length).toBe(1);
    expect(dispatchStatus(items, queued.dispatch.id)).toBe("queued");

    const resumed = await api2.resumeAgent(sessionId, AGENT);
    expect(resumed).toMatchObject({ ok: true, resumed: 1, started: true });
    items = await waitLog(
      api2,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "重启恢复后轮完成",
    );
    expect(lastUserText(calls[calls.length - 1] ?? [])).toContain("重启前排队的消息");
    expect(dispatchStatus(items, queued.dispatch.id)).toBe("applied");
  }, 30_000);

  test("空闲代理：三种策略都立即受理并开轮", async () => {
    const { api, sessionId } = await boot([() => textOut("ok")]);
    for (const [i, mode] of (["steer", "interrupt", "queue"] as const).entries()) {
      const res = await api.sendMessage(sessionId, AGENT, {
        clientMessageId: `idle-${i}`,
        text: `空闲消息 ${mode}`,
        mode,
      });
      expect(res.dispatch.status).toBe("accepted");
      await waitLog(
        api,
        sessionId,
        (it) => it.filter((r) => r.type === "turn.completed").length >= i + 1,
        `第 ${i + 1} 轮完成`,
      );
    }
    const items = (await api.getSessionLog(sessionId, { limit: 500 })).items;
    expect(items.filter((r) => r.type === "turn.started").length).toBe(3);
  }, 30_000);

  test("stop-all：会话里只停运行中的代理（11 §147）", async () => {
    // main 先 agent_spawn 派生 reader 子代理（很快完成转为 idle），
    // 第二轮 main 调 ask_user 挂起等待 → stop-all 只应返回 main。
    let mainBareCalls = 0;
    const route: CallHandler = (prompt) => {
      const sys = prompt.find((m) => m.role === "system")?.content;
      if (typeof sys === "string" && sys.includes("核对表头")) return textOut("child done");
      // 跨轮上下文里仍留着旧工具结果，只能按最后一条消息判断本步是否刚执行完工具
      if (prompt[prompt.length - 1]?.role === "tool") return textOut("完成");
      mainBareCalls += 1;
      if (mainBareCalls === 1) {
        return toolCallOut(
          "spawn-1",
          "agent_spawn",
          JSON.stringify({ name: "核对员", role: "reader", task: "核对表头" }),
        );
      }
      return toolCallOut(
        "q-1",
        "ask_user",
        JSON.stringify({ type: "text", spec: { question: "继续？" } }),
      );
    };
    const { api, sessionId } = await boot([route, route, route, route, route]);
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "sa-1", text: "派生" });
    // main 第一轮（spawn → 文本收口）与子代理各自的轮全部完成
    await waitLog(
      api,
      sessionId,
      (i) =>
        i.some((r) => r.type === "agent.spawned") &&
        i.filter((r) => r.type === "turn.completed").length >= 2,
      "派生轮与子代理轮完成",
    );
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "sa-2", text: "提问" });
    await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "tool.intent" && r.data.toolName === "ask_user"),
      "ask_user intent",
    );
    const res = await api.stopAll(sessionId);
    expect(res.ok).toBe(true);
    expect(res.stopped).toEqual([AGENT]);
    await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.interrupted"),
      "turn.interrupted",
    );
  }, 30_000);
});
