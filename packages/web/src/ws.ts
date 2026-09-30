// 同步通道客户端（11 §3）：一次性票据 → WS → sub 带游标；断线指数退避重连并从游点续传。

import { ServerMessage } from "@excelmanus/protocol";
import { wsUrl } from "./api.ts";

export interface SyncClientOpts {
  ticket(): Promise<string>;
  cursor(topic: string): number;
  onMessage(msg: ServerMessage): void;
  onState?(connected: boolean): void;
}

export class SyncClient {
  private readonly opts: SyncClientOpts;
  private ws: WebSocket | null = null;
  private readonly topics = new Set<string>();
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SyncClientOpts) {
    this.opts = opts;
  }

  /** 同时保留一个会话与一个文档主题，同类主题切换时退订旧主题。 */
  subscribe(topic: string): void {
    for (const old of this.topics) {
      if (old !== topic && old.split(":")[0] === topic.split(":")[0]) this.unsubscribe(old);
    }
    this.topics.add(topic);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "sub", topic, cursor: this.opts.cursor(topic) }));
    }
  }

  unsubscribe(topic: string): void {
    this.topics.delete(topic);
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type: "unsub", topic }));
  }

  start(): void {
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  /** 向当前连接发送一条已经通过 protocol 校验的同步消息。
   * 断线时返回 false；调用方不会自动重发用户编辑（11 §3.4）。
   */
  send(message: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    try {
      const ticket = await this.opts.ticket();
      const ws = new WebSocket(wsUrl(ticket));
      this.ws = ws;
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = ServerMessage.parse(JSON.parse(String(ev.data)));
        } catch {
          console.warn("无法解析的同步消息");
          return;
        }
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        this.opts.onMessage(msg);
      };
      ws.onopen = () => {
        this.attempts = 0;
        this.opts.onState?.(true);
        for (const topic of this.topics) {
          ws.send(JSON.stringify({ type: "sub", topic, cursor: this.opts.cursor(topic) }));
        }
      };
      ws.onclose = () => {
        this.opts.onState?.(false);
        this.ws = null;
        if (this.closed) return;
        const wait = Math.min(300 * 2 ** this.attempts, 5000);
        this.attempts += 1;
        this.timer = setTimeout(() => void this.connect(), wait);
      };
      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.opts.onState?.(false);
      const wait = Math.min(300 * 2 ** this.attempts, 5000);
      this.attempts += 1;
      this.timer = setTimeout(() => void this.connect(), wait);
    }
  }
}
