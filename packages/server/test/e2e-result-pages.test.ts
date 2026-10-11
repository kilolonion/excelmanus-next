import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";

test("超长脚本结果可用同一工具 cursor 续取，续取不重新执行脚本", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-pages-"));
  let nextCursor: string | undefined;
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      const text = JSON.stringify(options.prompt);
      if (calls === 2) {
        // AI SDK tool-result 中的 JSON output 是结构化值，不从可见正文猜测执行参数。
        const visit = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          if ("cursor" in value && typeof value.cursor === "string") nextCursor = value.cursor;
          for (const child of Object.values(value)) visit(child);
        };
        visit(options.prompt);
        expect(text).toContain("preview");
        expect(nextCursor).toMatch(/^result:/);
      }
      const parts =
        calls <= 2
          ? [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: `call-${calls}`,
                toolName: "run_script",
                input: JSON.stringify(
                  calls === 1
                    ? { code: "return 'A'.repeat(40000)" }
                    : { code: "throw new Error('MUST_NOT_EXECUTE')", cursor: nextCursor },
                ),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ]
          : [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: "done" },
              { type: "text-end" as const, id: "t" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  const server = await startServer({ dataDir, resolveLanguageModel: () => model, log: () => {} });
  try {
    const api = createApiClient(server.url, server.token);
    await api.createModelProfile({
      name: "test",
      provider: "custom-openai-compatible",
      model: "test",
      apiKey: "synthetic",
    });
    const { session } = await api.createSession({ permissionMode: "auto" });
    await api.sendMessage(session.id, "main", { clientMessageId: "pages", text: "执行并续取结果" });
    let items = (await api.getSessionLog(session.id)).items;
    for (
      let i = 0;
      i < 300 && !items.some((row) => row.type === "turn.completed" || row.type === "turn.failed");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      items = (await api.getSessionLog(session.id)).items;
    }
    expect(nextCursor).toBeDefined();
    const second = items.find(
      (row) => row.type === "tool.result" && row.data.toolCallId === "call-2",
    );
    expect(second?.data).toMatchObject({
      status: "ok",
      result: { data: { sourceSeq: expect.any(Number), chunk: expect.any(String) } },
    });
    expect(
      items.find((row) => row.type === "tool.intent" && row.data.toolCallId === "call-2")?.data
        .replay,
    ).toBe("safe");
    expect(items.some((row) => row.type === "turn.failed")).toBe(false);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 20000);
