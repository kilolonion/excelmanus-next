import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// A real runtime request proves the host restriction is not a model convention or a post-filter.
test("explicit directory restriction rejects a root find even when its glob only matches the allowed directory", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "scoped-file-access-"));
  let first = true;
  const server = await startServer({
    dataDir,
    log: () => {},
    resolveLanguageModel: () =>
      new MockLanguageModelV4({
        provider: "mock",
        modelId: "scoped-file-access",
        doStream: async () => {
          const parts: LanguageModelV4StreamPart[] = first
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "find-root",
                  toolName: "find",
                  input: JSON.stringify({ path: ".", glob: "allowed/*.txt" }),
                },
                {
                  type: "finish",
                  usage,
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "done" },
                { type: "text-delta", id: "done", delta: "停止" },
                { type: "text-end", id: "done" },
                { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
              ];
          first = false;
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
              },
            }),
          };
        },
      }),
  });
  try {
    mkdirSync(join(server.workspaceRoot, "allowed"));
    mkdirSync(join(server.workspaceRoot, "sibling"));
    writeFileSync(join(server.workspaceRoot, "allowed/report.txt"), "allowed");
    writeFileSync(join(server.workspaceRoot, "sibling/report.txt"), "private sibling");
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "scoped-file-access",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", {
      clientMessageId: "restricted-find",
      text: "only search within allowed. Find the report.txt file without accessing any other directory.",
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { items } = await api.getSessionLog(session.id, { limit: 500 });
      const result = items.find(
        (item) => item.type === "tool.result" && item.data.toolCallId === "find-root",
      );
      if (result?.type === "tool.result") {
        expect(result.data.result).toMatchObject({
          status: "error",
          error: { code: "INVALID_ARGUMENT" },
        });
        break;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the root find result");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readFileSync(join(server.workspaceRoot, "sibling/report.txt"), "utf8")).toBe(
      "private sibling",
    );
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);
