// CLI 入口：node packages/server/src/main.ts [--data-dir <path>] [--port <n>]
// 数据目录优先级：--data-dir > EXCELMANUS_HOME > ~/.excelmanus-next

import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index.ts";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const splitEnv = (name: string): string[] | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
};

const dataDir =
  argValue("--data-dir") ?? process.env.EXCELMANUS_HOME ?? join(homedir(), ".excelmanus-next");
const portArg = argValue("--port");
const port = portArg !== undefined ? Number(portArg) : undefined;
const dev = process.argv.includes("--dev") || process.env.EXCELMANUS_DEV === "1";

const srv = await startServer({
  dataDir,
  autoTitle: true,
  ...(splitEnv("EXCELMANUS_EXTRA_HOSTS") ? { extraHosts: splitEnv("EXCELMANUS_EXTRA_HOSTS") } : {}),
  ...(splitEnv("EXCELMANUS_EXTRA_ORIGINS")
    ? { extraOrigins: splitEnv("EXCELMANUS_EXTRA_ORIGINS") }
    : {}),
  ...(port !== undefined ? { port } : {}),
  ...(dev ? { dev: true } : {}),
});

const shutdown = () => {
  void srv.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
