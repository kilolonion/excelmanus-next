// 同步通道客户端（11 §3）：一次性票据 → WS → sub 带游标；断线指数退避重连并从游点续传。

import { ServerMessage } from "@excelmanus/protocol";
import { wsUrl } from "./api.ts";

export interface SyncClientOpts {
  ticket(): Promise<string>;
  cursor(): number;
  onMessage(msg: ServerMessage): void;
  onState?(connected: boolean): void;
}

export class SyncClient {
  private readonly opts: SyncClientOpts;
  private ws: WebSocket | null = null;
  private topic: string | null = null;
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SyncClientOpts) {
    this.opts = opts;
  }

  /** 订阅会话主题；重复调用会先退订旧主题。 */
  subscribe(topic: string): void {
    this.topic = topic;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "sub", topic, cursor: this.opts.cursor() }));
    }
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
          console.warn("无法解析的同步消息", ev.data);
          return;
        }
        this.opts.onMessage(msg);
      };
      ws.onopen = () => {
        this.attempts = 0;
        this.opts.onState?.(true);
        if (this.topic) {
          ws.send(JSON.stringify({ type: "sub", topic: this.topic, cursor: this.opts.cursor() }));
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
