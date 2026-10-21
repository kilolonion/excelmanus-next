import { createTestProfile } from "./fixtures/create-model.ts";
// M3 run_script 集成测试（06 §4.6、08 全章；14 场景 16/17；ADR 0006：
// 真实 HTTP/WS/SQLite 文件 + MockLanguageModelV4 只替代模型输出）。
// 假模型用可控 gate 卡住 doStream；工具调用经工具表进 QuickJS 沙箱执行。

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { type ApiClient, createApiClient, type LogRecord } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AGENT = "main";

function streamOf(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

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

type Prompt = Array<{ role: string; content: unknown }>;
type CallHandler = (prompt: Prompt) => Promise<ModelOut> | ModelOut;

// 注意：网关每次 gateway.step 都调用 resolveLanguageModel 新建模型实例，
// 故调用序号必须放在共享的 calls 数组上（与 e2e-dispatch 的 makeGatedModel 相同），
// 否则每个新实例都从 handlers[0] 重发同一个工具调用。
function makeModel(handlers: CallHandler[], calls: Prompt[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-script",
    doStream: async (opts) => {
      const prompt = [...(opts.prompt as Prompt)];
      calls.push(prompt);
      const handler = handlers[calls.length - 1] ?? (() => textOut("…"));
      return handler(prompt);
    },
  });
}

const servers: RunningServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function boot(
  handlers: CallHandler[],
  permissionMode?: "confirm",
): Promise<{
  srv: RunningServer;
  api: ApiClient;
  sessionId: string;
  workspaceId: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-script-"));
  dirs.push(dataDir);
  const calls: Prompt[] = [];
  const srv = await startServer({
    dataDir,
    retryBaseMs: 10,
    resolveLanguageModel: () => makeModel(handlers, calls),
    log: () => {},
  });
  servers.push(srv);
  const api = createApiClient(srv.url, srv.token);
  await createTestProfile(api, {
    name: "mock",
    provider: "custom-openai-compatible",
    model: "mock-script",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "test",
  });
  const { session } = await api.createSession(permissionMode ? { permissionMode } : {});
  return { srv, api, sessionId: session.id, workspaceId: session.workspaceId };
}

/** 工作区里放 5 个真实 xlsx（复用 samples 里的真文件），返回 sha256 表。 */
function seedWorkbooks(root: string, names: string[]): Record<string, string> {
  const src = join(dirname(fileURLToPath(import.meta.url)), "../../../samples/sales.xlsx");
  const hashes: Record<string, string> = {};
  for (const n of names) {
    const dst = join(root, n);
    copyFileSync(src, dst);
    hashes[n] = createHash("sha256").update(readFileSync(dst)).digest("hex");
  }
  return hashes;
}

const sha256File = (p: string) =>
  existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;

async function waitLog(
  api: ApiClient,
  sessionId: string,
  pred: (items: LogRecord[]) => boolean,
  what: string,
  timeoutMs = 20_000,
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

/** 让模型发起一次 run_script 调用并等待 tool.result + 轮次结束。 */
async function runScript(
  api: ApiClient,
  sessionId: string,
  _script: { code: string; timeoutSeconds?: number; expectedVersions?: Record<string, string> },
  toolCallId = "tc1",
  clientMessageId = `m-${toolCallId}`,
): Promise<LogRecord[]> {
  await api.sendMessage(sessionId, AGENT, { clientMessageId, text: "跑脚本" });
  return waitLog(
    api,
    sessionId,
    (items) =>
      items.some(
        (r) =>
          r.type === "tool.result" &&
          r.data.toolCallId === toolCallId &&
          r.data.toolName === "run_script",
      ) && items.some((r) => r.type === "turn.completed" || r.type === "turn.interrupted"),
    `run_script ${toolCallId} 结果`,
  );
}

function scriptResult(items: LogRecord[], toolCallId: string): LogRecord | undefined {
  return items.find(
    (r) =>
      r.type === "tool.result" &&
      r.data.toolCallId === toolCallId &&
      r.data.toolName === "run_script",
  );
}

const dbFile = (srv: RunningServer) => new DatabaseSync(join(srv.dataDir, "excelmanus.db"));

/** 文档里某单元格当前值（真实 REST：openDoc + snapshot）。 */
async function cellValue(
  api: ApiClient,
  workspaceId: string,
  path: string,
  a1: string,
): Promise<unknown> {
  const { document } = await api.openDoc(workspaceId, { path });
  const { snapshot } = await api.getDocSnapshot(workspaceId, document.id);
  const m = /([A-Z]+)(\d+)/.exec(a1)!;
  const col = m[1]!.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const row = Number(m[2]!) - 1;
  const sheet = Object.values(
    (
      snapshot as {
        sheets: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }>;
      }
    ).sheets,
  )[0];
  return sheet?.cellData?.[String(row)]?.[String(col)]?.v;
}

const tmpDir = (srv: RunningServer) => join(srv.workspaceRoot, ".excelmanus", "tmp");

describe("e2e run_script", () => {
  test("场景16：中途抛错 → SANDBOX_ERROR + 行号；五个文件零改动、无 doc_ops、无暂存残留", async () => {
    const files = ["f1.xlsx", "f2.xlsx", "f3.xlsx", "f4.xlsx", "f5.xlsx"];
    const code = [
      'const files = ["f1.xlsx","f2.xlsx","f3.xlsx","f4.xlsx","f5.xlsx"];',
      "for (const p of files) {",
      '  await wb.edit({ path: p, ops: [{ op: "cells.set", range: "销售!A1", values: [["X"]] }] });',
      '  if (p === "f3.xlsx") throw new Error("boom");',
      "}",
      'return "never";',
    ].join("\n");
    const { srv, api, sessionId } = await boot([
      () => toolCallOut("tc1", "run_script", JSON.stringify({ code })),
      () => textOut("完成"),
    ]);
    const hashes = seedWorkbooks(srv.workspaceRoot, files);
    const items = await runScript(api, sessionId, { code });
    const r = scriptResult(items, "tc1")!;
    expect(r.data.status).toBe("error");
    const res = r.data.result as {
      error: { code: string; message: string };
      data?: { line?: number };
    };
    expect(res.error.code).toBe("SANDBOX_ERROR");
    expect(res.error.message).toContain("第 4 行");
    expect(res.error.message).toContain("boom");
    expect(res.data?.line).toBe(4);
    for (const f of files) {
      expect(sha256File(join(srv.workspaceRoot, f))).toBe(hashes[f]);
    }
    const db = dbFile(srv);
    const n = db.prepare("SELECT COUNT(*) AS c FROM doc_ops WHERE tool_call_id = 'tc1'").get() as {
      c: number;
    };
    expect(n.c).toBe(0);
    const tmp = tmpDir(srv);
    expect(existsSync(tmp) ? readdirSync(tmp).filter((d) => d.startsWith("script-")) : []).toEqual(
      [],
    );
  }, 60_000);

  test("成功批量发布：5 文档 +1 rev、文本落盘、暂存叠加读回、published 完整", async () => {
    const files = ["a1.xlsx", "a2.xlsx", "a3.xlsx", "a4.xlsx", "a5.xlsx"];
    const code = [
      'for (const p of ["a1.xlsx","a2.xlsx","a3.xlsx","a4.xlsx","a5.xlsx"])',
      '  await wb.edit({ path: p, ops: [{ op: "cells.set", range: "销售!B2", values: [["脚本写入"]] }] });',
      'await files.writeText({ path: "notes/out.txt", content: "暂存内容-甲乙丙" });',
      'const back = await files.readText({ path: "notes/out.txt" });',
      'if (back.data.content !== "暂存内容-甲乙丙") throw new Error("overlay broken");',
      "return { seen: back.data.content };",
    ].join("\n");
    const { srv, api, sessionId, workspaceId } = await boot([
      () => toolCallOut("tc1", "run_script", JSON.stringify({ code })),
      () => textOut("完成"),
    ]);
    const before = seedWorkbooks(srv.workspaceRoot, files);
    const items = await runScript(api, sessionId, { code });
    const r = scriptResult(items, "tc1")!;
    expect(r.data.status).toBe("ok");
    const res = r.data.result as {
      data: {
        value: { seen: string };
        published: Array<{ path: string; kind: string; docId?: string; rev?: number }>;
      };
      docRevs: Record<string, number>;
    };
    expect(res.data.value.seen).toBe("暂存内容-甲乙丙");
    expect(res.data.published).toHaveLength(6);
    const pubPaths = res.data.published.map((p) => p.path).sort();
    expect(pubPaths).toEqual([...files, "notes/out.txt"].sort());
    // 每个文档恰好一个新修订且单元格已写入
    const db = dbFile(srv);
    for (const f of files) {
      const docId = res.data.published.find((p) => p.path === f)!.docId!;
      const ops = db
        .prepare("SELECT rev FROM doc_ops WHERE doc_id = ? ORDER BY rev")
        .all(docId) as { rev: number }[];
      expect(ops.length).toBe(1);
      expect(res.docRevs[docId]).toBe(ops[0]!.rev);
      expect(await cellValue(api, workspaceId, f, "B2")).toBe("脚本写入");
      // xlsx 是异步检查点（07 §1）：doc_ops 是先验事实，文件稍后写回
      const t0 = Date.now();
      while (sha256File(join(srv.workspaceRoot, f)) === before[f]) {
        if (Date.now() - t0 > 10_000) throw new Error(`${f} 检查点未写回`);
        await sleep(50);
      }
    }
    expect(readFileSync(join(srv.workspaceRoot, "notes/out.txt"), "utf8")).toBe("暂存内容-甲乙丙");
  }, 90_000);

  test("发布失败回滚：审批窗口删目标目录 → 文本发布失败 → doc1 已提交被逆操作回退", async () => {
    // 修订后预演（dryRun）会提前拦截 BAD_OPERATION，真实发布中失败只能发生在
    // 计划之后的窗口：confirm 模式审批挂起时删除 notes/，批准后 doc 先提交、
    // 文本发布 ENOENT → 走真实回滚路径。
    const code = [
      'await wb.edit({ path: "r1.xlsx", ops: [{ op: "cells.set", range: "销售!C1", values: [["改了"]] }] });',
      'await files.writeText({ path: "notes/deep.txt", content: "脚本覆盖" });',
    ].join("\n");
    const { srv, api, sessionId, workspaceId } = await boot(
      [() => toolCallOut("tc1", "run_script", JSON.stringify({ code })), () => textOut("完成")],
      "confirm",
    );
    seedWorkbooks(srv.workspaceRoot, ["r1.xlsx"]);
    mkdirSync(join(srv.workspaceRoot, "notes"), { recursive: true });
    writeFileSync(join(srv.workspaceRoot, "notes", "deep.txt"), "原文");
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "rb1", text: "跑脚本" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "approval.requested"),
      "approval.requested",
    );
    const approvalId = String(items.find((r) => r.type === "approval.requested")!.data.approvalId);
    // 审批等待期间删掉目标目录 → 真实文本发布必然 ENOENT
    rmSync(join(srv.workspaceRoot, "notes"), { recursive: true, force: true });
    await api.decideApproval(approvalId, { decision: "approve" });
    const items2 = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "轮完成",
    );
    const r = scriptResult(items2, "tc1")!;
    expect(r.data.status).toBe("error");
    const res = r.data.result as {
      error: { code: string; message: string };
      data?: { rolledBack?: string[] };
    };
    expect(res.data?.rolledBack).toContain("r1.xlsx");
    // doc1 的单元格被逆操作恢复到原值（sales.xlsx C1 原本非"改了"）
    expect(await cellValue(api, workspaceId, "r1.xlsx", "C1")).not.toBe("改了");
    // doc_ops：r1 有两条（提交 + 回退修订）
    const db = dbFile(srv);
    const rows = db
      .prepare(
        `SELECT d.path, COUNT(*) AS c FROM doc_ops o JOIN documents d ON d.id = o.doc_id
         WHERE o.tool_call_id = 'tc1' GROUP BY d.path`,
      )
      .all() as Array<{ path: string; c: number }>;
    const byPath = Object.fromEntries(rows.map((r2) => [r2.path, r2.c]));
    expect(byPath["r1.xlsx"]).toBe(2);
    // 文本发布失败：staged 副本已清，notes/ 保持删除态
    expect(existsSync(join(srv.workspaceRoot, "notes", "deep.txt"))).toBe(false);
  }, 90_000);

  test("场景17：死循环 1s 超时；期间 REST 仍 <200ms；之后池补位正常跑", async () => {
    const { api, sessionId } = await boot([
      () =>
        toolCallOut(
          "tc1",
          "run_script",
          JSON.stringify({ code: "while (true) {}", timeoutSeconds: 1 }),
        ),
      () => textOut("完成"),
      () => toolCallOut("tc2", "run_script", JSON.stringify({ code: "return 6 * 7" })),
      () => textOut("完成"),
    ]);
    const t0 = Date.now();
    const runP = runScript(api, sessionId, { code: "while (true) {}", timeoutSeconds: 1 });
    await sleep(200);
    const rt0 = Date.now();
    await api.listSessions();
    expect(Date.now() - rt0).toBeLessThan(200);
    const items = await runP;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(4000);
    const r = scriptResult(items, "tc1")!;
    const res = r.data.result as { error: { code: string } };
    expect(res.error.code).toBe("TIMEOUT");
    // 池补位：第二个正常脚本成功
    const items2 = await runScript(api, sessionId, { code: "return 6 * 7" }, "tc2", "m-tc2");
    const r2 = scriptResult(items2, "tc2")!;
    expect(r2.data.status).toBe("ok");
    expect((r2.data.result as { data: { value: number } }).data.value).toBe(42);
  }, 60_000);

  test("取消：死循环运行中 stop → CANCELLED + turn.interrupted，无发布", async () => {
    const code = [
      'await wb.edit({ path: "s1.xlsx", ops: [{ op: "cells.set", range: "销售!A1", values: [["v"]] }] });',
      "while (true) {}",
    ].join("\n");
    const { srv, api, sessionId } = await boot([
      () => toolCallOut("tc1", "run_script", JSON.stringify({ code, timeoutSeconds: 60 })),
      () => textOut("完成"),
    ]);
    const hashes = seedWorkbooks(srv.workspaceRoot, ["s1.xlsx"]);
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "m1", text: "跑脚本" });
    // 等工具 intent 出现（脚本已开始执行）再 stop
    await waitLog(
      api,
      sessionId,
      (items) => items.some((r) => r.type === "tool.intent" && r.data.toolName === "run_script"),
      "tool.intent",
    );
    await sleep(300);
    await api.stopAgent(sessionId, AGENT);
    const items = await waitLog(
      api,
      sessionId,
      (it) =>
        it.some((r) => r.type === "turn.interrupted") &&
        it.some((r) => r.type === "tool.result" && r.data.toolCallId === "tc1"),
      "turn.interrupted + tool.result",
    );
    const r = scriptResult(items, "tc1")!;
    const res = r.data.result as { error: { code: string } };
    expect(res.error.code).toBe("CANCELLED");
    expect(sha256File(join(srv.workspaceRoot, "s1.xlsx"))).toBe(hashes["s1.xlsx"]);
  }, 60_000);

  test("路径穿越与 .excelmanus 写禁：脚本内 SdkError；悬空/外指符号链接拒绝", async () => {
    const code = [
      "const out = [];",
      'try { await files.writeText({ path: "../outside.txt", content: "x" }); out.push("NO") } catch (e) { out.push(e.code) }',
      'try { await files.writeText({ path: ".excelmanus/x.txt", content: "x" }); out.push("NO") } catch (e) { out.push(e.code) }',
      'try { await files.writeText({ path: "link-out/escape.txt", content: "x" }); out.push("NO") } catch (e) { out.push(e.code) }',
      'try { await files.writeText({ path: "dangling/x.txt", content: "x" }); out.push("NO") } catch (e) { out.push(e.code) }',
      'try { await files.readText({ path: "link-out/secret.txt" }); out.push("NO") } catch (e) { out.push(e.code) }',
      "return out;",
    ].join("\n");
    const { srv, api, sessionId } = await boot([
      () => toolCallOut("tc1", "run_script", JSON.stringify({ code })),
      () => textOut("完成"),
    ]);
    const outside = join(srv.workspaceRoot, "..", `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "shh");
    symlinkSync(outside, join(srv.workspaceRoot, "link-out"), "junction");
    symlinkSync(join(outside, "nonexistent"), join(srv.workspaceRoot, "dangling"), "junction");
    const items = await runScript(api, sessionId, { code });
    const r = scriptResult(items, "tc1")!;
    expect(r.data.status).toBe("ok");
    const vals = (r.data.result as { data: { value: string[] } }).data.value;
    expect(vals[0]).toBe("OUT_OF_WORKSPACE");
    expect(vals[1]).toBe("NOT_FOUND");
    expect(vals[2]).toBe("OUT_OF_WORKSPACE");
    expect(vals[3]).toBe("OUT_OF_WORKSPACE");
    expect(vals[4]).toBe("OUT_OF_WORKSPACE");
    rmSync(outside, { recursive: true, force: true });
  }, 60_000);

  test("recover：有提交→uncertain、无提交→not_executed，暂存目录清理", async () => {
    const { srv, sessionId } = await boot([
      () => toolCallOut("tc1", "run_script", JSON.stringify({ code: "return 1" })),
      () => textOut("完成"),
    ]);
    // 直接调工具对象的 recover（不中断真实运行）
    const { runScriptTool } = await import("../src/script.ts");
    const { SandboxPool } = await import("@excelmanus/sandbox");
    const { DocumentService } = await import("@excelmanus/workbook");
    const db = dbFile(srv);
    const svc = new DocumentService(db);
    const pool = new SandboxPool({ size: 0 });
    const tool = runScriptTool({ sandbox: pool, documents: svc, tools: new Map(), db });
    // 场景A：无提交 → not_executed，暂存目录被清
    const stageDir = join(srv.workspaceRoot, ".excelmanus", "tmp", "script-tcA");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "s0"), "x");
    const rA = tool.recover!({
      sessionId,
      agentId: AGENT,
      toolCallId: "tcA",
      args: { code: "x" },
    });
    expect(rA?.status).toBe("not_executed");
    expect(existsSync(stageDir)).toBe(false);
    // 场景B：有提交 → uncertain
    const wsId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
    const created = await svc.create(wsId, srv.workspaceRoot, "rec.xlsx", sessionId, AGENT);
    const sub = await svc.submit(created.meta.id, srv.workspaceRoot, {
      baseRev: 0,
      source: { kind: "script", id: `${sessionId}/${AGENT}` },
      sessionId,
      toolCallId: "tcB",
      ops: [{ op: "cells.set", range: "A1", values: [["v"]] }],
    });
    expect(sub.ok).toBe(true);
    const stageDirB = join(srv.workspaceRoot, ".excelmanus", "tmp", "script-tcB");
    mkdirSync(stageDirB, { recursive: true });
    const rB = tool.recover!({
      sessionId,
      agentId: AGENT,
      toolCallId: "tcB",
      args: { code: "x" },
    });
    expect(rB?.status).toBe("uncertain");
    expect(rB?.error?.message).toContain("部分完成");
    // P1-15：判定不确定时保留暂存（含回滚副本）
    expect(existsSync(stageDirB)).toBe(true);
    // 场景C：只写文本的发布做到一半（清单已写、目标已替换）→ uncertain，.orig 保留
    const stageDirC = join(srv.workspaceRoot, ".excelmanus", "tmp", "script-tcC");
    mkdirSync(stageDirC, { recursive: true });
    const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    writeFileSync(join(srv.workspaceRoot, "t.txt"), "new");
    writeFileSync(join(stageDirC, "s0.orig"), "old");
    writeFileSync(
      join(stageDirC, "publish-texts.json"),
      JSON.stringify([
        {
          rel: "t.txt",
          before: sha256(new TextEncoder().encode("old")),
          after: sha256(new TextEncoder().encode("new")),
          rollbackFile: join(stageDirC, "s0.orig"),
        },
      ]),
    );
    const rC = tool.recover!({ sessionId, agentId: AGENT, toolCallId: "tcC", args: { code: "x" } });
    expect(rC?.status).toBe("uncertain");
    expect(rC?.error?.code).toBe("INTERNAL");
    expect(existsSync(join(stageDirC, "s0.orig"))).toBe(true);
    // 场景D：清单存在但半截（无法解析）→ fail-closed：uncertain，暂存与 .orig 保留
    const stageDirD = join(srv.workspaceRoot, ".excelmanus", "tmp", "script-tcD");
    mkdirSync(stageDirD, { recursive: true });
    writeFileSync(join(stageDirD, "s0.orig"), "old");
    writeFileSync(join(stageDirD, "publish-texts.json"), '[{"rel":"d.txt","bef');
    const rD = tool.recover!({ sessionId, agentId: AGENT, toolCallId: "tcD", args: { code: "x" } });
    expect(rD?.status).toBe("uncertain");
    expect(existsSync(join(stageDirD, "s0.orig"))).toBe(true);
    await svc.discardCreated(created.meta.id, srv.workspaceRoot, sessionId);
    await pool.close();
  }, 60_000);
});

describe("e2e run_script 发布时审批（ADR 0009 修订）", () => {
  test("脚本空工作簿复用工具规则：空 ops 预览、批准与持久化均成功，已有文件空 ops 被拒绝", async () => {
    const path = "脚本空工作簿.xlsx";
    const code = [
      'let error; try { await wb.edit({ path: "existing.xlsx", ops: [] }); } catch (e) { error = e.code; }',
      'await wb.edit({ path: "existing.xlsx", ops: [{ op: "sheet.delete", sheet: "参数" }] });',
      `await wb.edit({ path: ${JSON.stringify(path)}, create: true, ops: [] });`,
      "return error;",
    ].join("\n");
    const { srv, api, sessionId, workspaceId } = await boot(
      [
        () => toolCallOut("empty-script", "run_script", JSON.stringify({ code })),
        () => textOut("完成"),
      ],
      "confirm",
    );
    const before = seedWorkbooks(srv.workspaceRoot, ["existing.xlsx"]);
    await api.sendMessage(sessionId, AGENT, {
      clientMessageId: "script-empty",
      text: "生成空工作簿",
    });
    const pending = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "approval.requested"),
      "空工作簿审批",
    );
    const request = pending.find((r) => r.type === "approval.requested");
    if (!request) throw new Error("缺少审批");
    const plan = (request.data.args as { publishPlan: unknown[] }).publishPlan;
    expect(plan).toEqual([
      expect.objectContaining({
        path: "existing.xlsx",
        create: false,
        opsCount: 1,
        changes: { cellsBySheet: {}, ranges: [], structural: ["删除工作表（参数）"], added: [] },
      }),
      expect.objectContaining({
        path,
        create: true,
        opsCount: 0,
        sheets: [expect.objectContaining({ name: "Sheet1", cells: 0 })],
        changes: {
          cellsBySheet: {},
          ranges: [],
          structural: ["新增工作表（Sheet1）"],
          added: ["工作表 Sheet1"],
        },
      }),
    ]);
    expect(existsSync(join(srv.workspaceRoot, path))).toBe(false);
    expect(sha256File(join(srv.workspaceRoot, "existing.xlsx"))).toBe(before["existing.xlsx"]);
    await api.decideApproval(String(request.data.approvalId), { decision: "approve" });
    const done = await waitLog(
      api,
      sessionId,
      (i) =>
        i.some((r) => r.type === "turn.completed") && i.some((r) => r.type === "change.summary"),
      "空工作簿发布",
    );
    expect(scriptResult(done, "empty-script")?.data).toMatchObject({
      status: "ok",
      result: {
        data: {
          value: "INVALID_ARGUMENT",
          published: [
            {
              path: "existing.xlsx",
              rev: 1,
              changes: { cellsBySheet: {}, structural: ["删除工作表（参数）"] },
            },
            {
              path,
              created: true,
              rev: 1,
              sheets: [{ name: "Sheet1", cells: 0 }],
              changes: { cellsBySheet: {}, structural: ["新增工作表（Sheet1）"] },
            },
          ],
        },
      },
    });
    const { document } = await api.openDoc(workspaceId, { path });
    const db = dbFile(srv);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM doc_ops WHERE doc_id=? AND tool_call_id='empty-script'")
        .get(document.id),
    ).toMatchObject({ n: 1 });
    db.close();
    expect(await cellValue(api, workspaceId, path, "A1")).toBeUndefined();
  }, 60_000);

  test("confirm 模式批准：approval.requested 带 publishPlan，批准前两文件未动 → 批准后双发布", async () => {
    const code = [
      'await wb.edit({ path: "p1.xlsx", ops: [{ op: "cells.set", range: "销售!A1", values: [["P"]] }] });',
      'await files.writeText({ path: "new.txt", content: "line1\\nline2" });',
      'return "done";',
    ].join("\n");
    const { srv, api, sessionId, workspaceId } = await boot(
      [() => toolCallOut("tc1", "run_script", JSON.stringify({ code })), () => textOut("完成")],
      "confirm",
    );
    seedWorkbooks(srv.workspaceRoot, ["p1.xlsx"]);
    const before = sha256File(join(srv.workspaceRoot, "p1.xlsx"));

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "pa1", text: "跑脚本" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "approval.requested"),
      "approval.requested",
    );
    const req = items.find((r) => r.type === "approval.requested")!;
    const approvalId = String(req.data.approvalId);
    expect(req.data.targets).toEqual(expect.arrayContaining(["p1.xlsx", "new.txt"]));
    const plan = (req.data.args as { publishPlan?: unknown }).publishPlan as Record<
      string,
      unknown
    >[];
    const wbItem = plan.find((i) => i.path === "p1.xlsx")!;
    const txtItem = plan.find((i) => i.path === "new.txt")!;
    expect(wbItem.kind).toBe("workbook");
    expect(wbItem.opsCount).toBe(1);
    expect(Array.isArray(wbItem.preview) && (wbItem.preview as unknown[]).length > 0).toBe(true);
    expect(txtItem.kind).toBe("text");
    expect(txtItem.created).toBe(true);
    expect(String(txtItem.diffHead)).toContain("line1");
    // 批准前两个文件均未动
    expect(sha256File(join(srv.workspaceRoot, "p1.xlsx"))).toBe(before);
    expect(existsSync(join(srv.workspaceRoot, "new.txt"))).toBe(false);

    await api.decideApproval(approvalId, { decision: "approve" });
    const items2 = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "批准后轮完成",
    );
    const r = scriptResult(items2, "tc1")!;
    expect(r.data.status).toBe("ok");
    const res = r.data.result as { data?: { published?: unknown[] } };
    expect((res.data?.published ?? []).length).toBe(2);
    expect(await cellValue(api, workspaceId, "p1.xlsx", "A1")).toBe("P");
    expect(readFileSync(join(srv.workspaceRoot, "new.txt"), "utf8")).toBe("line1\nline2");
  }, 60_000);

  test("confirm 模式拒绝：APPROVAL_DENIED、文件不变、tmp 无残留", async () => {
    const code = [
      'await wb.edit({ path: "d1.xlsx", ops: [{ op: "cells.set", range: "销售!A1", values: [["D"]] }] });',
      'await files.writeText({ path: "d-new.txt", content: "nope" });',
      'return "done";',
    ].join("\n");
    const { srv, api, sessionId } = await boot(
      [() => toolCallOut("tc1", "run_script", JSON.stringify({ code })), () => textOut("被拒")],
      "confirm",
    );
    seedWorkbooks(srv.workspaceRoot, ["d1.xlsx"]);
    const before = sha256File(join(srv.workspaceRoot, "d1.xlsx"));

    await api.sendMessage(sessionId, AGENT, { clientMessageId: "pd1", text: "跑脚本" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "approval.requested"),
      "approval.requested",
    );
    const approvalId = String(items.find((r) => r.type === "approval.requested")!.data.approvalId);
    await api.decideApproval(approvalId, { decision: "deny", reason: "先别改" });

    const items2 = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "拒绝后轮完成",
    );
    const r = scriptResult(items2, "tc1")!;
    expect(r.data.status).toBe("error");
    expect((r.data.result as { error?: { code?: string } }).error?.code).toBe("APPROVAL_DENIED");
    expect(String((r.data.result as { error?: { message?: string } }).error?.message)).toContain(
      "先别改",
    );
    expect(sha256File(join(srv.workspaceRoot, "d1.xlsx"))).toBe(before);
    expect(existsSync(join(srv.workspaceRoot, "d-new.txt"))).toBe(false);
    expect(existsSync(tmpDir(srv)) ? readdirSync(tmpDir(srv)).length : 0).toBe(0);
  }, 60_000);

  test("写后读同一工作簿：SDK 抛 UNSUPPORTED_FEATURE", async () => {
    const code = [
      'await wb.edit({ path: "w.xlsx", ops: [{ op: "cells.set", range: "销售!A1", values: [["X"]] }] });',
      'try { await wb.read({ path: "w.xlsx" }); return "no-error"; }',
      "catch (e) { return e.code || e.message; }",
    ].join("\n");
    const { srv, api, sessionId } = await boot([
      () => toolCallOut("tc1", "run_script", JSON.stringify({ code })),
      () => textOut("完成"),
    ]);
    seedWorkbooks(srv.workspaceRoot, ["w.xlsx"]);
    await api.sendMessage(sessionId, AGENT, { clientMessageId: "pr1", text: "跑脚本" });
    const items = await waitLog(
      api,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "轮完成",
    );
    const r = scriptResult(items, "tc1")!;
    expect(r.data.status).toBe("ok");
    const res = r.data.result as { data?: { value?: unknown } };
    expect(String(res.data?.value)).toContain("UNSUPPORTED_FEATURE");
  }, 60_000);
});

test("script named creation expands the same atomic sheet operations", async () => {
  const code =
    'await wb.edit({create:true,path:"named-script.xlsx",sheetNames:["收款收据","核对"],ops:[{op:"cells.set",range:"收款收据!A1",values:[[5190]]}]});';
  const { api, sessionId, workspaceId } = await boot([
    () => toolCallOut("named-script", "run_script", JSON.stringify({ code })),
    () => textOut("完成"),
  ]);
  await api.sendMessage(sessionId, AGENT, {
    clientMessageId: "named-script",
    text: "新建具名工作表",
  });
  const done = await waitLog(
    api,
    sessionId,
    (items) => items.some((r) => r.type === "turn.completed"),
    "具名工作表发布",
  );
  expect(scriptResult(done, "named-script")?.data).toMatchObject({
    status: "ok",
    result: {
      data: {
        published: [
          {
            path: "named-script.xlsx",
            created: true,
            sheets: [
              { name: "收款收据", cells: 1 },
              { name: "核对", cells: 0 },
            ],
          },
        ],
      },
    },
  });
  expect(await cellValue(api, workspaceId, "named-script.xlsx", "收款收据!A1")).toBe(5190);
}, 60_000);

test("script wb.edit marks an existing pivot cache without refreshing saved results", async () => {
  const code = [
    'const before = await wb.read({path:"pivot-script.xlsx",mode:"objects"});',
    'await wb.edit({path:"pivot-script.xlsx",ops:[{op:"cells.set",range:"Sheet1!E3",values:[[8]]},{op:"pivot.mark_refresh_on_load",sheet:"Sheet1",cacheId:"0"}]});',
    "return before.data.preserved.pivotTableCount;",
  ].join("\n");
  const { srv, api, sessionId, workspaceId } = await boot([
    () => toolCallOut("pivot-script", "run_script", JSON.stringify({ code })),
    () => textOut("完成"),
  ]);
  const source = Buffer.from(
    readFileSync(
      new URL("../../modules/workbook/test/fixtures/pivot-slicer.xlsx.base64", import.meta.url),
      "utf8",
    ),
    "base64",
  );
  writeFileSync(join(srv.workspaceRoot, "pivot-script.xlsx"), source);
  await api.sendMessage(sessionId, AGENT, { clientMessageId: "pivot-script", text: "跑脚本" });
  const done = await waitLog(
    api,
    sessionId,
    (items) =>
      items.some((item) => item.type === "tool.result" && item.data.toolCallId === "pivot-script"),
    "透视缓存脚本回执",
  );
  expect(
    scriptResult(done, "pivot-script")?.data,
    JSON.stringify(scriptResult(done, "pivot-script")?.data),
  ).toMatchObject({
    status: "ok",
    result: {
      data: { value: 1, published: [{ path: "pivot-script.xlsx", kind: "workbook", rev: 1 }] },
    },
  });
  expect(await cellValue(api, workspaceId, "pivot-script.xlsx", "Sheet1!E3")).toBe(8);
  expect(await cellValue(api, workspaceId, "pivot-script.xlsx", "Sheet1!L20")).toBe(13);
  const { importXlsx } = await import("../../modules/workbook/src/xlsx.ts");
  const { objectsOf } = await import("../../modules/workbook/src/objects.ts");
  await expect
    .poll(
      () => {
        const snapshot = importXlsx(
          readFileSync(join(srv.workspaceRoot, "pivot-script.xlsx")),
          "pivot-script.xlsx",
        ).snapshot;
        return objectsOf(snapshot.sheets[snapshot.sheetOrder[0]!]).pivotRefreshOnLoad;
      },
      { timeout: 10000 },
    )
    .toEqual({ "0": "true" });
  const downloaded = await api.downloadFile(workspaceId, "pivot-script.xlsx");
  const saved = importXlsx(
    new Uint8Array(await downloaded.arrayBuffer()),
    "pivot-script.xlsx",
  ).snapshot;
  expect(objectsOf(saved.sheets[saved.sheetOrder[0]!]).pivotRefreshOnLoad).toEqual({ "0": "true" });
}, 60000);
