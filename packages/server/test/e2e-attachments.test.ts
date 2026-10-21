import { createTestProfile } from "./fixtures/create-model.ts";
// 图片附件 e2e（01 §3、04 §7、11 §4）：真实 HTTP + SQLite + blob 存储，假模型只记录收到的提示。
// 上传 → 发消息带附件 → 模型收到图片（视觉开）/文字说明（视觉关）；非图片与未上传附件被拒。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Prompt, LanguageModelV4Usage } from "@ai-sdk/provider";
import { ApiError, createApiClient } from "@excelmanus/protocol";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// 1×1 透明 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e：图片附件", () => {
  test("上传、校验、送达模型（视觉开 / 关）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-e2e-att-"));
    dirs.push(dataDir);
    const prompts: LanguageModelV4Prompt[] = [];
    const srv = await startServer({
      dataDir,
      resolveLanguageModel: () =>
        new MockLanguageModelV4({
          provider: "mock",
          modelId: "mock-att",
          doStream: async (opts) => {
            prompts.push(opts.prompt);
            return {
              stream: new ReadableStream({
                start(c) {
                  c.enqueue({ type: "stream-start", warnings: [] });
                  c.enqueue({ type: "text-start", id: "t" });
                  c.enqueue({ type: "text-delta", id: "t", delta: "看到了" });
                  c.enqueue({ type: "text-end", id: "t" });
                  c.enqueue({
                    type: "finish",
                    usage: USAGE,
                    finishReason: { unified: "stop", raw: "stop" },
                  });
                  c.close();
                },
              }),
            };
          },
        }),
      log: () => {},
    });
    servers.push(srv);
    const api = createApiClient(srv.url, srv.token);
    const { profile } = await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "mock-att",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "sk-test-1234",
    });

    // 上传：按内容判定类型；同内容去重；非图片拒绝
    const att = await api.uploadAttachment({ name: "a.png", data: new Blob([PNG]) });
    expect(att).toMatchObject({ mediaType: "image/png", name: "a.png", size: PNG.length });
    const again = await api.uploadAttachment({ name: "b.png", data: new Blob([PNG]) });
    expect(again.sha256).toBe(att.sha256);
    await expect(
      api.uploadAttachment({ name: "x.png", data: new Blob(["not an image"]) }),
    ).rejects.toMatchObject({ status: 415 });
    const back = Buffer.from(await (await api.getAttachment(att.sha256)).arrayBuffer());
    expect(back.equals(PNG)).toBe(true);

    const { session } = await api.createSession({});
    const waitTurns = async (n: number) => {
      for (let i = 0; i < 300; i++) {
        const log = await api.getSessionLog(session.id, { limit: 500 });
        if (log.items.filter((r) => r.type === "turn.completed").length >= n) return;
        await sleep(20);
      }
      throw new Error("等待 turn.completed 超时");
    };

    // 未上传的附件在受理前被拒（04 §4）
    await expect(
      api.sendMessage(session.id, "main", {
        clientMessageId: "bad",
        text: "看图",
        attachments: [{ ...att, sha256: "0".repeat(64) }],
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // 视觉开：图片作为 image part 送达
    await api.overrideCapabilities(profile.id, { vision: true });
    await api.sendMessage(session.id, "main", {
      clientMessageId: "m1",
      text: "",
      attachments: [att],
    });
    await waitTurns(1);
    const user1 = prompts.at(-1)?.findLast((m) => m.role === "user");
    const parts1 = (user1?.content ?? []) as { type: string; mediaType?: string }[];
    expect(JSON.stringify(parts1)).toContain("消息图片附件");
    expect(JSON.stringify(parts1)).toContain("未指定关联文件");
    expect(parts1.some((p) => p.type === "file" && p.mediaType === "image/png")).toBe(true);

    // 日志只存引用，不存图片内容
    const log = await api.getSessionLog(session.id, { limit: 500 });
    const userRec = log.items.find((r) => r.type === "user.message");
    expect(userRec?.data).toMatchObject({ text: "", attachments: [att] });
    expect(JSON.stringify(log)).not.toContain(PNG.toString("base64"));

    // 视觉关：不发图片，改为文字说明
    await api.overrideCapabilities(profile.id, { vision: false });
    await api.sendMessage(session.id, "main", {
      clientMessageId: "m2",
      text: "再看一张",
      attachments: [att],
    });
    await waitTurns(2);
    const user2 = prompts.at(-1)?.findLast((m) => m.role === "user");
    const parts2 = (user2?.content ?? []) as { type: string; text?: string }[];
    expect(parts2.some((p) => p.type === "file")).toBe(false);
    expect(parts2.find((p) => p.type === "text")?.text).toContain("当前模型不支持图片");
  });
});
