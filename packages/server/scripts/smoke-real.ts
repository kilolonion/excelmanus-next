// 真实 MiMo 冒烟（手动验收用，不进测试）：
//   node packages/server/scripts/smoke-real.ts
// 读 ~/.config/excelmanus-next/spike.env（MIMO_API_KEY/MIMO_BASE_URL/MIMO_MODEL），
// 临时数据目录起真实 server（默认网关），走完整 HTTP/WS/SQLite 路径跑一轮
// "列出工作区文件"，打印会话日志记录类型序列。绝不打印密钥。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApiClient, type RecMsg, type ServerMessage } from "@excelmanus/protocol";
import { WebSocket } from "ws";
import { startServer } from "../src/index.ts";

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv(join(homedir(), ".config/excelmanus-next/spike.env"));
for (const k of ["MIMO_API_KEY", "MIMO_BASE_URL", "MIMO_MODEL"]) {
  if (!env[k]) {
    console.error(`spike.env 缺少 ${k}`);
    process.exit(1);
  }
}

// 可选参数：--prompt <文本> 自定义提问；--file <绝对路径> 复制进工作区（可多次）。
function argValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1] !== undefined) {
      out.push(process.argv[i + 1] as string);
    }
  }
  return out;
}
const prompt =
  argValues("--prompt")[0] ?? "请用 find 工具列出工作区里的文件，然后用一句话告诉我有哪些文件。";
const extraFiles = argValues("--file");

const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-smoke-real-"));
const srv = await startServer({ dataDir, log: () => {} });
writeFileSync(join(srv.workspaceRoot, "note.txt"), "hello mimo\n", "utf8");
for (const f of extraFiles) {
  writeFileSync(join(srv.workspaceRoot, basename(f)), readFileSync(f));
}

const deadline = Date.now() + 180_000;
try {
  const api = createApiClient(srv.url, srv.token);
  const { profile } = await api.createModelProfile({
    name: "mimo",
    provider: "mimo",
    model: env.MIMO_MODEL as string,
    baseUrl: env.MIMO_BASE_URL as string,
    apiKey: env.MIMO_API_KEY as string,
  });
  console.log(`profile: ${profile.provider} ${profile.model} key=${profile.apiKeyMasked}`);
  const { session } = await api.createSession({});
  const sid = session.id;

  const { ticket } = await api.createTicket();
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/v1/sync?ticket=${ticket}`);
  const recs: RecMsg[] = [];
  const deltas: string[] = [];
  let resolveDone: (v: "done" | "timeout") => void = () => {};
  const done = new Promise<"done" | "timeout">((r) => {
    resolveDone = r;
  });
  const subOk = new Promise<void>((resolve) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.type === "sub.ok") resolve();
      if (m.type === "rec") {
        recs.push(m);
        if (
          m.record.type === "turn.completed" ||
          m.record.type === "turn.failed" ||
          m.record.type === "turn.interrupted"
        ) {
          resolveDone("done");
        }
      } else if (m.type === "delta") {
        deltas.push(m.kind);
      }
    });
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "sub", topic: `session:${sid}`, cursor: 0 })));
  setTimeout(() => resolveDone("timeout"), 170_000);
  await subOk;

  await api.sendMessage(sid, "main", {
    clientMessageId: "smoke-1",
    text: prompt,
  });
  const outcome = await done;
  const seq = recs.map((r) => `${r.seq}:${r.record.type}`).join(" → ");
  console.log(`outcome: ${outcome}; recs=${recs.length}; deltas=${deltas.length}`);
  console.log(`record 序列：${seq}`);
  for (const r of recs) {
    if (r.record.type === "tool.intent" || r.record.type === "tool.result") {
      const d = r.record.data as { toolName?: string; status?: string };
      console.log(`  ${r.record.type} tool=${d.toolName ?? "?"} status=${d.status ?? "-"}`);
    }
  }
  const lastOutput = [...recs].reverse().find((r) => r.record.type === "model.output");
  if (lastOutput) {
    const t = (lastOutput.record.data as { text?: string }).text ?? "";
    console.log(`最终回答：${t.slice(0, 200)}`);
  }
  if (Date.now() > deadline) console.log("（已超时）");
} finally {
  await srv.close();
  rmSync(dataDir, { recursive: true, force: true });
}
