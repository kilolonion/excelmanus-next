// CLI 入口：node packages/server/src/main.ts [--data-dir <path>] [--port <n>]
// 数据目录优先级：--data-dir > EXCELMANUS_HOME > ~/.excelmanus-next

import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index.ts";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir =
  argValue("--data-dir") ?? process.env.EXCELMANUS_HOME ?? join(homedir(), ".excelmanus-next");
const portArg = argValue("--port");
const port = portArg !== undefined ? Number(portArg) : undefined;
const dev = process.argv.includes("--dev") || process.env.EXCELMANUS_DEV === "1";

const splitEnv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const extraHosts = splitEnv("EXCELMANUS_EXTRA_HOSTS");
const extraOrigins = splitEnv("EXCELMANUS_EXTRA_ORIGINS");

const srv = await startServer({
  dataDir,
  ...(port !== undefined ? { port } : {}),
  ...(extraHosts.length > 0 ? { extraHosts } : {}),
  ...(extraOrigins.length > 0 ? { extraOrigins } : {}),
  ...(dev ? { dev: true } : {}),
});

const shutdown = () => {
  void srv.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
