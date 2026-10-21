// 同步通道客户端（11 §3）：一次性票据 → WS → sub 带游标；断线指数退避重连并按各主题游标续传。
// 主题由各 store 显式订阅/退订；本端编辑断线时不自动重发（11 §3.4）。

import { type ClientMessage, ServerMessage } from "@excelmanus/protocol";
import { wsUrl } from "./api.js";

export interface SyncClientOptions {
  ticket(): Promise<string>;
  /** 重连/订阅时该主题应续传的游标（会话=最后 seq；文档=当前修订）。 */
  cursor(topic: string): number | undefined;
  onMessage(message: ServerMessage): void;
  onState?(connected: boolean): void;
}

export class SyncClient {
  private readonly opts: SyncClientOptions;
  private ws: WebSocket | null = null;
  private readonly topics = new Set<string>();
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
  }

  subscribe(topic: string): void {
    this.topics.add(topic);
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(this.ws, topic);
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type: "unsub", topic }));
  }

  /** 重新订阅（游标回退时用，例如会话回放需要从头开始）。 */
  resubscribe(topic: string): void {
    if (!this.topics.has(topic)) {
      this.subscribe(topic);
      return;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "unsub", topic }));
    this.sendSub(this.ws, topic);
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

  /** 发送一条同步消息；断线时返回 false，由调用方决定如何提示。 */
  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private sendSub(ws: WebSocket, topic: string): void {
    const cursor = this.opts.cursor(topic);
    ws.send(JSON.stringify({ type: "sub", topic, ...(cursor !== undefined ? { cursor } : {}) }));
  }

  private retry(): void {
    if (this.closed) return;
    const wait = Math.min(300 * 2 ** this.attempts, 5000);
    this.attempts += 1;
    this.timer = setTimeout(() => void this.connect(), wait);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let ticket: string;
    try {
      ticket = await this.opts.ticket();
    } catch {
      this.opts.onState?.(false);
      this.retry();
      return;
    }
    if (this.closed) return;
    const ws = new WebSocket(wsUrl(ticket));
    this.ws = ws;
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = ServerMessage.parse(JSON.parse(String(event.data)));
      } catch {
        console.warn("无法解析的同步消息");
        return;
      }
      if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      this.opts.onMessage(message);
    };
    ws.onopen = () => {
      this.attempts = 0;
      this.opts.onState?.(true);
      for (const topic of this.topics) this.sendSub(ws, topic);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.opts.onState?.(false);
      this.retry();
    };
    ws.onerror = () => ws.close();
  }
}
