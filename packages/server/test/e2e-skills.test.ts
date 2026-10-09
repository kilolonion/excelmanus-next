import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { kernelProjections, SessionLog } from "@excelmanus/kernel";
import { createApiClient, type ServerMessage } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "excelmanus-skills-"));
let server: RunningServer | undefined;
let socket: WebSocket | undefined;
afterAll(async () => {
  socket?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: { text?: string }) => p.text ?? "").join("")
      : "";
const skillBody = readFileSync(
  new URL("../../../assets/skills/report-building/SKILL.md", import.meta.url),
  "utf8",
)
  .split("---")
  .slice(2)
  .join("---")
  .trim();

// 只替代模型输出；工具执行、日志、资源读取、接口与重建均使用产品实现。
function model() {
  let count = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const user = [...prompt].reverse().find((m) => m.role === "user");
      const command = textOf(user?.content);
      const lastTool = prompt.at(-1)?.role === "tool";
      let call: { name: string; args: unknown } | undefined;
      if (!lastTool) {
        if (command.includes("加载方法"))
          call = { name: "skill", args: { name: "report-building" } };
        if (command.includes("读取实例"))
          call = { name: "read", args: { path: "skill://report-building/references/examples.md" } };
        if (command.includes("直接读取"))
          call = { name: "workbook_read", args: { path: "sales.xlsx", mode: "overview" } };
        if (command.includes("加载缺失依赖"))
          call = { name: "skill", args: { name: "demo-route" } };
      }
      const parts: LanguageModelV4StreamPart[] = call
        ? [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: `skills-${++count}`,
              toolName: call.name,
              input: JSON.stringify(call.args),
            },
            { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
          ]
        : [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "完成" },
            { type: "text-end", id: "t" },
            { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
          ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const part of parts) c.enqueue(part);
            c.close();
          },
        }),
      };
    },
  });
}

test("任务技能在真实边界加载/读资源，缺依赖与禁用不能绕过，基础工具独立可用，投影可重建", async () => {
  server = await startServer({
    dataDir: join(root, "data"),
    resolveLanguageModel: () => modelInstance,
    log: () => {},
  });
  const api = createApiClient(server.url, server.token);
  copyFileSync(
    new URL("../../../samples/sales.xlsx", import.meta.url),
    join(server.workspaceRoot, "sales.xlsx"),
  );
  await api.createModelProfile({
    name: "test",
    provider: "custom-openai-compatible",
    model: "test",
    baseUrl: "https://test.invalid/v1",
    apiKey: "test",
  });
  const skills = (await api.listSkills()).items;
  expect(skills.map((s) => s.name)).not.toContain("excelmanus-guide");
  expect(skills.map((s) => s.name)).not.toContain("script-patterns");
  expect(skills.every((s) => s.available)).toBe(true);
  expect((await api.getSkill("report-building")).skill.resources).toContain(
    "references/examples.md",
  );
  const { session } = await api.createSession({});
  const events: ServerMessage[] = [];
  socket = new WebSocket(
    `${server.url.replace("http:", "ws:")}/api/v1/sync?ticket=${(await api.createTicket()).ticket}`,
  );
  socket.on("message", (data) => events.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket?.once("open", resolve);
    socket?.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "sub", topic: `session:${session.id}`, cursor: 0 }));
  await expect.poll(() => events.some((e) => e.type === "sub.ok")).toBe(true);

  let turn = 0;
  const send = async (text: string) => {
    await api.sendMessage(session.id, "main", { clientMessageId: `turn-${++turn}`, text });
    await expect
      .poll(
        async () =>
          (await api.getSessionLog(session.id)).items.filter((r) => r.type === "turn.completed")
            .length,
        { timeout: 15_000 },
      )
      .toBe(turn);
    return (await api.getSessionLog(session.id)).items;
  };
  await send("加载方法");
  const resourceLog = await send("读取实例");
  const results = resourceLog.filter((r) => r.type === "tool.result");
  expect(results).toHaveLength(2);
  expect(results.every((r) => r.data.status === "ok")).toBe(true);
  expect(JSON.stringify(results[0]?.data.result)).toContain("汇总报表与图表");
  expect(JSON.stringify(results[1]?.data.result)).toContain("650");
  await expect
    .poll(() => events.filter((e) => e.type === "rec" && e.record.type === "tool.result").length)
    .toBe(2);

  const source = join(root, "demo-route");
  mkdirSync(join(source, "references"), { recursive: true });
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: demo-route\ndescription: 示例路线\n---\n阅读 [实例](references/example.md)。\n",
  );
  writeFileSync(join(source, "references/example.md"), "示例引用 `workbook_missing`。\n");
  const preview = await api.importSkill(source, true);
  expect(preview.skills[0]?.available).toBe(false);
  expect(preview.skills[0]?.missingTools).toEqual(["workbook_missing"]);
  await api.importSkill(source, false);
  expect((await api.getSkill("demo-route")).skill.available).toBe(false);
  await expect(
    api.sendMessage(session.id, "main", { clientMessageId: "bad", text: "/demo-route" }),
  ).rejects.toThrow();
  const missingLog = await send("加载缺失依赖");
  expect(missingLog.filter((r) => r.type === "tool.result").at(-1)?.data.status).toBe("error");

  await send("/report-building 按地区汇总");
  const db = new DatabaseSync(join(server.dataDir, "excelmanus.db"));
  const context = db
    .prepare("SELECT item FROM agent_context WHERE session_id = ? ORDER BY agent_id, idx")
    .all(session.id);
  expect(JSON.stringify(context)).toContain(skillBody.split("\n")[0]);
  const freeze = db
    .prepare("SELECT system_prompt FROM agents WHERE session_id = ? AND id = 'main'")
    .get(session.id);
  for (const skill of (await api.listSkills()).items) await api.setSkillEnabled(skill.name, false);
  await expect(
    api.sendMessage(session.id, "main", { clientMessageId: "disabled", text: "/report-building" }),
  ).rejects.toThrow();
  const finalLog = await send("直接读取");
  const direct = finalLog.filter((r) => r.type === "tool.result").at(-1);
  expect(direct?.data.toolName).toBe("workbook_read");
  expect(direct?.data.status).toBe("ok");
  expect(
    db
      .prepare("SELECT system_prompt FROM agents WHERE session_id = ? AND id = 'main'")
      .get(session.id),
  ).toEqual(freeze);
  const before = db
    .prepare("SELECT * FROM agent_context WHERE session_id = ? ORDER BY agent_id, idx")
    .all(session.id);
  new SessionLog(db, { projections: kernelProjections() }).rebuild(session.id);
  expect(
    db
      .prepare("SELECT * FROM agent_context WHERE session_id = ? ORDER BY agent_id, idx")
      .all(session.id),
  ).toEqual(before);
  expect(finalLog.filter((r) => r.type === "tool.intent")).toHaveLength(
    finalLog.filter((r) => r.type === "tool.result").length,
  );
  db.close();
}, 40_000);
const modelInstance = model();

test("评测 CLI 使用真实提供商适配与文件回读，正确输出通过、错误总额失败且证据不含凭据", async () => {
  let wrongTotal = false;
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as { messages: { role: string }[] };
    const hasTool = input.messages.some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = hasTool
      ? { content: "完成" }
      : {
          tool_calls: [
            {
              index: 0,
              id: "eval-create",
              type: "function",
              function: {
                name: "workbook_edit",
                arguments: JSON.stringify({
                  path: "result.xlsx",
                  create: true,
                  ops: [
                    { op: "sheet.rename", sheet: "Sheet1", name: "Report" },
                    {
                      op: "cells.set",
                      range: "Report!A1:B4",
                      values: [
                        ["地区", "金额"],
                        ["华东", 300],
                        ["华南", 50],
                        ["合计", wrongTotal ? 999 : 350],
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        };
    const envelope = {
      id: "mock-eval",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock",
    };
    res.write(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
  const profilePath = join(root, "eval-profile.json");
  const key = "isolated-eval-secret-must-not-export";
  writeFileSync(
    profilePath,
    JSON.stringify({
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock",
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      apiKey: key,
    }),
  );
  const resultDir = join(root, "eval-results");
  const cli = new URL("../../../scripts/evaluate-skills.ts", import.meta.url);
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli.pathname, profilePath, "report-subtotal", "enabled", resultDir],
      { timeout: 30_000 },
    );
    expect(stdout).toContain("automaticChecksPassed");
    wrongTotal = true;
    await expect(
      promisify(execFile)(
        process.execPath,
        [cli.pathname, profilePath, "report-subtotal", "disabled", resultDir],
        { timeout: 30_000 },
      ),
    ).rejects.toMatchObject({ code: 1 });
    for (const name of readdirSync(resultDir)) {
      const raw = readFileSync(join(resultDir, name, "result.json"), "utf8");
      expect(raw).not.toContain(key);
      const report = JSON.parse(raw);
      expect(report.inputTokens).toBeGreaterThan(0);
      expect(report.wsRecords).toBeGreaterThan(0);
      expect(report.manualReview).toBe("pending");
      expect(report.outputsSaved).toBe(true);
      expect(report.status).toBe(
        name.includes("enabled") ? "automaticChecksPassed" : "outputMismatch",
      );
    }
  } finally {
    await new Promise<void>((close) => provider.close(() => close()));
  }
}, 65_000);
