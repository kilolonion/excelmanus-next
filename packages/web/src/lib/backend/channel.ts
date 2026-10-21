// 同步通道单例：各 store 经这里订阅主题、收消息、发消息，彼此不直接引用。
// 截图请求（workbook_render，ADR 0010）在这里统一响应：任一打开的页签都能充当渲染端。

import { type ClientMessage, protocolCompatible, type ServerMessage } from "@excelmanus/protocol";
import { ApiError, api, connectBackend, isDesktop } from "./api";
import { renderLayoutToPng } from "./render";
import { SyncClient } from "./sync";

type Handler = (message: ServerMessage) => void;

const handlers = new Set<Handler>();
const stateListeners = new Set<(connected: boolean) => void>();
const cursors = new Map<string, () => number | undefined>();
let client: SyncClient | null = null;
let connectionId: string | null = null;

export function onSync(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function onConnection(listener: (connected: boolean) => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** 订阅主题；cursor 在每次（重新）订阅时取当前续传点。 */
export function subscribeTopic(
  topic: string,
  cursor: () => number | undefined = () => undefined,
): void {
  cursors.set(topic, cursor);
  client?.subscribe(topic);
}

export function unsubscribeTopic(topic: string): void {
  cursors.delete(topic);
  client?.unsubscribe(topic);
}

/** 游标回退后重新订阅（例如重新载入整段会话）。 */
export function resubscribeTopic(topic: string): void {
  client?.resubscribe(topic);
}

export function sendSync(message: ClientMessage): boolean {
  return client?.send(message) ?? false;
}

/** 本连接 id（hello）：用于识别服务端回显的本端文档修订。 */
export function syncConnectionId(): string | null {
  return connectionId;
}

function handleRender(message: ServerMessage): void {
  if (message.type !== "render.request") return;
  const requestId = message.requestId;
  void renderLayoutToPng(message.layout, message.scale ?? 2)
    .then((png) => sendSync({ type: "render.result", requestId, png }))
    .catch((error: unknown) =>
      sendSync({
        type: "render.result",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
}

export function startChannel(opts: { onIncompatible(): void }): void {
  if (client) return;
  client = new SyncClient({
    ticket: async () => {
      try {
        return (await api().createTicket()).ticket;
      } catch (error) {
        // 服务重启后启动令牌会换新，旧 Cookie 失效：重新换一次 Cookie 再取票
        if (!(error instanceof ApiError) || error.status !== 401 || isDesktop()) throw error;
        await connectBackend();
        return (await api().createTicket()).ticket;
      }
    },
    cursor: (topic) => cursors.get(topic)?.(),
    onMessage: (message) => {
      if (message.type === "hello") {
        if (!protocolCompatible(message.protocolVersion)) {
          client?.stop();
          opts.onIncompatible();
          return;
        }
        connectionId = message.connectionId;
      }
      if (message.type === "render.request") {
        handleRender(message);
        return;
      }
      for (const handler of handlers) handler(message);
    },
    onState: (connected) => {
      if (!connected) connectionId = null;
      for (const listener of stateListeners) listener(connected);
    },
  });
  for (const topic of cursors.keys()) client.subscribe(topic);
  client.start();
}

/** 桌面离屏截图窗口（?renderer=1）：不挂界面，只订阅 app 主题并响应截图请求。 */
export async function startRendererOnly(): Promise<void> {
  if ((await connectBackend()) !== "ok") return;
  subscribeTopic("app");
  startChannel({ onIncompatible: () => undefined });
}
