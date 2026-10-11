import * as http from "node:http";
import WebSocket from "ws";
import { type LogRecord, ServerMessage, serverMessageTypes, TicketResponse } from "./protocol.ts";

// ---------------- 纯状态 ----------------

export interface StreamView {
  agentId: string;
  stepId: string;
  text: string;
  reasoning: string;
  toolArgs: string;
}

export interface TopicState {
  lastSeq: number;
  headCursor: number | null;
  records: readonly { seq: number; record: LogRecord }[];
  streams: Readonly<Record<string, StreamView>>;
}

export interface ClientState {
  connectionId: string | null;
  protocolVersion: number | null;
  topics: Readonly<Record<string, TopicState>>;
  warnings: readonly string[];
  errors: readonly { code: string; message: string }[];
}

export const initialState: ClientState = Object.freeze({
  connectionId: null,
  protocolVersion: null,
  topics: Object.freeze({}),
  warnings: Object.freeze([]) as readonly string[],
  errors: Object.freeze([]) as readonly { code: string; message: string }[],
});

const emptyTopic: TopicState = Object.freeze({
  lastSeq: 0,
  headCursor: null,
  records: Object.freeze([]) as TopicState["records"],
  streams: Object.freeze({}),
});

const streamKey = (agentId: string, stepId: string) => `${agentId}/${stepId}`;

const warn = (state: ClientState, w: string): ClientState => ({
  ...state,
  warnings: [...state.warnings, w],
});

const withTopic = (state: ClientState, topic: string, fn: (t: TopicState) => TopicState) => ({
  ...state,
  topics: { ...state.topics, [topic]: fn(state.topics[topic] ?? emptyTopic) },
});

/** 纯函数：不发请求、不读写外部状态、不修改输入。未知/非法消息只追加警告。 */
export function reduce(state: ClientState, raw: unknown): ClientState {
  const type = (raw as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !serverMessageTypes.has(type)) {
    return warn(state, `unknown message type: ${String(type)}`);
  }
  const parsed = ServerMessage.safeParse(raw);
  if (!parsed.success) return warn(state, `invalid ${type} message`);
  const msg = parsed.data;
  switch (msg.type) {
    case "hello":
      return { ...state, connectionId: msg.connectionId, protocolVersion: msg.protocolVersion };
    case "sub.ok":
      return withTopic(state, msg.topic, (t) => ({
        ...t,
        headCursor: msg.headCursor,
        lastSeq: Math.max(t.lastSeq, msg.cursor),
      }));
    case "sub.error":
    case "error":
      return { ...state, errors: [...state.errors, msg.error] };
    case "rec": {
      const cur = state.topics[msg.topic] ?? emptyTopic;
      if (msg.seq <= cur.lastSeq) return state;
      const next = msg.seq !== cur.lastSeq + 1 ? warn(state, `gap before seq ${msg.seq}`) : state;
      return withTopic(next, msg.topic, (t) => {
        let streams = t.streams;
        const stepId = msg.record.data.stepId;
        if (
          msg.record.type === "model.output" &&
          msg.record.agentId &&
          typeof stepId === "string"
        ) {
          const { [streamKey(msg.record.agentId, stepId)]: _done, ...rest } = t.streams;
          streams = rest;
        }
        return {
          ...t,
          lastSeq: msg.seq,
          records: [...t.records, { seq: msg.seq, record: msg.record }],
          streams,
        };
      });
    }
    case "delta":
      return withTopic(state, msg.topic, (t) => {
        const key = streamKey(msg.agentId, msg.stepId);
        const s = t.streams[key] ?? {
          agentId: msg.agentId,
          stepId: msg.stepId,
          text: "",
          reasoning: "",
          toolArgs: "",
        };
        const piece = typeof msg.payload === "string" ? msg.payload : "";
        const field =
          msg.kind === "text"
            ? "text"
            : msg.kind === "reasoning"
              ? "reasoning"
              : msg.kind === "tool_args"
                ? "toolArgs"
                : null;
        if (!field) return t;
        return { ...t, streams: { ...t.streams, [key]: { ...s, [field]: s[field] + piece } } };
      });
    case "snapshot":
      return withTopic(state, msg.topic, (t) => ({
        ...t,
        streams: {
          ...t.streams,
          [streamKey(msg.agentId, msg.stepId)]: {
            agentId: msg.agentId,
            stepId: msg.stepId,
            text: msg.text,
            reasoning: msg.reasoning,
            toolArgs: msg.toolArgs,
          },
        },
      }));
    case "ping":
    case "pong":
      return state;
  }
}

// ---------------- 传输（薄壳） ----------------

export interface Endpoint {
  /** 实际 TCP 目标（可以是代理） */
  connectHost: string;
  connectPort: number;
  /** 发送的 Host 头（服务端自身地址） */
  hostHeader: string;
}

export function requestJson(
  ep: Endpoint,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: ep.connectHost,
        port: ep.connectPort,
        method,
        path,
        agent: false,
        timeout: 5000,
        headers: {
          host: ep.hostHeader,
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

export async function fetchTicket(ep: Endpoint, token: string): Promise<string> {
  const r = await requestJson(ep, "POST", "/api/v1/sync/ticket", { token });
  if (r.status !== 200) throw new Error(`ticket status ${r.status}`);
  return TicketResponse.parse(r.body).ticket;
}

export interface SyncClientOptions {
  endpoint: Endpoint;
  token: string;
  topics: string[];
  /** 首次订阅游标；缺省且 state 中无该主题时不带游标 */
  initialCursors?: Record<string, number>;
  initialState?: ClientState;
  heartbeatTimeoutMs?: number;
  backoffStartMs?: number;
  backoffMaxMs?: number;
  onMessage?: (raw: unknown, state: ClientState) => void;
  /** 测试用：登记本次换到的票据（S07 扫描明文） */
  onTicket?: (ticket: string) => void;
  onEvent?: (e: { kind: "open" | "close" | "connect_failed"; at: number; attempt: number }) => void;
}

export class SyncClient {
  state: ClientState;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private idle: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private readonly subscribed = new Set<string>();
  private opts: SyncClientOptions;

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
    this.state = opts.initialState ?? initialState;
    for (const t of opts.topics) this.subscribed.add(t);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.idle);
    this.ws?.terminate();
    this.ws = null;
  }

  get connectionId(): string | null {
    return this.state.connectionId;
  }

  subscribe(topic: string, cursor?: number): void {
    this.subscribed.add(topic);
    this.sendSub(topic, cursor);
  }

  unsubscribe(topic: string): void {
    this.subscribed.delete(topic);
    this.send({ type: "unsub", topic });
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendSub(topic: string, explicit?: number): void {
    const known = this.state.topics[topic];
    const cursor =
      explicit ??
      (known && known.headCursor !== null ? known.lastSeq : this.opts.initialCursors?.[topic]);
    this.send(cursor === undefined ? { type: "sub", topic } : { type: "sub", topic, cursor });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const start = this.opts.backoffStartMs ?? 100;
    const max = this.opts.backoffMaxMs ?? 2000;
    const delay = Math.min(max, start * 2 ** this.attempt);
    this.attempt++;
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  private armIdle(ws: WebSocket): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => ws.terminate(), this.opts.heartbeatTimeoutMs ?? 40_000);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const ep = this.opts.endpoint;
    let ticket: string;
    try {
      ticket = await fetchTicket(ep, this.opts.token);
      this.opts.onTicket?.(ticket);
    } catch {
      this.opts.onEvent?.({ kind: "connect_failed", at: Date.now(), attempt: this.attempt });
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const ws = new WebSocket(
      `ws://${ep.connectHost}:${ep.connectPort}/api/v1/sync?ticket=${encodeURIComponent(ticket)}`,
      { headers: { host: ep.hostHeader }, handshakeTimeout: 5000 },
    );
    this.ws = ws;
    let opened = false;
    ws.on("open", () => {
      opened = true;
      this.armIdle(ws);
    });
    ws.on("message", (data) => {
      this.armIdle(ws);
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        this.state = warn(this.state, "non-JSON frame");
        return;
      }
      this.state = reduce(this.state, raw);
      const type = (raw as { type?: unknown }).type;
      if (type === "ping") this.send({ type: "pong" });
      if (type === "hello") {
        this.attempt = 0;
        this.opts.onEvent?.({ kind: "open", at: Date.now(), attempt: this.attempt });
        for (const t of this.subscribed) this.sendSub(t);
      }
      this.opts.onMessage?.(raw, this.state);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(this.idle);
      if (this.ws === ws) this.ws = null;
      this.opts.onEvent?.({
        kind: opened ? "close" : "connect_failed",
        at: Date.now(),
        attempt: this.attempt,
      });
      this.scheduleReconnect();
    });
  }
}
