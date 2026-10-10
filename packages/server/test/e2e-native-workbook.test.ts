import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { unzipSync } from "fflate";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";

test("真实 HTTP/SQLite/工具链创建汇总、原生图表和规则，工具与轮次摘要含图表，重启后仍可读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-native-e2e-"));
  let calls = 0;
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  };
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      const parts: LanguageModelV4StreamPart[] =
        calls === 1
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "native",
                toolName: "workbook_edit",
                input: JSON.stringify({
                  create: true,
                  path: "report.xlsx",
                  ops: [
                    { op: "sheet.rename", sheet: "Sheet1", name: "Report" },
                    {
                      op: "cells.set",
                      range: "Report!A1:B3",
                      values: [
                        ["地区", "金额"],
                        ["东", 300],
                        ["西", 100],
                      ],
                    },
                    {
                      op: "chart.add",
                      sheet: "Report",
                      type: "column",
                      title: "地区汇总",
                      range: "A1:B3",
                    },
                    {
                      op: "cf.add",
                      range: "Report!B2:B3",
                      kind: "number",
                      operator: "greaterThan",
                      values: [200],
                      fill: "#FFFF00",
                    },
                    {
                      op: "dv.add",
                      range: "Report!B2:B3",
                      type: "decimal",
                      operator: "between",
                      formula1: "0",
                      formula2: "1000",
                    },
                  ],
                }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "已完成汇总和原生图表" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  });
  let server = await startServer({
    dataDir: dir,
    resolveLanguageModel: () => model,
    log: () => {},
  });
  try {
    const api = createApiClient(server.url, server.token);
    await api.createModelProfile({
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock",
      apiKey: "synthetic",
    });
    const { session } = await api.createSession({ permissionMode: "auto" });
    await api.sendMessage(session.id, "main", {
      clientMessageId: "native",
      text: "生成汇总、图表、规则",
    });
    let records = (await api.getSessionLog(session.id, { limit: 500 })).items;
    const until = Date.now() + 10000;
    while (!records.some((r) => r.type === "change.summary")) {
      if (Date.now() > until)
        throw new Error(
          JSON.stringify(records.filter((r) => ["tool.result", "turn.failed"].includes(r.type))),
        );
      await new Promise((r) => setTimeout(r, 30));
      records = (await api.getSessionLog(session.id, { limit: 500 })).items;
    }
    expect(records.find((r) => r.type === "tool.result")?.data.status).toBe("ok");
    expect(JSON.stringify(records.filter((r) => r.type === "change.summary"))).toContain(
      "新增图表",
    );
    const { document } = await api.openDoc(session.workspaceId, { path: "report.xlsx" });
    const before = (await api.getDocSnapshot(session.workspaceId, document.id)).snapshot;
    expect(JSON.stringify(before)).toContain("地区汇总");
    await server.close();
    const parts = unzipSync(readFileSync(join(dir, "workspace/report.xlsx")));
    expect(Object.keys(parts).filter((p) => /^xl\/charts\/.+\.xml$/.test(p))).toHaveLength(1);
    server = await startServer({ dataDir: dir, log: () => {} });
    const api2 = createApiClient(server.url, server.token);
    const reopened = await api2.openDoc(session.workspaceId, { path: "report.xlsx" });
    const after = (await api2.getDocSnapshot(session.workspaceId, reopened.document.id)).snapshot;
    expect(JSON.stringify(after)).toContain("地区汇总");
    expect(JSON.stringify(after)).toContain("SHEET_CONDITIONAL_FORMATTING_PLUGIN");
    expect(JSON.stringify(after)).toContain("SHEET_DATA_VALIDATION_PLUGIN");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
