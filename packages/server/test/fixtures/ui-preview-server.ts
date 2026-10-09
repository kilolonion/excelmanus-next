// 前端页面复核夹具（16 §6）：真实 startServer + 真实工具/日志/同步通道，假模型只替代模型输出。
// 用法：node packages/server/test/fixtures/ui-preview-server.ts <dataDir> [port] [webDist]
// 每条用户消息触发同一段脚本：思考 → 读取工作簿 → 区域确认提问 → 写入（confirm 模式下走审批）→ 带表格与区域引用的总结。
// 消息含「失败」时改为一次模型认证错误，用于检查错误指引。

import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { startServer } from "../../src/index.ts";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: ui-preview-server.ts <dataDir> [port]");
  process.exit(2);
}
const port = process.argv[3] ? Number(process.argv[3]) : undefined;
const webDist = process.argv[4];
const FILE = "月度销售报表.csv";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1800, noCache: 1800, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 120, text: 100, reasoning: 20 },
};

const stream = (parts: LanguageModelV4StreamPart[], toolCalls = false) => ({
  stream: new ReadableStream<LanguageModelV4StreamPart>({
    start(c) {
      c.enqueue({ type: "stream-start", warnings: [] });
      for (const p of parts) c.enqueue(p);
      c.enqueue({
        type: "finish",
        usage: USAGE,
        finishReason: toolCalls
          ? { unified: "tool-calls", raw: "tool_calls" }
          : { unified: "stop", raw: "stop" },
      });
      c.close();
    },
  }),
});

const reasoning = (text: string): LanguageModelV4StreamPart[] => [
  { type: "reasoning-start", id: "r" },
  { type: "reasoning-delta", id: "r", delta: text },
  { type: "reasoning-end", id: "r" },
];

const call = (id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] => {
  const json = JSON.stringify(input);
  return [
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: json },
    { type: "tool-call", toolCallId: id, toolName, input: json },
  ];
};

const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: t },
  { type: "text-end", id: "t" },
];

let n = 0;
const srv = await startServer({
  dataDir,
  ...(port !== undefined ? { port } : {}),
  ...(webDist !== undefined ? { webDist } : {}),
  dev: true,
  resolveLanguageModel: () =>
    new MockLanguageModelV4({
      provider: "mock",
      modelId: "ui-preview",
      doStream: async (opts) => {
        n += 1;
        const prompt = opts.prompt as { role: string; content: unknown }[];
        const lastUser = prompt.map((m) => m.role).lastIndexOf("user");
        const userText = JSON.stringify(prompt[lastUser]?.content ?? "");
        if (userText.includes("失败")) {
          throw new APICallError({
            message: "Incorrect API key provided",
            url: "https://api.example.invalid/v1/responses",
            requestBodyValues: {},
            statusCode: 401,
          });
        }
        const step = prompt.slice(lastUser).filter((m) => m.role === "tool").length;
        // 消息含「慢」：首步前停 8 秒，用于检查运行中的派发策略与停止
        if (userText.includes("慢") && step === 0) {
          await new Promise((r) => setTimeout(r, 8000));
        }
        // 子代理（系统提示词含角色说明）：读一次表后汇报
        const sys = prompt.find((m) => m.role === "system")?.content;
        if (typeof sys === "string" && sys.includes("角色的子代理")) {
          return step === 0
            ? stream(call(`sub-read-${n}`, "workbook_read", { path: FILE, mode: "overview" }), true)
            : stream(text("已核对，华东、华北两区 1–3 月数据完整。"));
        }
        // 用户消息带图片：如实回报模型收到了几张图（检查附件送达）
        const lastUserParts = (prompt[lastUser]?.content ?? []) as { type?: string }[];
        const imageCount = Array.isArray(lastUserParts)
          ? lastUserParts.filter((p) => p.type === "file").length
          : 0;
        if (imageCount > 0 && step === 0) {
          return stream(
            [
              ...reasoning("用户附了图片，先确认收到的内容。"),
              ...text(`收到 ${imageCount} 张图片。`),
            ],
            false,
          );
        }
        // 消息含「只读」：读一个区域后直接总结（检查跟随代理，不经区域确认）
        if (userText.includes("只读")) {
          return step === 0
            ? stream(call(`ro-${n}`, "workbook_read", { path: FILE, mode: "range", range: "B2:D6" }), true)
            : stream(text("B2:D6 是 1–2 月各区域的销售额。"));
        }
        // 消息含「改值」：直接改已有单元格 D2:D3（检查拟修改角标与修改前后对比）
        if (userText.includes("改值")) {
          return step === 0
            ? stream(
                call(`fix-${n}`, "workbook_edit", {
                  path: FILE,
                  // 每次写不同的值，便于检查"原值 → 新值"
                  ops: [{ op: "cells.set", range: "D2:D3", values: [[60 + n], [57 + n]] }],
                }),
                true,
              )
            : stream(text("已更新 D2:D3。"));
        }
        // 消息含「团队」：主代理派生两个子代理，收到结果后收口
        if (userText.includes("团队")) {
          return step === 0
            ? stream(
                [
                  ...call(`spawn-a-${n}`, "agent_spawn", {
                    name: "核对员",
                    role: "worker",
                    task: "核对华东区数据",
                  }),
                  ...call(`spawn-b-${n}`, "agent_spawn", {
                    name: "汇总员",
                    role: "reader",
                    task: "汇总各区销售额",
                  }),
                ],
                true,
              )
            : stream(text("两个子代理已开始工作，可以在左侧「代理团队」里查看进度。"));
        }
        if (step === 0) {
          return stream(
            [
              ...reasoning("先看看工作簿的结构，确认数据区与表头位置。"),
              ...text("我先读取一下这张表的结构。"),
              ...call(`read-${n}`, "workbook_read", { path: FILE, mode: "overview" }),
            ],
            true,
          );
        }
        if (step === 1) {
          return stream(
            call(`ask-${n}`, "ask_user", {
              type: "range_confirm",
              spec: {
                prompt: "我识别到数据区是 A1:D25，表头在第 1 行，对吗？",
                path: FILE,
                suggestedRange: "A1:D25",
              },
            }),
            true,
          );
        }
        if (step === 2) {
          return stream(
            [
              ...reasoning("在 E 列追加同比标记列，先写表头和前几行。"),
              ...call(`edit-${n}`, "workbook_edit", {
                path: FILE,
                ops: [
                  {
                    op: "cells.set",
                    range: "E1:E4",
                    values: [["备注"], ["华东领先"], ["—"], ["华南偏低"]],
                  },
                ],
              }),
            ],
            true,
          );
        }
        return stream(
          text(
            "已在 **E 列** 追加备注，修改区域为 E1:E4。\n\n| 区域 | 1 月销售额（万元） | 备注 |\n| --- | ---: | --- |\n| 华东 | 59.4 | 华东领先 |\n| 华北 | 56.2 | — |\n| 华南 | 40.6 | 华南偏低 |\n\n可以在表格中点击 B2:D4 核对原始数据。",
          ),
        );
      },
    }),
  log: () => {},
});
process.stdout.write(`${JSON.stringify({ url: srv.url })}\n`);
