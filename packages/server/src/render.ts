// 截图渲染中转（07 §8、ADR 0010）：workbook_render 计算版式后经同步通道交给一个已连接的
// 界面客户端在 canvas 上绘制；没有客户端或客户端失败时，服务器复用相同绘制逻辑生成 PNG。

import { newId } from "@excelmanus/core";
import type { RenderLayout, ServerMessage } from "@excelmanus/protocol";
import { renderHeadless } from "./headless-render.ts";

interface Pending {
  resolve(png: string): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  renderer: string;
}

export class RenderBroker {
  private readonly renderers = new Map<string, (msg: ServerMessage) => void>();
  private readonly pending = new Map<string, Pending>();

  addRenderer(connId: string, send: (msg: ServerMessage) => void): void {
    this.renderers.set(connId, send);
  }

  removeRenderer(connId: string): void {
    this.renderers.delete(connId);
    for (const [id, p] of this.pending) {
      if (p.renderer === connId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error("渲染端已断开"));
      }
    }
  }

  get available(): boolean {
    return true; // Headless rendering is always registered.
  }

  handleResult(connId: string, msg: { requestId: string; png?: string; error?: string }): void {
    const p = this.pending.get(msg.requestId);
    if (!p || p.renderer !== connId) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.requestId);
    if (msg.png) p.resolve(msg.png);
    else p.reject(new Error(msg.error ?? "渲染失败"));
  }

  /** 选最近连接的渲染端；超时 5 秒后使用服务器绘制。返回 PNG base64。 */
  request(layout: RenderLayout, scale = 2, timeoutMs = 5_000): Promise<string> {
    const entries = [...this.renderers.entries()];
    const target = entries[entries.length - 1];
    // Old connected clients may silently strip new layout fields. Rich renders stay
    // server-side until explicit renderer capabilities are negotiated.
    const rich =
      layout.charts?.length ||
      layout.images?.length ||
      layout.shapes?.length ||
      layout.cells.some(
        (c) => Object.values(c.borders ?? {}).some((b) => b && b.style > 0) || c.dataBar || c.icon,
      );
    if (!target || rich) {
      return renderHeadless(layout, scale);
    }
    const [connId, send] = target;
    const requestId = newId("rnd");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("渲染超时"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, renderer: connId });
      send({ type: "render.request", requestId, layout, scale });
    }).catch(() => renderHeadless(layout, scale));
  }
}
