import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

test("模型流运行时关闭服务器：中止 actor 后再关闭数据库，不留下迟到写入", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-shutdown-"));
  let entered = false;
  let cancelled = false;
  const model = new MockLanguageModelV4({
    doStream: async (options) => ({
      stream: new ReadableStream({
        start(controller) {
          entered = true;
          controller.enqueue({ type: "stream-start", warnings: [] });
          const abort = () => {
            cancelled = true;
            controller.error(new DOMException("aborted", "AbortError"));
          };
          if (options.abortSignal?.aborted) abort();
          else options.abortSignal?.addEventListener("abort", abort, { once: true });
        },
      }),
    }),
  });
  const server = await startServer({ dataDir, resolveLanguageModel: () => model, log: () => {} });
  try {
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "test",
      provider: "custom-openai-compatible",
      model: "test",
      apiKey: "synthetic",
    });
    const { session } = await api.createSession({});
    await api.sendMessage(session.id, "main", { clientMessageId: "shutdown", text: "hello" });
    for (let i = 0; i < 100 && !entered; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(entered).toBe(true);
    await server.close();
    expect(cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 15000);
