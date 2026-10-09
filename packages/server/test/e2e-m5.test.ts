// M5 扩展能力真实边界测试（ADR 0006）：真实 HTTP/SQLite、真实 stdio MCP 子进程、
// 真实本机 OAuth 回调；假模型只替代模型输出，假 OAuth 发行方只替代 auth.openai.com。
// 覆盖场景 18（备份替换）、19（订阅登录：设备码 + 浏览器，令牌刷新）、20（MCP + 审批）、
// 21（记忆注入与删除），以及规则变化的追加说明与 /技能 调用。

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { BackupService } from "@excelmanus/kernel";
import { createApiClient, type ResolvedModel } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_XLSX = join(HERE, "../../../samples/sales.xlsx");
const ECHO_SERVER = join(HERE, "../../modules/mcp/test/fixtures/echo-server.ts");
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: RunningServer[] = [];
const dirs: string[] = [];
const extra: Server[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const s of extra) await new Promise((r) => s.close(r));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function stream(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: { text?: string }) => p.text ?? "").join("")
      : "";

/** 记录每次调用的 prompt；按最后一条用户消息里的指令决定输出。 */
function scriptedModel(prompts: string[]) {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "m5",
    doStream: async (opts) => {
      const prompt = opts.prompt as { role: string; content: unknown }[];
      prompts.push(prompt.map((m) => `[${m.role}] ${textOf(m.content)}`).join("\n"));
      const lastUser = [...prompt].reverse().find((m) => m.role === "user");
      const text = textOf(lastUser?.content);
      // 本轮是否已调用过工具：只看最后一条消息（前几轮的工具结果不算）
      const hasTool = prompt.at(-1)?.role === "tool";
      const call = (name: string, input: unknown) =>
        stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: `c-${Date.now()}-${Math.random()}`,
            toolName: name,
            input: JSON.stringify(input),
          },
          { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
        ]);
      if (!hasTool && text.includes("[[mcp-read]]"))
        return { stream: call("mcp__echo__lookup", { code: "A01" }) };
      if (!hasTool && text.includes("[[mcp-write]]"))
        return { stream: call("mcp__echo__shout", { text: "hi" }) };
      if (!hasTool && text.includes("[[render]]"))
        return { stream: call("workbook_render", { path: "sales.xlsx", range: "A1:D6" }) };
      if (!hasTool && text.includes("[[remember]]"))
        return {
          stream: call("memory", {
            action: "save",
            content: "金额保留两位小数并使用千分位",
            category: "preference",
          }),
        };
      return {
        stream: stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "好的" },
          { type: "text-end", id: "t" },
          { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
        ]),
      };
    },
  });
}

async function boot(opts: Partial<Parameters<typeof startServer>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-m5-"));
  dirs.push(dataDir);
  const prompts: string[] = [];
  const model = scriptedModel(prompts);
  const server = await startServer({
    dataDir,
    resolveLanguageModel: () => model,
    log: () => {},
    retryBaseMs: 5,
    ...opts,
  });
  servers.push(server);
  const api = createApiClient(server.url, server.token);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as Record<string, any>,
    };
  };
  return { server, api, call, prompts, dataDir };
}

async function waitTurn(api: ReturnType<typeof createApiClient>, sessionId: string, n: number) {
  for (let i = 0; i < 400; i++) {
    const { items } = await api.getSessionLog(sessionId);
    const done = items.filter(
      (r) => r.agentId === "main" && (r.type === "turn.completed" || r.type === "turn.failed"),
    ).length;
    if (done >= n) return items;
    const pending = items.find((r) => r.type === "approval.requested");
    if (pending && !items.some((r) => r.type === "approval.decided")) return items;
    await sleep(15);
  }
  throw new Error("turn timeout");
}

describe("M5 扩展能力", () => {
  test("规则注入系统提示词、中途修改追加说明、/技能 调用注入正文", async () => {
    const { api, call, prompts } = await boot();
    await api.createModelProfile({
      name: "p",
      provider: "custom-openai-compatible",
      model: "m",
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    const r = await call("POST", "/rules", { content: "所有金额单位为万元" });
    expect(r.status).toBe(201);
    const skills = await call("GET", "/skills");
    expect(skills.json.items.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(["report-building", "data-cleaning", "reconciliation"]),
    );
    // 04 §7.1：内置技能 requires-tools 全部可用（workbook_render 已装配）
    expect(
      skills.json.items
        .filter((s: { available: boolean }) => !s.available)
        .map((s: { name: string }) => s.name),
    ).toEqual([]);

    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "a", text: "你好" });
    await waitTurn(api, session.id, 1);
    expect(prompts.at(-1)).toContain("所有金额单位为万元");
    expect(prompts.at(-1)).toContain("report-building");

    await call("POST", "/rules", { content: "日期统一为 yyyy-mm-dd" });
    await api.sendMessage(session.id, "main", {
      clientMessageId: "b",
      text: "/report-building 按地区汇总",
    });
    await waitTurn(api, session.id, 2);
    const last = prompts.at(-1) ?? "";
    expect(last).toContain("用户规则已更新");
    expect(last).toContain("日期统一为 yyyy-mm-dd");
    expect(last).toContain('<skill name="report-building">');
    // 系统提示词冻结：第一条系统消息仍只含第一条规则
    expect(last.split("\n")[0]).not.toContain("yyyy-mm-dd");

    const bad = await call("POST", `/sessions/${session.id}/agents/main/messages`, {
      clientMessageId: "c",
      text: "/no-such-skill",
    });
    expect(bad.status).toBe(201); // 不认识的斜杠前缀按普通文本发送
    const tooLong = await call("POST", "/rules", { content: "x".repeat(2001) });
    expect(tooLong.status).toBe(400);
  }, 30_000);

  test("场景 21：代理保存记忆后新开会话注入；用户删除后不再注入", async () => {
    const { api, call, prompts } = await boot();
    await api.createModelProfile({
      name: "p",
      provider: "custom-openai-compatible",
      model: "m",
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    const s1 = (await api.createSession({})).session;
    await api.sendMessage(s1.id, "main", {
      clientMessageId: "a",
      text: "[[remember]] 以后金额都这样处理",
    });
    const items = await waitTurn(api, s1.id, 1);
    const saved = items.find((r) => r.type === "memory.saved");
    expect(saved?.data.content).toBe("金额保留两位小数并使用千分位");

    const s2 = (await api.createSession({})).session;
    await api.sendMessage(s2.id, "main", { clientMessageId: "b", text: "把金额列整理一下" });
    await waitTurn(api, s2.id, 1);
    expect(prompts.at(-1)).toContain("相关记忆");
    expect(prompts.at(-1)).toContain("金额保留两位小数并使用千分位");
    // 本会话已注入过的不重复注入
    await api.sendMessage(s2.id, "main", { clientMessageId: "c", text: "金额再检查一遍" });
    await waitTurn(api, s2.id, 2);
    const lastUser = (prompts.at(-1) ?? "").split("[user]").at(-1) ?? "";
    expect(lastUser).not.toContain("相关记忆");

    const list = await call("GET", "/memories?q=金额");
    expect(list.json.items).toHaveLength(1);
    expect((await call("DELETE", `/memories/${list.json.items[0].id}`)).status).toBe(200);
    const s3 = (await api.createSession({})).session;
    await api.sendMessage(s3.id, "main", { clientMessageId: "d", text: "金额列怎么处理" });
    await waitTurn(api, s3.id, 1);
    expect(prompts.at(-1)).not.toContain("千分位");
  }, 30_000);

  test("场景 20：配置 stdio MCP 服务器；只读工具自动执行，其他工具需审批，可加入自动批准", async () => {
    const { api, call } = await boot();
    await api.createModelProfile({
      name: "p",
      provider: "custom-openai-compatible",
      model: "m",
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    const created = await call("POST", "/mcp-servers", {
      name: "echo",
      transport: "stdio",
      config: { command: process.execPath, args: [ECHO_SERVER], env: { SECRET_TOKEN: "abc123" } },
    });
    expect(created.status).toBe(201);
    expect(created.json.server.config.env.SECRET_TOKEN).toBe("••••");
    let srv = created.json.server;
    for (let i = 0; i < 300 && srv.status !== "connected"; i++) {
      await sleep(20);
      srv = (await call("GET", `/mcp-servers/${srv.id}`)).json.server;
    }
    expect(srv.status).toBe("connected");
    expect(srv.tools.map((t: { qualifiedName: string }) => t.qualifiedName).sort()).toEqual([
      "mcp__echo__lookup",
      "mcp__echo__shout",
    ]);
    const test = await call("POST", `/mcp-servers/${srv.id}/test`);
    expect(test.json.ok).toBe(true);

    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "r", text: "[[mcp-read]]" });
    let items = await waitTurn(api, session.id, 1);
    const readResult = items.find(
      (r) => r.type === "tool.result" && r.data.toolName === "mcp__echo__lookup",
    );
    expect(readResult?.data.status).toBe("ok");
    expect(JSON.stringify(readResult?.data.result)).toContain("产品 A01");

    await api.sendMessage(session.id, "main", { clientMessageId: "w", text: "[[mcp-write]]" });
    items = await waitTurn(api, session.id, 2);
    const req = items.find((r) => r.type === "approval.requested");
    expect(req?.data.toolName).toBe("mcp__echo__shout");
    expect(req?.data.effect).toBe("external");
    await api.decideApproval(String(req?.data.approvalId), { decision: "approve" });
    items = await waitTurn(api, session.id, 2);
    const writeResult = items.find(
      (r) => r.type === "tool.result" && r.data.toolName === "mcp__echo__shout",
    );
    expect(JSON.stringify(writeResult?.data.result)).toContain("HI");

    // 自动批准名单：第二次调用不再审批
    await call("PATCH", `/mcp-servers/${srv.id}`, { autoApprove: ["shout"] });
    await api.sendMessage(session.id, "main", { clientMessageId: "w2", text: "[[mcp-write]]" });
    items = await waitTurn(api, session.id, 3);
    expect(items.filter((r) => r.type === "approval.requested")).toHaveLength(1);
    expect(
      items.filter((r) => r.type === "tool.result" && r.data.toolName === "mcp__echo__shout"),
    ).toHaveLength(2);

    // 找不到命令时给出明确提示
    const broken = await call("POST", "/mcp-servers", {
      name: "broken",
      transport: "stdio",
      config: { command: "definitely-not-a-command-xyz" },
    });
    let b = broken.json.server;
    for (let i = 0; i < 200 && b.status !== "failed"; i++) {
      await sleep(20);
      b = (await call("GET", `/mcp-servers/${b.id}`)).json.server;
    }
    expect(b.status).toBe("failed");
    expect(b.error).toContain("找不到命令");
  }, 40_000);

  test("场景 18：用备份替换文件；替换前的文件也有备份", async () => {
    const { call, server } = await boot();
    const ws = (await call("GET", "/workspaces")).json.items[0];
    const file = join(server.workspaceRoot, "notes.txt");
    writeFileSync(file, "v1");
    // 用户经 REST 管理接口不会产生备份；这里直接登记一次备份（等同代理首次修改前的自动备份）
    const handle = new DatabaseSync(join(server.dataDir, "excelmanus.db"));
    const svc = new BackupService(handle);
    svc
      .bind({ workspaceId: ws.id, workspaceRoot: ws.path, sessionId: "s", agentId: "main" })
      .backup("notes.txt");
    handle.close();
    writeFileSync(file, "v2");
    const list = await call("GET", `/workspaces/${ws.id}/backups`);
    expect(list.json.items).toHaveLength(1);
    const restored = await call(
      "POST",
      `/workspaces/${ws.id}/backups/${list.json.items[0].id}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("v1");
    expect(restored.json.backupOfCurrent).toBeTruthy();
    const after = await call("GET", `/workspaces/${ws.id}/backups`);
    expect(after.json.items).toHaveLength(2);
    const dl = await fetch(
      `${server.url}/api/v1/workspaces/${ws.id}/backups/${restored.json.backupOfCurrent}/download`,
      {
        headers: { authorization: `Bearer ${server.token}` },
      },
    );
    expect(await dl.text()).toBe("v2");
  }, 20_000);

  test("场景 19：ChatGPT 订阅登录（设备码与浏览器），自动建档案、可对话、令牌过期自动刷新", async () => {
    // 假 OAuth 发行方：只替代 auth.openai.com
    let refreshCount = 0;
    const jwt = (claims: object) =>
      `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
    const idToken = jwt({
      email: "user@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" },
    });
    const issuer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const json = (o: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        if (req.url === "/api/accounts/deviceauth/usercode")
          return json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
        if (req.url === "/api/accounts/deviceauth/token")
          return json({ authorization_code: "code-dev", code_verifier: "v", code_challenge: "c" });
        if (req.url === "/oauth/token") {
          if (body.includes("refresh_token")) {
            refreshCount += 1;
            return json({ access_token: `access-refreshed-${refreshCount}`, expires_in: 3600 });
          }
          // 首次颁发的访问令牌已接近过期，用于验证自动刷新
          return json({
            access_token: "access-0",
            refresh_token: "refresh-0",
            id_token: idToken,
            expires_in: 60,
          });
        }
        json({ error: "not found" }, 404);
      });
    });
    await new Promise<void>((r) => issuer.listen(0, "127.0.0.1", r));
    extra.push(issuer);
    const issuerUrl = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;

    const seenTokens: string[] = [];
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-m5-sub-"));
    dirs.push(dataDir);
    const base = scriptedModel([]);
    const server = await startServer({
      dataDir,
      log: () => {},
      oauthIssuer: issuerUrl,
      resolveLanguageModel: (m: ResolvedModel) => {
        // 假模型只替代模型输出：在调用前取令牌，验证订阅凭据链路
        return new MockLanguageModelV4({
          provider: "mock",
          modelId: m.model,
          doStream: async (opts) => {
            seenTokens.push(await (m.subscription?.accessToken() ?? Promise.resolve("none")));
            return base.doStream(opts);
          },
        });
      },
    });
    servers.push(server);
    const api = createApiClient(server.url, server.token);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };

    // 设备码
    const start = await call("POST", "/accounts/chatgpt/login", { method: "device" });
    expect(start.json.attempt.userCode).toBe("ABCD-1234");
    const polled = await call("POST", "/accounts/chatgpt/login/poll", {
      attemptId: start.json.attempt.attemptId,
    });
    expect(polled.json.attempt.status).toBe("succeeded");
    expect(polled.json.attempt.account.email).toBe("user@example.com");
    expect(polled.json.attempt.profileIds.length).toBeGreaterThan(0);

    const profiles = (await api.listModelProfiles()).items.filter((p) => p.provider === "chatgpt");
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles[0]?.apiKeyMasked).toBeNull();
    // 读接口不泄露令牌
    expect(JSON.stringify(await call("GET", "/accounts"))).not.toContain("access-0");

    const { session } = await api.createSession({ modelProfileId: profiles[0]?.id });
    await api.sendMessage(session.id, "main", { clientMessageId: "a", text: "你好" });
    await waitTurn(api, session.id, 1);
    // 60 秒到期 < 5 分钟刷新窗口：请求前自动刷新
    expect(seenTokens[0]).toBe("access-refreshed-1");

    // 浏览器授权：经真实本机回调完成（与设备码是同一账号，不重复建档案）
    const b = await call("POST", "/accounts/chatgpt/login", { method: "browser" });
    const authorize = new URL(b.json.attempt.authorizeUrl);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const cb = await fetch(
      `http://localhost:1455/auth/callback?code=code-browser&state=${authorize.searchParams.get("state")}`,
    );
    expect(await cb.text()).toContain("登录成功");
    const done = await call("POST", "/accounts/chatgpt/login/poll", {
      attemptId: b.json.attempt.attemptId,
    });
    expect(done.json.attempt.status).toBe("succeeded");
    expect((await call("GET", "/accounts")).json.items).toHaveLength(1);
  }, 30_000);

  test("workbook_render：经同步通道的渲染端回传 PNG，图片进入模型视觉输入；无渲染端时明确报错", async () => {
    const { api, server, prompts } = await boot();
    await api.createModelProfile({
      name: "p",
      provider: "custom-openai-compatible",
      model: "m",
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    copyFileSync(SAMPLE_XLSX, join(server.workspaceRoot, "sales.xlsx"));
    const { session } = await api.createSession({});

    // 没有渲染端
    await api.sendMessage(session.id, "main", { clientMessageId: "r0", text: "[[render]]" });
    let items = await waitTurn(api, session.id, 1);
    const noRenderer = items.find(
      (r) => r.type === "tool.result" && r.data.toolName === "workbook_render",
    );
    expect(JSON.stringify(noRenderer?.data.result)).toContain("没有可用的渲染端");

    // 真实 WebSocket 客户端订阅 app 主题充当渲染端（浏览器页签的替身，校验收到的版式）
    const { ticket } = await api.createTicket();
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/v1/sync?ticket=${ticket}`, {
      headers: { origin: server.url },
    });
    let layout: { width: number; cells: { text: string }[] } | undefined;
    const PNG_1PX =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as {
          type: string;
          requestId?: string;
          layout?: typeof layout;
        };
        if (msg.type === "hello") ws.send(JSON.stringify({ type: "sub", topic: "app" }));
        if (msg.type === "sub.ok") resolve();
        if (msg.type === "render.request") {
          layout = msg.layout;
          ws.send(
            JSON.stringify({ type: "render.result", requestId: msg.requestId, png: PNG_1PX }),
          );
        }
      });
    });
    await api.sendMessage(session.id, "main", { clientMessageId: "r1", text: "[[render]]" });
    items = await waitTurn(api, session.id, 2);
    const ok = items
      .filter((r) => r.type === "tool.result" && r.data.toolName === "workbook_render")
      .at(-1);
    expect(ok?.data.status).toBe("ok");
    const data = (
      ok?.data.result as
        | { data: { rev: number; columns: unknown[]; limitations: string[] } }
        | undefined
    )?.data;
    expect(data?.columns).toHaveLength(4);
    expect(data?.limitations.length).toBeGreaterThan(0);
    expect(layout?.width).toBeGreaterThan(100);
    // 表头 A..D 与至少一个数据单元格
    expect(layout?.cells.map((c) => c.text)).toEqual(expect.arrayContaining(["A", "B", "C", "D"]));
    expect(
      layout?.cells.filter(
        (c) => !["A", "B", "C", "D", "1", "2", "3", "4", "5", "6"].includes(c.text),
      ).length,
    ).toBeGreaterThan(0);
    ws.close();
    // 图片作为视觉输入发给模型：mock 收到的 prompt 中工具结果不再以 JSON 字符串携带 base64
    expect(prompts.at(-1)).not.toContain(PNG_1PX);
  }, 30_000);

  test("设置、能力手动覆盖、切换模型、工作区登记", async () => {
    const { api, call } = await boot();
    const p = await api.createModelProfile({
      name: "p1",
      provider: "custom-openai-compatible",
      model: "m",
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    const s = await call("PATCH", "/settings", {
      defaultPermissionMode: "confirm",
      maxConcurrentSubAgents: 2,
    });
    expect(s.json.settings.defaultPermissionMode).toBe("confirm");
    expect(s.json.restartRequired).toContain("maxConcurrentSubAgents");
    const { session } = await api.createSession({});
    expect(session.permissionMode).toBe("confirm");

    const caps = await call("PATCH", `/model-profiles/${p.profile.id}/capabilities`, {
      tools: false,
    });
    expect(caps.json.capabilities.tools).toMatchObject({ value: false, source: "manual" });
    const sw = await call("PATCH", `/sessions/${session.id}/agents/main`, { modelName: "p1" });
    expect(sw.status).toBe(409);
    await call("PATCH", `/model-profiles/${p.profile.id}/capabilities`, { tools: null });
    expect(
      (await call("PATCH", `/sessions/${session.id}/agents/main`, { modelName: "p1" })).status,
    ).toBe(200);

    const dir = mkdtempSync(join(tmpdir(), "excelmanus-ws-"));
    dirs.push(dir);
    const ws = await call("POST", "/workspaces", { path: dir, name: "报表" });
    expect(ws.status).toBe(201);
    expect((await call("GET", "/workspaces")).json.items).toHaveLength(2);
    const presets = await api.listProviders();
    expect(presets.items.map((x) => x.id)).toEqual(
      expect.arrayContaining(["google", "moonshot", "qwen", "chatgpt"]),
    );
    const cat = await call("GET", "/model-catalog?provider=anthropic");
    expect(cat.json.items.length).toBeGreaterThan(0);
  }, 20_000);
});
