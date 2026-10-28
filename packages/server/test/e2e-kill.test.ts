import { createTestProfile } from "./fixtures/create-model.ts";
// 场景 10（14 §5 #10、§3 跨进程恢复门禁）：写入工具执行中 SIGKILL 后端进程，
// 用同一数据目录重启独立进程，验证不重放 + 合成 tool.result + resume 后续轮。
// 第二个用例覆盖场景 9 的 SIGKILL 版：审批待决时被杀，重启后批准续行。
// 与既有同进程 close() 测试不同：这里 spawn 真实子进程（test/fixtures/kill-server.ts），
// 中间是真实 SIGKILL，满足 14 §3「两个独立进程」的要求。

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type ApiClient, createApiClient, type LogRecord } from "@excelmanus/protocol";
import { afterAll, describe, expect, test } from "vitest";

const FIXTURE = fileURLToPath(new URL("./fixtures/kill-server.ts", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface FixtureProc {
  proc: ChildProcess;
  url: string;
  token: string;
  exited: Promise<number | null>;
}

/** 启动夹具子进程，读 stdout 首行 {url, token} 即就绪（startServer 已在监听）。 */
function spawnFixture(dataDir: string, mode: string): Promise<FixtureProc> {
  const proc = spawn(process.execPath, [FIXTURE, dataDir], {
    env: { ...process.env, KILL_FIXTURE_MODE: mode },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(proc);
  const exited = new Promise<number | null>((resolve) => {
    proc.once("exit", (code) => resolve(code));
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("夹具启动超时")), 20_000);
    proc.stdout?.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        const { url, token } = JSON.parse(buf.slice(0, nl)) as {
          url: string;
          token: string;
        };
        resolve({ proc, url, token, exited });
      } catch (e) {
        reject(new Error(`夹具输出无法解析：${buf.slice(0, nl)}（${String(e)}）`));
      }
    });
    proc.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`夹具提前退出 code=${code}`));
    });
  });
}

async function boot(api: ApiClient, permissionMode?: "confirm"): Promise<string> {
  await createTestProfile(api, {
    name: "mock-kill",
    provider: "custom-openai-compatible",
    model: "mock-kill",
    baseUrl: "https://mock.invalid/v1",
    apiKey: "test",
  });
  const { session } = await api.createSession(permissionMode ? { permissionMode } : {});
  return session.id;
}

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
      throw new Error(`等待超时：${what}；types=${JSON.stringify(items.map((r) => r.type))}`);
    }
    await sleep(20);
  }
}

/** 夹具进程里每次模型调用的 prompt（每行一个 JSON 数组）。 */
const prompts = (dataDir: string): string[] =>
  readFileSync(join(dataDir, "prompts.jsonl"), "utf8").trim().split("\n");

describe("场景 10：写入工具执行中 SIGKILL（14 §5 #10、§3 跨进程恢复）", () => {
  test("执行中强杀 → 重启合成 uncertain + 不重放 → resume 后续轮携带合成结果", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-kill-"));
    dirs.push(dataDir);

    // 进程 1：slow_write 在 tool.intent 落库后永久阻塞，模拟「执行中」被杀。
    const p1 = await spawnFixture(dataDir, "slow");
    const api1 = createApiClient(p1.url, p1.token);
    const sessionId = await boot(api1);
    await api1.sendMessage(sessionId, "main", { clientMessageId: "kill-1", text: "写文件" });
    const items1 = await waitLog(
      api1,
      sessionId,
      (i) => i.some((r) => r.type === "tool.intent" && r.data.toolName === "slow_write"),
      "slow_write intent",
    );
    expect(items1.some((r) => r.type === "tool.result")).toBe(false);
    // open_intents 投影里有该调用（日志与投影同事务；execute 仍在阻塞）。
    const probe = new DatabaseSync(join(dataDir, "excelmanus.db"));
    try {
      const open = probe
        .prepare("SELECT tool_call_id FROM open_intents WHERE session_id = ?")
        .all(sessionId) as { tool_call_id: string }[];
      expect(open.map((r) => r.tool_call_id)).toEqual(["sw-1"]);
    } finally {
      probe.close();
    }

    // SIGKILL 执行中的进程，等其退出。
    p1.proc.kill("SIGKILL");
    await p1.exited;

    // 进程 2：同一数据目录启动（mode=text，重启后模型只回文本）。
    const p2 = await spawnFixture(dataDir, "text");
    const api2 = createApiClient(p2.url, p2.token);
    // 启动恢复同步写合成结果；读到时断言。
    const items2 = await waitLog(
      api2,
      sessionId,
      (i) => i.some((r) => r.type === "turn.interrupted"),
      "turn.interrupted",
    );
    const intents = items2.filter((r) => r.type === "tool.intent" && r.data.toolCallId === "sw-1");
    expect(intents).toHaveLength(1); // 没有任何自动重放
    const result = items2.find((r) => r.type === "tool.result" && r.data.toolCallId === "sw-1");
    expect(result?.data.status).toBe("uncertain"); // replay:"unsafe"、无 recover
    const session = await api2.getSession(sessionId);
    expect(session.agents[0]?.status).toBe("interrupted");

    // resume：interrupted 代理开无派发继续轮，prompt 携带合成工具结果。
    const resumed = await api2.resumeAgent(sessionId, "main");
    expect(resumed.started).toBe(true);
    await waitLog(
      api2,
      sessionId,
      (i) => i.filter((r) => r.type === "turn.completed").length >= 1,
      "继续轮完成",
    );
    expect(prompts(dataDir).at(-1)).toContain("结果不确定");
    const after = await api2.getSession(sessionId);
    expect(after.agents[0]?.status).toBe("idle");
  }, 60_000);

  test("场景 9 SIGKILL 版：审批待决时强杀 → 重启后批准续行原轮", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-kill-"));
    dirs.push(dataDir);

    // 进程 1：confirm 模式下 slow_write 在 approval.requested 处挂起（execute 未开始）。
    const p1 = await spawnFixture(dataDir, "approve");
    const api1 = createApiClient(p1.url, p1.token);
    const sessionId = await boot(api1, "confirm");
    await api1.sendMessage(sessionId, "main", {
      clientMessageId: "kill-approve",
      text: "写文件",
    });
    const items1 = await waitLog(
      api1,
      sessionId,
      (i) => i.some((r) => r.type === "approval.requested"),
      "approval.requested",
    );
    const approvalId = String(items1.find((r) => r.type === "approval.requested")?.data.approvalId);

    p1.proc.kill("SIGKILL");
    await p1.exited;

    // 进程 2：pending_interactions 持久化，审批仍待决；代理 blocked 不被 open-intent 恢复误伤。
    const p2 = await spawnFixture(dataDir, "text");
    const api2 = createApiClient(p2.url, p2.token);
    const items2 = await api2.getSessionLog(sessionId, { limit: 500 });
    expect(items2.items.some((r) => r.type === "tool.result")).toBe(false);
    expect(items2.items.some((r) => r.type === "turn.interrupted")).toBe(false);
    const decided = await api2.decideApproval(approvalId, { decision: "approve" });
    expect(decided.approval.status).toBe("approved");
    expect(decided.idempotent).toBe(false); // 首次决定，证明审批在重启后仍 pending
    const again = await api2.decideApproval(approvalId, { decision: "approve" });
    expect(again.idempotent).toBe(true);

    // 批准后执行工具并继续原轮：新增模型调用、轮收口，全程只有一条 turn.started。
    const items3 = await waitLog(
      api2,
      sessionId,
      (i) => i.some((r) => r.type === "turn.completed"),
      "批准后轮完成",
    );
    expect(items3.filter((r) => r.type === "turn.started")).toHaveLength(1);
    const result = items3.find((r) => r.type === "tool.result" && r.data.toolCallId === "sw-1");
    expect(result?.data.status).toBe("ok");
    expect(prompts(dataDir).length).toBeGreaterThanOrEqual(2); // 批准后续步模型调用发生了
  }, 60_000);

  test("多代理 SIGKILL：queued 子代理恢复为 interrupted，两个 worker resume 后完成", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-kill-team-"));
    dirs.push(dataDir);

    // 进程 1（team）：main 派生两个 worker；maxConcurrentSubAgents=1，
    // 一个进永久阻塞的 slow_write，另一个被并发闸门排队。
    const p1 = await spawnFixture(dataDir, "team");
    const api1 = createApiClient(p1.url, p1.token);
    const sessionId = await boot(api1);
    await api1.sendMessage(sessionId, "main", { clientMessageId: "tk-1", text: "并行做两件事" });
    await waitLog(
      api1,
      sessionId,
      (i) =>
        i.some((r) => r.type === "tool.intent" && r.data.toolName === "slow_write") &&
        i.some(
          (r) => r.type === "agent.status" && (r.data as { status?: string }).status === "queued",
        ),
      "slow_write intent + queued worker",
    );
    const detail1 = await api1.getSession(sessionId);
    const workers = detail1.agents.filter((a) => a.id !== "main");
    expect(workers).toHaveLength(2);
    const queuedWorker = workers.find((a) => a.status === "queued");
    const busyWorker = workers.find((a) => a.status !== "queued");
    expect(queuedWorker).toBeDefined();
    expect(busyWorker).toBeDefined();
    const busyId = String(busyWorker?.id);
    const queuedId = String(queuedWorker?.id);

    p1.proc.kill("SIGKILL");
    await p1.exited;

    // 进程 2（text）：两个 worker 都被恢复为 interrupted。
    const p2 = await spawnFixture(dataDir, "text");
    const api2 = createApiClient(p2.url, p2.token);
    const detail2 = await api2.getSession(sessionId);
    const after = detail2.agents.filter((a) => a.id !== "main");
    expect(after).toHaveLength(2);
    for (const a of after) expect(a.status).toBe("interrupted");

    const items2 = (await api2.getSessionLog(sessionId, { limit: 500 })).items;
    // 执行中的 worker：1 条 intent、1 条合成的 uncertain 结果、1 条 turn.interrupted。
    expect(items2.filter((r) => r.type === "tool.intent" && r.agentId === busyId)).toHaveLength(1);
    expect(
      items2.filter(
        (r) => r.type === "tool.result" && r.agentId === busyId && r.data.status === "uncertain",
      ),
    ).toHaveLength(1);
    expect(items2.some((r) => r.type === "turn.interrupted" && r.agentId === busyId)).toBe(true);
    // 排队中的 worker：没有进行中的轮——不写 turn.interrupted，不合成 tool.result。
    expect(items2.some((r) => r.type === "turn.interrupted" && r.agentId === queuedId)).toBe(false);
    expect(items2.filter((r) => r.type === "tool.result" && r.agentId === queuedId)).toHaveLength(
      0,
    );
    expect(items2.filter((r) => r.type === "tool.intent" && r.agentId === queuedId)).toHaveLength(
      0,
    );
    // 它的待处理派发保持不动（accepted/queued，未 applied）。
    const dispatchId = String(
      items2.find((r) => r.type === "user.message" && r.agentId === queuedId)?.data.dispatchId ??
        "",
    );
    expect(dispatchId).not.toBe("");
    const dispUpdates = items2.filter(
      (r) =>
        r.type === "dispatch.updated" &&
        (r.data as { dispatchId?: string }).dispatchId === dispatchId,
    );
    const lastStatus = String(
      (dispUpdates.at(-1)?.data as { status?: string } | undefined)?.status ?? "",
    );
    expect(["accepted", "queued"]).toContain(lastStatus);

    // 分别 resume：两个 worker 都开新一轮并完成（text 模式永远返回文本）。
    for (const id of [busyId, queuedId]) {
      await api2.controlAgent(sessionId, id, { action: "resume" });
    }
    const items3 = await waitLog(
      api2,
      sessionId,
      (i) =>
        [busyId, queuedId].every((id) =>
          i.some((r) => r.type === "turn.completed" && r.agentId === id),
        ),
      "两个 worker 续轮完成",
      20_000,
    );
    for (const id of [busyId, queuedId]) {
      expect(items3.some((r) => r.type === "turn.started" && r.agentId === id)).toBe(true);
    }
  }, 60_000);
});
