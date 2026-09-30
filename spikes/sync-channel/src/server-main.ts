// 独立服务进程入口。配置经环境变量传入；设备令牌只经 IPC 交给父进程，不写 stdout。
import { createServer } from "./server.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`缺少环境变量 ${k}`);
  return v;
};

const server = await createServer({
  dbPath: env("SYNC_DB"),
  port: Number(env("SYNC_PORT", "0")),
  ticketTtlMs: Number(env("SYNC_TICKET_TTL_MS", "30000")),
  heartbeatMs: Number(env("SYNC_HEARTBEAT_MS", "20000")),
  heartbeatTimeoutMs: Number(env("SYNC_HEARTBEAT_TIMEOUT_MS", "40000")),
  testHooks: env("SYNC_TEST_HOOKS", "0") === "1",
});

process.send?.({
  kind: "ready",
  url: server.url,
  port: server.port,
  address: server.address,
  deviceToken: server.deviceToken,
  pid: process.pid,
});

const shutdown = () => {
  server.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("disconnect", shutdown);
