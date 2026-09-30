// 场景 10（14 §5 #10）测试夹具：独立进程承载真实 startServer，
// 启动成功后向 stdout 打一行 JSON {url, token}，随后保持运行直到被 SIGKILL。
//
// 环境变量：
//   KILL_FIXTURE_MODE = "slow"    —— 首次模型调用返回 slow_write{block:true}
//                                  （tool.intent 落库后 execute 永久阻塞，模拟执行中被杀）
//                       "approve" —— 首次返回 slow_write{block:false}
//                                  （confirm 模式停在 approval.requested，批准后立刻完成）
//                       "text"    —— 永远返回文本（供重启后的进程使用）
// 每次模型调用的 prompt 追加写入 <dataDir>/prompts.jsonl，供测试进程断言。

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { CapabilityModule, ToolDefinition } from "@excelmanus/kernel";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { startServer } from "../../src/index.ts";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: kill-server.ts <dataDir>");
  process.exit(2);
}
const mode = process.env.KILL_FIXTURE_MODE ?? "slow";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const streamOf = (parts: LanguageModelV4StreamPart[]) =>
  new ReadableStream<LanguageModelV4StreamPart>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

const textOut = (text: string) => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ]),
});

const slowWriteCall = () => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "sw-1",
      toolName: "slow_write",
      input: JSON.stringify({ path: "a.txt", block: mode === "slow" }),
    },
    { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
  ]),
});

const slowInput = z.strictObject({
  path: z.string().min(1),
  block: z.boolean().optional(),
});

/** 测试专用工具：block=true 时在 tool.intent 落库后永久阻塞，模拟执行中被 SIGKILL。 */
const slowWrite: ToolDefinition<z.infer<typeof slowInput>> = {
  name: "slow_write",
  title: "慢写入（测试）",
  description: "测试专用：block 时永久阻塞模拟执行中，否则立即返回 ok。",
  input: slowInput,
  output: z.record(z.string(), z.unknown()),
  effect: "write",
  targets: (a) => [a.path],
  replay: "unsafe",
  timeoutMs: 300_000,
  roles: ["main", "lead", "worker", "reader"],
  async execute(args) {
    if (args.block) await new Promise<never>(() => {});
    return { status: "ok", data: { path: args.path } };
  },
};

const testModule: CapabilityModule = { id: "kill-fixture", tools: [slowWrite] };

// 计数挂在模块级（非模型实例闭包）：resolveLanguageModel 每个步骤都会新建模型实例。
let calls = 0;
const srv = await startServer({
  dataDir,
  modules: [testModule],
  resolveLanguageModel: () =>
    new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-kill",
      doStream: async (opts) => {
        calls += 1;
        appendFileSync(join(dataDir, "prompts.jsonl"), `${JSON.stringify(opts.prompt)}\n`);
        if (mode === "text" || calls > 1) return textOut("已重新读取");
        return slowWriteCall();
      },
    }),
  log: () => {},
});
process.stdout.write(`${JSON.stringify({ url: srv.url, token: srv.token })}\n`);
