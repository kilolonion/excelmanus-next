import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { type WebSocket, WebSocketServer } from "ws";
import {
  AppendBody,
  ClientMessage,
  DeltaBody,
  type DeltaMsg,
  type LogRecord,
  protocolVersion,
  type RecMsg,
  ServerMessage,
  type SnapshotMsg,
} from "./protocol.ts";

export interface ServerOptions {
  dbPath: string;
  port?: number;
  ticketTtlMs: number;
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  /** 启用 /api/v1/_spike/* 测试入口、__failInTxn 注入、事件循环停顿统计与输出校验 */
  testHooks?: boolean;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  address: string;
  deviceToken: string;
  close(): Promise<void>;
}

interface Sub {
  topic: string;
  sessionId: string;
  live: boolean;
  lastSent: number;
  buffer: RecMsg[];
}

interface Conn {
  id: string;
  ws: WebSocket;
  subs: Map<string, Sub>;
  idleTimer: NodeJS.Timeout;
}

interface StreamState {
  topic: string;
  agentId: string;
  stepId: string;
  text: string;
  reasoning: string;
  toolArgs: string;
}

const PAGE_SIZE = 500;
const MAX_BUFFERED = 4 * 1024 * 1024;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface LogRow {
  seq: number;
  type: string;
  agent_id: string | null;
  data: string;
  created_at: string;
}

function rowToRec(topic: string, row: LogRow): RecMsg {
  return {
    type: "rec",
    topic,
    seq: row.seq,
    record: {
      type: row.type,
      agentId: row.agent_id,
      data: JSON.parse(row.data) as Record<string, unknown>,
      createdAt: row.created_at,
    },
  };
}

export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_log (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      agent_id TEXT,
      type TEXT NOT NULL,
      data TEXT NOT NULL CHECK (json_valid(data)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;
  `);
  return db;
}

export async function createServer(opts: ServerOptions): Promise<RunningServer> {
  const log =
    opts.log ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const emit = (event: string, fields: Record<string, string | number | boolean> = {}) =>
    log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

  const db = openDb(opts.dbPath);
  const deviceToken = randomBytes(32).toString("base64url");
  const deviceId = randomUUID();
  db.prepare("INSERT INTO devices (id, token_hash, created_at) VALUES (?, ?, ?)").run(
    deviceId,
    sha256(deviceToken),
    new Date().toISOString(),
  );
  emit("device.created", { deviceId });

  const stmts = {
    device: db.prepare("SELECT id FROM devices WHERE token_hash = ?"),
    lastSeq: db.prepare("SELECT last_seq FROM sessions WHERE id = ?"),
    insertLog: db.prepare(
      "INSERT INTO session_log (session_id, seq, agent_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    upsertSession: db.prepare(
      "INSERT INTO sessions (id, last_seq) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_seq = excluded.last_seq",
    ),
    page: db.prepare(
      "SELECT seq, type, agent_id, data, created_at FROM session_log WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    ),
    range: db.prepare(
      "SELECT seq, type, agent_id, data, created_at FROM session_log WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq",
    ),
  };

  const tickets = new Map<string, number>();
  const conns = new Map<string, Conn>();
  const streams = new Map<string, StreamState>();
  const streamKey = (topic: string, agentId: string, stepId: string) =>
    `${topic}\u0000${agentId}\u0000${stepId}`;

  let maxStallMs = 0;
  let stallTimer: NodeJS.Timeout | undefined;
  if (opts.testHooks) {
    const interval = 5;
    let prev = performance.now();
    stallTimer = setInterval(() => {
      const now = performance.now();
      maxStallMs = Math.max(maxStallMs, now - prev - interval);
      prev = now;
    }, interval);
  }

  const headSeq = (sessionId: string): number =>
    (stmts.lastSeq.get(sessionId) as { last_seq: number } | undefined)?.last_seq ?? 0;

  const send = (conn: Conn, msg: ServerMessage | Record<string, unknown>, raw = false) => {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (opts.testHooks && !raw) ServerMessage.parse(msg);
    conn.ws.send(JSON.stringify(msg));
  };

  const publishRec = (msg: RecMsg) => {
    for (const conn of conns.values()) {
      const sub = conn.subs.get(msg.topic);
      if (!sub) continue;
      if (!sub.live) sub.buffer.push(msg);
      else if (msg.seq > sub.lastSent) {
        sub.lastSent = msg.seq;
        send(conn, msg);
      }
    }
  };

  const publishDelta = (msg: DeltaMsg) => {
    for (const conn of conns.values()) {
      const sub = conn.subs.get(msg.topic);
      // 补发期间丢弃 delta：补发结束时的 snapshot 已包含它们
      if (sub?.live) send(conn, msg);
    }
  };

  const snapshotsFor = (topic: string): SnapshotMsg[] =>
    [...streams.values()].filter((s) => s.topic === topic).map((s) => ({ type: "snapshot", ...s }));

  const waitDrain = async (conn: Conn) => {
    while (conn.ws.readyState === conn.ws.OPEN && conn.ws.bufferedAmount > MAX_BUFFERED) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const subscribe = async (conn: Conn, topic: string, cursor: number | undefined) => {
    const sessionId = topic.slice("session:".length);
    const head = headSeq(sessionId);
    const sub: Sub = { topic, sessionId, live: false, lastSent: cursor ?? head, buffer: [] };
    conn.subs.set(topic, sub);
    send(conn, { type: "sub.ok", topic, headCursor: head, cursor: sub.lastSent });
    let sent = 0;
    if (cursor !== undefined) {
      for (;;) {
        const rows = stmts.page.all(sessionId, sub.lastSent, PAGE_SIZE) as unknown as LogRow[];
        for (const row of rows) send(conn, rowToRec(topic, row));
        sent += rows.length;
        if (rows.length > 0) sub.lastSent = (rows[rows.length - 1] as LogRow).seq;
        if (rows.length < PAGE_SIZE) break;
        await yieldLoop();
        await waitDrain(conn);
        if (conn.subs.get(topic) !== sub || !conns.has(conn.id)) return;
      }
    }
    for (const msg of sub.buffer) {
      if (msg.seq > sub.lastSent) {
        sub.lastSent = msg.seq;
        send(conn, msg);
      }
    }
    sub.buffer = [];
    for (const snap of snapshotsFor(topic)) send(conn, snap);
    sub.live = true;
    emit("sub.live", { connectionId: conn.id, topic, caughtUp: sent });
  };

  const onMessage = (conn: Conn, data: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      send(conn, { type: "error", error: { code: "bad_message", message: "消息不是 JSON" } });
      return;
    }
    const r = ClientMessage.safeParse(parsed);
    if (!r.success) {
      send(conn, { type: "error", error: { code: "bad_message", message: "消息不符合协议" } });
      emit("ws.bad_message", { connectionId: conn.id });
      return;
    }
    const msg = r.data;
    switch (msg.type) {
      case "ping":
        send(conn, { type: "pong" });
        break;
      case "pong":
        break;
      case "unsub":
        conn.subs.delete(msg.topic);
        break;
      case "sub":
        subscribe(conn, msg.topic, msg.cursor).catch((err: unknown) => {
          emit("sub.failed", { connectionId: conn.id, name: (err as Error).name });
          send(conn, {
            type: "sub.error",
            topic: msg.topic,
            error: { code: "internal", message: "订阅失败" },
          });
        });
        break;
    }
  };

  // ---------------- HTTP ----------------

  const app = new Hono();
  let port = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 500, code: string, message: string) =>
    c.json({ error: { code, message, requestId: c.get("requestId" as never) as string } }, status);

  app.use("*", async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId" as never, requestId as never);
    c.header("X-Request-Id", requestId);
    if (!allowedHosts().has(c.req.header("host") ?? "")) {
      emit("http.rejected", { requestId, reason: "host" });
      return fail(c, 403, "forbidden_host", "Host 不被允许");
    }
    if (c.req.path !== "/api/v1/health") {
      const auth = c.req.header("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !stmts.device.get(sha256(token))) {
        emit("http.rejected", { requestId, reason: "auth" });
        return fail(c, 401, "unauthorized", "设备令牌无效");
      }
    }
    await next();
    emit("http", { requestId, method: c.req.method, route: c.req.routePath, status: c.res.status });
  });

  app.get("/api/v1/health", (c) => c.json({ ok: true, protocolVersion }));

  app.post("/api/v1/sync/ticket", (c) => {
    const ticket = randomBytes(32).toString("base64url");
    const expires = Date.now() + opts.ticketTtlMs;
    tickets.set(sha256(ticket), expires);
    return c.json({ ticket, expiresAt: new Date(expires).toISOString() });
  });

  app.post("/api/v1/_spike/sessions/:id/append", async (c) => {
    const sessionId = c.req.param("id");
    const body = AppendBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))
      return fail(c, 400, "bad_request", "请求体不合法");
    const record: LogRecord = {
      type: body.data.type,
      agentId: body.data.agentId ?? null,
      data: body.data.data,
      createdAt: new Date().toISOString(),
    };
    let seq: number;
    db.exec("BEGIN IMMEDIATE");
    try {
      seq = headSeq(sessionId) + 1;
      stmts.insertLog.run(
        sessionId,
        seq,
        record.agentId,
        record.type,
        JSON.stringify(record.data),
        record.createdAt,
      );
      stmts.upsertSession.run(sessionId, seq);
      if (opts.testHooks && record.data.__failInTxn === true) throw new Error("injected failure");
      db.exec("COMMIT");
    } catch {
      db.exec("ROLLBACK");
      emit("append.rolled_back", { sessionId });
      return fail(c, 500, "internal", "写入失败");
    }
    const topic = `session:${sessionId}`;
    publishRec({ type: "rec", topic, seq, record });
    const stepId = record.data.stepId;
    if (record.type === "model.output" && typeof stepId === "string" && record.agentId) {
      streams.delete(streamKey(topic, record.agentId, stepId));
    }
    return c.json({ seq });
  });

  app.post("/api/v1/_spike/sessions/:id/delta", async (c) => {
    const topic = `session:${c.req.param("id")}`;
    const body = DeltaBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 400, "bad_request", "请求体不合法");
    const d = body.data;
    const key = streamKey(topic, d.agentId, d.stepId);
    const s = streams.get(key) ?? {
      topic,
      agentId: d.agentId,
      stepId: d.stepId,
      text: "",
      reasoning: "",
      toolArgs: "",
    };
    const piece = typeof d.payload === "string" ? d.payload : "";
    if (d.kind === "text") s.text += piece;
    else if (d.kind === "reasoning") s.reasoning += piece;
    else if (d.kind === "tool_args") s.toolArgs += piece;
    streams.set(key, s);
    publishDelta({ type: "delta", topic, ...d });
    return c.json({ ok: true });
  });

  if (opts.testHooks) {
    app.post("/api/v1/_spike/sessions/:id/step-finished", async (c) => {
      const body = (await c.req.json()) as { agentId: string; stepId: string };
      streams.delete(streamKey(`session:${c.req.param("id")}`, body.agentId, body.stepId));
      return c.json({ ok: true });
    });
    // C07：无视 lastSent，把库中 [fromSeq, toSeq] 再发一遍
    app.post("/api/v1/_spike/connections/:cid/replay", async (c) => {
      const conn = conns.get(c.req.param("cid"));
      if (!conn) return fail(c, 404, "not_found", "连接不存在");
      const b = (await c.req.json()) as { topic: string; fromSeq: number; toSeq: number };
      const rows = stmts.range.all(b.topic.slice(8), b.fromSeq, b.toSeq) as unknown as LogRow[];
      for (const row of rows) send(conn, rowToRec(b.topic, row));
      return c.json({ sent: rows.length });
    });
    // C08：原样发送任意消息（不做输出校验）
    app.post("/api/v1/_spike/connections/:cid/raw", async (c) => {
      const conn = conns.get(c.req.param("cid"));
      if (!conn) return fail(c, 404, "not_found", "连接不存在");
      send(conn, (await c.req.json()) as Record<string, unknown>, true);
      return c.json({ ok: true });
    });
    app.get("/api/v1/_spike/stats", (c) =>
      c.json({ maxStallMs, connections: conns.size, pid: process.pid }),
    );
    app.post("/api/v1/_spike/stats/reset", (c) => {
      maxStallMs = 0;
      return c.json({ ok: true });
    });
  }

  // ---------------- WebSocket ----------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const rejectUpgrade = (socket: Duplex, status: number, reason: string, code: string) => {
    const body = JSON.stringify({ error: { code, message: reason, requestId: randomUUID() } });
    socket.once("finish", () => socket.destroy());
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (!allowedHosts().has(req.headers.host ?? "")) {
      emit("upgrade.rejected", { reason: "host" });
      return rejectUpgrade(socket, 403, "Forbidden", "forbidden_host");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin)) {
      emit("upgrade.rejected", { reason: "origin" });
      return rejectUpgrade(socket, 403, "Forbidden", "forbidden_origin");
    }
    if (url.pathname !== "/api/v1/sync") {
      emit("upgrade.rejected", { reason: "path" });
      return rejectUpgrade(socket, 404, "Not Found", "not_found");
    }
    const ticket = url.searchParams.get("ticket") ?? "";
    const key = sha256(ticket);
    const expires = tickets.get(key);
    tickets.delete(key);
    if (!ticket || expires === undefined || expires < Date.now()) {
      emit("upgrade.rejected", {
        reason: expires === undefined ? "ticket_unknown" : "ticket_expired",
      });
      return rejectUpgrade(socket, 401, "Unauthorized", "invalid_ticket");
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Conn = {
        id: randomUUID(),
        ws,
        subs: new Map(),
        idleTimer: setTimeout(() => {}, 0),
      };
      const armIdle = () => {
        clearTimeout(conn.idleTimer);
        conn.idleTimer = setTimeout(() => {
          emit("ws.timeout", { connectionId: conn.id });
          ws.terminate();
        }, opts.heartbeatTimeoutMs);
      };
      armIdle();
      const pinger = setInterval(() => send(conn, { type: "ping" }), opts.heartbeatMs);
      conns.set(conn.id, conn);
      emit("ws.open", { connectionId: conn.id });
      ws.on("message", (data, isBinary) => {
        armIdle();
        if (isBinary) {
          send(conn, { type: "error", error: { code: "bad_message", message: "不支持二进制帧" } });
          return;
        }
        onMessage(conn, data.toString());
      });
      ws.on("error", () => ws.terminate());
      ws.on("close", (code) => {
        clearTimeout(conn.idleTimer);
        clearInterval(pinger);
        conns.delete(conn.id);
        emit("ws.close", { connectionId: conn.id, code });
      });
      send(conn, {
        type: "hello",
        protocolVersion,
        connectionId: conn.id,
        serverTime: new Date().toISOString(),
      });
    });
  };

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: "127.0.0.1" }, () =>
      resolve(s as Server),
    ) as Server;
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  server.on("upgrade", onUpgrade);
  const ticketSweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of tickets) if (exp < now) tickets.delete(k);
  }, 10_000);
  emit("server.listening", { address: addr.address, port });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    address: addr.address,
    deviceToken,
    close: async () => {
      clearInterval(ticketSweeper);
      if (stallTimer) clearInterval(stallTimer);
      for (const c of conns.values()) c.ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}
