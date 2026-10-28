// 模型网关缺陷回归（P0-12、P1-39/40/41）：真实 HTTP/WS/SQLite + 本机假模型服务（node:http 实现的
// OpenAI 兼容 SSE 端点）。假服务只替代模型服务输出；档案解析、网关、错误分类、重试、日志、同步通道
// 全部走真实路径。
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient, type ServerMessage } from "@excelmanus/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const GOOGLE_KEY = "AIzaSyFAKEKEY1234567890abcdefXYZ9";
const HEADER_SECRET = "hdr-secret-ABCDEFGH123";

function chunk(content: string | null, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake",
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  })}\n\n`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(p as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

let fake: Server;
let fakeBase = "";
let cutCount = 0;
let incompleteCount = 0;

beforeAll(async () => {
  fake = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url?.startsWith("/echo/")) {
      // 模拟会把收到的凭据回显到错误体里的兼容网关
      const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Incorrect API key provided: ${key}; header=${String(req.headers["x-custom-auth"])}`,
          },
        }),
      );
      return;
    }
    const cutAll = body.includes("[[cutall]]");
    const cutOnce = body.includes("[[cut]]") && cutCount === 0;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (
      body.includes("[[incomplete-all]]") ||
      (body.includes("[[incomplete]]") && incompleteCount++ === 0)
    ) {
      res.end(`${chunk(null)}data: [DONE]\n\n`);
      return;
    }
    if (cutAll || cutOnce) {
      cutCount += 1;
      res.write(chunk("半截输出"));
      setTimeout(() => req.socket.destroy(), 50);
      return;
    }
    res.write(chunk("完整回答"));
    res.write(chunk(null, "stop"));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => fake.close(() => r()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-fix-models-ext-desktop-"));
  dirs.push(dataDir);
  const srv = await startServer({ dataDir, retryBaseMs: 10, log: () => {} });
  servers.push(srv);
  return { srv, api: createApiClient(srv.url, srv.token) };
}

async function waitLog(
  api: ReturnType<typeof createApiClient>,
  sid: string,
  pred: (types: string[]) => boolean,
): Promise<{ type: string; data: Record<string, unknown> }[]> {
  for (let i = 0; i < 400; i++) {
    const { items } = await api.getSessionLog(sid, { limit: 500 });
    if (pred(items.map((r) => r.type))) return items;
    await sleep(25);
  }
  throw new Error("等待日志超时");
}

describe("模型网关与契约缺口回归", () => {
  test("200 骨架 SSE + DONE 缺 finish：重试恢复，耗尽时失败而非空成功", async () => {
    const { api } = await boot();
    await createTestProfile(api, {
      name: "不完整流",
      provider: "custom-openai-compatible",
      model: "fake",
      baseUrl: `${fakeBase}/ok/v1`,
      apiKey: "sk-fixture-incomplete",
    });
    incompleteCount = 0;
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", {
      clientMessageId: "incomplete1",
      text: "[[incomplete]] 回答",
    });
    const recovered = await waitLog(api, session.id, (types) => types.includes("turn.completed"));
    expect(recovered.filter((e) => e.type === "retry.scheduled")).toHaveLength(1);
    expect(recovered.find((e) => e.type === "retry.scheduled")?.data.reason).toBe(
      "stream_interrupted",
    );
    expect(recovered.filter((e) => e.type === "model.output")).toHaveLength(1);
    expect(recovered.find((e) => e.type === "model.output")?.data.text).toBe("完整回答");

    const { session: failedSession } = await api.createSession({});
    await api.sendMessage(failedSession.id, "main", {
      clientMessageId: "incomplete2",
      text: "[[incomplete-all]] 回答",
    });
    const failed = await waitLog(api, failedSession.id, (types) => types.includes("turn.failed"));
    expect(failed.some((e) => e.type === "turn.completed")).toBe(false);
    expect(failed.some((e) => e.type === "model.output" || e.type === "tool.intent")).toBe(false);
    expect(failed.find((e) => e.type === "turn.failed")?.data.error).toMatchObject({
      kind: "stream_interrupted",
      retryable: true,
      detail: "incomplete_stream",
    });
  });
  test("P0-12：上游回显的 apiKey 与 extraHeaders 明文不进入会话日志与测试连接响应", async () => {
    const { api } = await boot();
    const { profile } = await createTestProfile(api, {
      name: "回显",
      provider: "custom-openai-compatible",
      model: "fake",
      baseUrl: `${fakeBase}/echo/v1`,
      apiKey: GOOGLE_KEY,
      extraHeaders: { "x-custom-auth": HEADER_SECRET },
    });
    const t = await api.testModelProfile(profile.id);
    expect(t.ok).toBe(false);
    expect(JSON.stringify(t)).not.toContain(GOOGLE_KEY);
    expect(JSON.stringify(t)).not.toContain(HEADER_SECRET);

    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "m1", text: "你好" });
    const items = await waitLog(api, session.id, (ts) => ts.includes("turn.failed"));
    const all = JSON.stringify(items);
    expect(all).toContain("Incorrect API key provided");
    expect(all).not.toContain(GOOGLE_KEY);
    expect(all).not.toContain(HEADER_SECRET);
    expect(all).toContain("<redacted>");
  });

  test("P1-41：流中途断开按 stream_interrupted 重试并写 attempt.discarded；失败轮不留 snapshot", async () => {
    const { srv, api } = await boot();
    await createTestProfile(api, {
      name: "正常",
      provider: "custom-openai-compatible",
      model: "fake",
      baseUrl: `${fakeBase}/ok/v1`,
      apiKey: "sk-ok-12345678",
    });
    const { session } = await api.createSession({});
    cutCount = 0;
    await api.sendMessage(session.id, "main", { clientMessageId: "c1", text: "[[cut]] 回答" });
    const ok = await waitLog(api, session.id, (ts) => ts.includes("turn.completed"));
    const types = ok.map((r) => r.type);
    expect(types).toContain("attempt.discarded");
    const retry = ok.find((r) => r.type === "retry.scheduled");
    expect(retry?.data.reason).toBe("stream_interrupted");

    // 每次都断：重试耗尽后失败，失败前写 attempt.discarded
    await api.sendMessage(session.id, "main", { clientMessageId: "c2", text: "[[cutall]] 回答" });
    const failed = await waitLog(api, session.id, (ts) => ts.includes("turn.failed"));
    const failTypes = failed.map((r) => r.type);
    const lastFail = failTypes.lastIndexOf("turn.failed");
    expect(failTypes.slice(lastFail - 2, lastFail + 1)).toEqual([
      "attempt.discarded",
      "error.guidance",
      "turn.failed",
    ]);

    // 新订阅者不应收到早已失败的半截输出
    const { ticket } = await api.createTicket();
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
    const msgs: ServerMessage[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
    });
    ws.send(JSON.stringify({ type: "sub", topic: `session:${session.id}`, cursor: 0 }));
    for (let i = 0; i < 200 && !msgs.some((m) => m.type === "sub.ok"); i++) await sleep(10);
    await sleep(100);
    ws.close();
    expect(msgs.some((m) => m.type === "sub.ok")).toBe(true);
    expect(msgs.filter((m) => m.type === "snapshot")).toEqual([]);
  });

  test("P1-41：连接被拒按 network 重试", async () => {
    const { api } = await boot();
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await createTestProfile(api, {
      name: "断网",
      provider: "custom-openai-compatible",
      model: "fake",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-net-12345678",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "n1", text: "你好" });
    const items = await waitLog(api, session.id, (ts) => ts.includes("turn.failed"));
    const retries = items.filter((r) => r.type === "retry.scheduled");
    expect(retries.length).toBe(5);
    expect(retries.every((r) => r.data.reason === "network")).toBe(true);
  });

  test("P1-40：Idempotency-Key、会话搜索/详情待处理交互/导出、文件下载", async () => {
    const { srv, api } = await boot();
    const a = await api.createSession({ title: "季度报表" }, { idempotencyKey: "k-1" });
    const b = await api.createSession({ title: "季度报表" }, { idempotencyKey: "k-1" });
    expect(b.session.id).toBe(a.session.id);
    await expect(
      api.createSession({ title: "别的" }, { idempotencyKey: "k-1" }),
    ).rejects.toMatchObject({ status: 409 });
    await api.createSession({ title: "100%_完成" });
    expect((await api.listSessions()).items.length).toBe(2);
    expect((await api.listSessions({ q: "季度" })).items.map((s) => s.id)).toEqual([a.session.id]);
    expect((await api.listSessions({ q: "%_" })).items.length).toBe(1);

    const detail = await api.getSession(a.session.id);
    expect(detail.pendingInteractions).toEqual([]);
    const md = await (await api.exportSession(a.session.id)).text();
    expect(md).toContain("# 季度报表");

    writeFileSync(join(srv.workspaceRoot, "out.csv"), "a,b\n1,2\n");
    const ws = (await api.listWorkspaces()).items[0]?.id as string;
    expect(await (await api.downloadFile(ws, "out.csv")).text()).toBe("a,b\n1,2\n");
    await expect(api.downloadFile(ws, "../../etc/passwd")).rejects.toMatchObject({
      status: 403,
    });
    // .excelmanus/ 对外不可见：与文件工具一致按"不存在"处理
    await expect(api.downloadFile(ws, ".excelmanus/x")).rejects.toMatchObject({ status: 404 });
    symlinkSync("/etc/hosts", join(srv.workspaceRoot, "link.txt"));
    await expect(api.downloadFile(ws, "link.txt")).rejects.toMatchObject({ status: 403 });
    await expect(api.downloadFile(ws, "missing.txt")).rejects.toMatchObject({ status: 404 });
  });
});
