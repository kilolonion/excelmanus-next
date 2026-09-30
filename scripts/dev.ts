// 本地开发编排：后端 8787（--dev 放行 Vite Origin）+ Vite dev 5173（代理 /api 与 WS）。

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.EXCELMANUS_PORT ?? "8787";

const children: ChildProcess[] = [];
const killAll = () => {
  for (const c of children) c.kill("SIGTERM");
};
process.on("SIGINT", () => {
  killAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killAll();
  process.exit(0);
});

const backend = spawn(
  process.execPath,
  [join(root, "packages/server/src/main.ts"), "--port", port, "--dev"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, EXCELMANUS_PORT: port },
  },
);
children.push(backend);

// 等后端打印监听 URL 再拉起 vite（简单延时即可）
setTimeout(() => {
  const vite = spawn("pnpm", ["--filter", "@excelmanus/web", "exec", "vite"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, EXCELMANUS_PORT: port },
  });
  children.push(vite);
  vite.on("exit", (code) => {
    killAll();
    process.exit(code ?? 0);
  });
}, 1500);

backend.on("exit", (code) => {
  killAll();
  process.exit(code ?? 0);
});
