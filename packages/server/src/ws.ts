// 同步通道（11 §3）：一次性 30s 票据、hello、sub/unsub、游标续传、
// rec/delta/snapshot 推送、心跳。doc:* 主题：doc_ops 续传 + doc.submit/ack/reject + 广播。

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { setImmediate as yieldLoop } from "node:timers/promises";
import type { SessionLog, SyncBus } from "@excelmanus/kernel";
import type {
  LogRecord,
  PresenceParticipant,
  ServerMessage,
  SnapshotMsg,
} from "@excelmanus/protocol";
import { ClientMessage, protocolVersion, ToolArgsDelta } from "@excelmanus/protocol";
import type { DocMutation, DocumentService } from "@excelmanus/workbook";
import { deriveWriteSet } from "@excelmanus/workbook";
import { type WebSocket, WebSocketServer } from "ws";
import type { RenderBroker } from "./render.ts";
import { sha256 } from "./store.ts";

const PAGE_SIZE = 500;
const MAX_BUFFERED = 4 * 1024 * 1024;
/** 大修订按约 500 格分片推送（07 §3.3）。 */
const DOC_OP_CHUNK_CELLS = 500;

interface Sub {
  topic: string;
  sessionId: string;
  live: boolean;
  lastSent: number;
  buffer: { seq: number; rec: LogRecord }[];
}

interface DocSub {
  topic: string;
  docId: string;
  live: boolean;
  lastRev: number;
  buffer: { rev: number; source: string; mutations: DocMutation[] }[];
}

interface Conn {
  id: string;
  ws: WebSocket;
  subs: Map<string, Sub>;
  docSubs: Map<string, DocSub>;
  /** 当前连接在每个文档上的瞬时 presence；断线即清除，不落库。 */
  presence: Map<string, PresenceParticipant>;
  isAppSub: boolean;
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

export interface SyncChannelOptions {
  log: SessionLog;
  bus: SyncBus;
  /** sha256(ticket) → expiresAtMs；一次性，取出即删。 */
  tickets: Map<string, number>;
  /** 活文档服务；未装配 workbook 时 doc: 主题回 sub.error。 */
  docService?: DocumentService;
  /** docId → 所属工作区根（冷启动物化需要读文件）。 */
  workspaceRootFor?(docId: string): string | undefined;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  emit?: (event: string, fields: Record<string, string | number | boolean>) => void;
  /** 允许的 Host/Origin（随端口确定后调用）。 */
  allowedHosts(): Set<string>;
  allowedOrigins(): Set<string>;
  /** 截图渲染中转（ADR 0010）：订阅 app 主题的界面连接可作为渲染端。 */
  render?: RenderBroker;
}

/** 改变会话活动摘要（SessionSummary.activity）的记录类型。 */
const ACTIVITY_RECORDS = new Set([
  "agent.status",
  "approval.requested",
  "approval.decided",
  "question.asked",
  "question.answered",
]);

export function attachSyncChannel(server: Server, opts: SyncChannelOptions): () => void {
  const emit = opts.emit ?? (() => {});
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 40_000;
  const conns = new Map<string, Conn>();
  const streams = new Map<string, StreamState>();
  const streamKey = (topic: string, agentId: string, stepId: string) =>
    `${topic}${agentId}${stepId}`;

  const send = (conn: Conn, msg: ServerMessage) => {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(msg));
  };

  const presenceColor = (connectionId: string): string => {
    const palette = ["#4f46e5", "#059669", "#d97706", "#db2777", "#0891b2", "#7c3aed"];
    let n = 0;
    for (const ch of connectionId) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return palette[n % palette.length] as string;
  };

  const publishPresence = (docId: string) => {
    const topic = `doc:${docId}`;
    const participants = [...conns.values()]
      .filter((conn) => conn.docSubs.has(topic))
      .map((conn) => conn.presence.get(docId))
      .filter((p): p is PresenceParticipant => p !== undefined);
    for (const conn of conns.values()) {
      if (conn.docSubs.has(topic)) send(conn, { type: "presence", docId, participants });
    }
  };

  const publishRec = (topic: string, rec: LogRecord) => {
    for (const conn of conns.values()) {
      const sub = conn.subs.get(topic);
      if (!sub) continue;
      if (!sub.live) sub.buffer.push({ seq: rec.seq, rec });
      else if (rec.seq > sub.lastSent) {
        sub.lastSent = rec.seq;
        send(conn, { type: "rec", topic, seq: rec.seq, record: rec });
      }
    }
    // 流式状态收尾：模型输出落库/尝试作废后，该 stepId 不再有 delta
    const stepId = rec.data.stepId;
    if (
      (rec.type === "model.output" || rec.type === "attempt.discarded") &&
      typeof stepId === "string" &&
      rec.agentId
    ) {
      streams.delete(streamKey(topic, rec.agentId, stepId));
    }
    // 轮次结束：该代理不再有进行中的流（11 §3.4 snapshot 只代表当前流；P1-41 最小插入）
    if (
      (rec.type === "turn.completed" ||
        rec.type === "turn.failed" ||
        rec.type === "turn.interrupted") &&
      rec.agentId
    ) {
      for (const [k, s] of streams) {
        if (s.topic === topic && s.agentId === rec.agentId) streams.delete(k);
      }
    }
  };

  const publishDelta = (ev: {
    sessionId: string;
    agentId: string;
    stepId: string;
    part: number;
    deltaKind: string;
    payload: unknown;
  }) => {
    const topic = `session:${ev.sessionId}`;
    const key = streamKey(topic, ev.agentId, ev.stepId);
    const s = streams.get(key) ?? {
      topic,
      agentId: ev.agentId,
      stepId: ev.stepId,
      text: "",
      reasoning: "",
      toolArgs: "",
    };
    if (ev.deltaKind === "tool_args") {
      // snapshot.toolArgs 只是本步全部参数分片的拼接；分片本身带工具 id 与名称（v3）
      const p = ToolArgsDelta.safeParse(ev.payload);
      if (p.success) s.toolArgs += p.data.delta;
    } else {
      const piece = typeof ev.payload === "string" ? ev.payload : "";
      if (ev.deltaKind === "text") s.text += piece;
      else if (ev.deltaKind === "reasoning") s.reasoning += piece;
    }
    streams.set(key, s);
    for (const conn of conns.values()) {
      const sub = conn.subs.get(topic);
      // 补发期间丢弃 delta：补发结束时的 snapshot 已包含它们
      if (sub?.live) {
        send(conn, {
          type: "delta",
          topic,
          agentId: ev.agentId,
          stepId: ev.stepId,
          part: ev.part,
          kind: ev.deltaKind as "text",
          payload: ev.payload,
        });
      }
    }
  };

  const publishApp = (data: { type: string } & Record<string, unknown>) => {
    for (const conn of conns.values()) {
      if (conn.isAppSub) send(conn, { type: "app.event", data });
      // 11 §3.5：会话删除后结束该会话主题的订阅（分支 agent-control，P1-08）
      const topic = data.type === "session.deleted" ? `session:${String(data.sessionId)}` : null;
      if (topic !== null && conn.subs.delete(topic)) {
        send(conn, {
          type: "sub.error",
          topic,
          error: { code: "not_found", message: "会话已删除" },
        });
      }
    }
  };

  const unsubscribe = opts.bus.subscribe((ev) => {
    if (ev.kind === "rec") {
      publishRec(`session:${ev.rec.sessionId}`, ev.rec);
      // 会话列表的活动摘要（运行中 / 待审批 / 待回答）随之变化：通知未订阅该会话的窗口刷新
      if (ACTIVITY_RECORDS.has(ev.rec.type))
        publishApp({ type: "session.activity", sessionId: ev.rec.sessionId });
    } else if (ev.kind === "delta") publishDelta(ev);
    else publishApp(ev.data);
  });

  /** 按约 500 格把一次修订的 mutation 分片发送。 */
  const sendDocOp = (
    conn: Conn,
    docId: string,
    rev: number,
    source: string,
    mutations: DocMutation[],
  ) => {
    if (source.startsWith("external:")) {
      send(conn, { type: "doc.reload", docId, rev, reason: "external" });
      return;
    }
    const costOf = (m: DocMutation) => {
      const ranges = deriveWriteSet(m).ranges;
      let cells = 1;
      for (const r of ranges) cells += (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
      return Math.min(cells, DOC_OP_CHUNK_CELLS);
    };
    const chunks: DocMutation[][] = [];
    let cur: DocMutation[] = [];
    let curCost = 0;
    for (const m of mutations) {
      cur.push(m);
      curCost += costOf(m);
      if (curCost >= DOC_OP_CHUNK_CELLS) {
        chunks.push(cur);
        cur = [];
        curCost = 0;
      }
    }
    if (cur.length > 0 || chunks.length === 0) chunks.push(cur);
    const total = chunks.length;
    chunks.forEach((muts, index) => {
      send(conn, {
        type: "doc.op",
        docId,
        rev,
        source,
        mutations: muts as unknown[],
        ...(total > 1 ? { chunk: { index, total } } : {}),
      });
    });
  };

  const publishDocOp = (docId: string, rev: number, source: string, mutations: DocMutation[]) => {
    const topic = `doc:${docId}`;
    for (const conn of conns.values()) {
      const sub = conn.docSubs.get(topic);
      if (!sub) continue;
      if (!sub.live) sub.buffer.push({ rev, source, mutations });
      else if (rev > sub.lastRev) {
        sub.lastRev = rev;
        sendDocOp(conn, docId, rev, source, mutations);
      }
    }
  };
  const docSvc = opts.docService;
  if (docSvc !== undefined) {
    docSvc.onCheckpoint = (docId, checkpointRev, error) => {
      for (const conn of conns.values())
        if (conn.docSubs.has(`doc:${docId}`))
          send(conn, {
            type: "doc.checkpoint",
            docId,
            checkpointRev,
            ...(error ? { error } : {}),
            ...(docSvc.meta(docId)?.externalConflict ? { externalConflict: true } : {}),
          });
    };
    docSvc.onRevision = (docId, rev, source, mutations) =>
      publishDocOp(docId, rev, source, mutations);
  }
  const unsubscribeDoc = () => {
    if (docSvc !== undefined) {
      docSvc.onRevision = undefined;
      docSvc.onCheckpoint = undefined;
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
    if (topic.startsWith("doc:")) {
      const svc = opts.docService;
      const docId = topic.slice("doc:".length);
      if (!svc?.hasDoc(docId)) {
        send(conn, {
          type: "sub.error",
          topic,
          error: { code: "not_found", message: "文档不存在" },
        });
        return;
      }
      const head = svc.headRev(docId);
      if (cursor !== undefined && cursor > head) {
        send(conn, { type: "doc.reload", docId, rev: head, reason: "snapshot_required" });
        return;
      }
      const sub: DocSub = {
        topic,
        docId,
        live: false,
        lastRev: cursor ?? head,
        buffer: [],
      };
      conn.docSubs.set(topic, sub);
      send(conn, { type: "sub.ok", topic, headCursor: head, cursor: sub.lastRev });
      if (cursor !== undefined) {
        for (const op of svc.opsAfter(docId, cursor)) {
          sub.lastRev = op.rev;
          sendDocOp(conn, docId, op.rev, `${op.sourceKind}:${op.sourceId ?? ""}`, op.mutations);
        }
      }
      for (const m of sub.buffer) {
        if (m.rev > sub.lastRev) {
          sub.lastRev = m.rev;
          sendDocOp(conn, docId, m.rev, m.source, m.mutations);
        }
      }
      sub.buffer = [];
      sub.live = true;
      // presence 是瞬时状态：新订阅者立即拿到当前参与者，不走历史游标。
      publishPresence(docId);
      emit("sub.live", { connectionId: conn.id, topic, caughtUp: 0 });
      return;
    }
    if (topic === "app") {
      conn.isAppSub = true;
      opts.render?.addRenderer(conn.id, (m) => send(conn, m));
      send(conn, { type: "sub.ok", topic, headCursor: 0, cursor: 0 });
      return;
    }
    const sessionId = topic.slice("session:".length);
    const head = opts.log.headSeq(sessionId);
    const sub: Sub = {
      topic,
      sessionId,
      live: false,
      lastSent: cursor ?? head,
      buffer: [],
    };
    conn.subs.set(topic, sub);
    send(conn, { type: "sub.ok", topic, headCursor: head, cursor: sub.lastSent });
    let sent = 0;
    if (cursor !== undefined) {
      for (;;) {
        const rows = opts.log.readAfter(sessionId, sub.lastSent, PAGE_SIZE);
        for (const rec of rows) send(conn, { type: "rec", topic, seq: rec.seq, record: rec });
        sent += rows.length;
        if (rows.length > 0) sub.lastSent = (rows[rows.length - 1] as LogRecord).seq;
        if (rows.length < PAGE_SIZE) break;
        await yieldLoop();
        await waitDrain(conn);
        if (conn.subs.get(topic) !== sub || !conns.has(conn.id)) return;
      }
    }
    for (const m of sub.buffer) {
      if (m.seq > sub.lastSent) {
        sub.lastSent = m.seq;
        send(conn, { type: "rec", topic, seq: m.seq, record: m.rec });
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
      case "render.result":
        opts.render?.handleResult(conn.id, msg);
        break;
      case "unsub": {
        if (msg.topic === "app") {
          conn.isAppSub = false;
          opts.render?.removeRenderer(conn.id);
        }
        conn.subs.delete(msg.topic);
        const oldDoc = msg.topic.startsWith("doc:") ? msg.topic.slice("doc:".length) : null;
        conn.docSubs.delete(msg.topic);
        if (oldDoc !== null && conn.presence.delete(oldDoc)) publishPresence(oldDoc);
        break;
      }
      case "presence": {
        if (!conn.docSubs.has(`doc:${msg.docId}`)) break;
        conn.presence.set(msg.docId, {
          participantId: conn.id,
          kind: "client",
          name: "当前用户",
          color: presenceColor(conn.id),
          sheet: msg.sheet,
          selection: msg.selection,
          ...(msg.viewport !== undefined ? { viewport: msg.viewport } : {}),
          updatedAt: new Date().toISOString(),
        });
        publishPresence(msg.docId);
        break;
      }
      case "doc.submit": {
        const svc = opts.docService;
        const root = opts.workspaceRootFor?.(msg.docId);
        if (!svc || !root) {
          send(conn, {
            type: "doc.reject",
            clientOpId: msg.clientOpId,
            conflict: { code: "not_found", message: "文档不存在或未装配" },
          });
          break;
        }
        void svc
          .submit(msg.docId, root, {
            baseRev: msg.baseRev,
            source: { kind: "user", id: conn.id },
            mutations: msg.mutations as DocMutation[],
            ...(msg.overwrite === true ? { overwrite: true } : {}),
          })
          .then((result) => {
            if (result.ok) {
              send(conn, { type: "doc.ack", clientOpId: msg.clientOpId, rev: result.rev });
            } else {
              send(conn, {
                type: "doc.reject",
                clientOpId: msg.clientOpId,
                conflict: {
                  code: result.code,
                  message: result.message,
                  ...(result.conflicts !== undefined
                    ? { conflicts: result.conflicts, hint: "只重读这些区域后再写" }
                    : {}),
                },
              });
            }
          })
          .catch((err: unknown) => {
            emit("doc.submit.failed", { connectionId: conn.id, name: (err as Error).name });
            send(conn, {
              type: "doc.reject",
              clientOpId: msg.clientOpId,
              conflict: { code: "internal", message: "提交失败" },
            });
          });
        break;
      }
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
      default:
        send(conn, {
          type: "error",
          error: { code: "not_implemented", message: "该同步消息尚未实现" },
        });
        break;
    }
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

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
    if (!opts.allowedHosts().has(req.headers.host ?? "")) {
      emit("upgrade.rejected", { reason: "host" });
      return rejectUpgrade(socket, 403, "Forbidden", "forbidden_host");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !opts.allowedOrigins().has(origin)) {
      emit("upgrade.rejected", { reason: "origin" });
      return rejectUpgrade(socket, 403, "Forbidden", "forbidden_origin");
    }
    if (url.pathname !== "/api/v1/sync") {
      emit("upgrade.rejected", { reason: "path" });
      return rejectUpgrade(socket, 404, "Not Found", "not_found");
    }
    const ticket = url.searchParams.get("ticket") ?? "";
    const key = sha256(ticket);
    const expires = opts.tickets.get(key);
    opts.tickets.delete(key);
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
        docSubs: new Map(),
        presence: new Map(),
        isAppSub: false,
        idleTimer: setTimeout(() => {}, 0),
      };
      const armIdle = () => {
        clearTimeout(conn.idleTimer);
        conn.idleTimer = setTimeout(() => {
          emit("ws.timeout", { connectionId: conn.id });
          ws.terminate();
        }, heartbeatTimeoutMs);
      };
      armIdle();
      const pinger = setInterval(() => send(conn, { type: "ping" }), heartbeatMs);
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
        const changedDocs = [...conn.presence.keys()];
        conn.presence.clear();
        conns.delete(conn.id);
        for (const docId of changedDocs) publishPresence(docId);
        opts.render?.removeRenderer(conn.id);
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

  server.on("upgrade", onUpgrade);

  return () => {
    server.off("upgrade", onUpgrade);
    unsubscribe();
    unsubscribeDoc();
    for (const c of conns.values()) c.ws.terminate();
    wss.close();
  };
}
