import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient, DiagnosticTracesResponse } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

test("诊断导出只含元数据，不泄露会话标题、正文和设备令牌；日志按日落盘", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-diagnostics-"));
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: "PRIVATE_MODEL_REPLY_371" });
          c.enqueue({ type: "text-end", id: "t" });
          c.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 13, noCache: 13, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 7, text: 7, reasoning: 0 },
            },
          });
          c.close();
        },
      }),
    }),
  });
  const server = await startServer({ dataDir, log: () => {}, resolveLanguageModel: () => model });
  try {
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "test",
      provider: "custom-openai-compatible",
      model: "mock",
      apiKey: "sk-private-eval-1234567890",
    });
    const { session } = await api.createSession({ title: "PRIVATE_TITLE_731" });
    await api.sendMessage(session.id, "main", {
      clientMessageId: "diag",
      text: "PRIVATE_USER_PROMPT_991",
    });
    const until = Date.now() + 5000;
    while (!(await api.getSessionLog(session.id)).items.some((r) => r.type === "turn.completed")) {
      if (Date.now() > until) throw new Error("model did not complete");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
    const traces = await fetch(`${server.url}/api/v1/diagnostics/traces?sessionId=${session.id}`, {
      headers,
    });
    expect(traces.status).toBe(200);
    const data = DiagnosticTracesResponse.parse(await traces.json());
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items[0]?.sessionId).toBe(session.id);
    const exported = await fetch(`${server.url}/api/v1/diagnostics/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: session.id }),
    });
    expect(exported.status).toBe(200);
    const text = await exported.text();
    expect(text).not.toContain("PRIVATE_TITLE_731");
    expect(text).not.toContain(server.token);
    const pack = JSON.parse(text);
    expect(pack.protocolVersion).toBeGreaterThan(0);
    expect(pack.logs.length).toBeGreaterThan(0);
    expect(
      pack.traces.items.some((item: { inputTokens?: number }) => item.inputTokens === 13),
    ).toBe(true);
    expect(
      pack.traces.items.some(
        (item: { durationMs?: number }) => typeof item.durationMs === "number",
      ),
    ).toBe(true);
    for (const secret of [
      "PRIVATE_USER_PROMPT_991",
      "PRIVATE_MODEL_REPLY_371",
      "sk-private-eval-1234567890",
    ])
      expect(text).not.toContain(secret);
    const files = readdirSync(join(dataDir, "logs"));
    expect(files.some((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))).toBe(true);
    for (const file of files) {
      const contents = readFileSync(join(dataDir, "logs", file), "utf8");
      expect(contents).not.toContain(server.token);
      expect(contents).not.toContain("PRIVATE_TITLE_731");
    }
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);
