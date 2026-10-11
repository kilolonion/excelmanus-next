// 截图渲染中转（07 §8、ADR 0010）：workbook_render 计算版式后经同步通道交给一个已连接的
// 界面客户端（本机 Web 页签或桌面窗口）在 canvas 上绘制，回传 PNG。没有可用渲染端时
// 明确报错，不伪造结果。

import { newId } from "@excelmanus/core";
import type { RenderLayout, ServerMessage } from "@excelmanus/protocol";

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
    return this.renderers.size > 0;
  }

  handleResult(connId: string, msg: { requestId: string; png?: string; error?: string }): void {
    const p = this.pending.get(msg.requestId);
    if (!p || p.renderer !== connId) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.requestId);
    if (msg.png) p.resolve(msg.png);
    else p.reject(new Error(msg.error ?? "渲染失败"));
  }

  /** 选最近连接的渲染端；超时 20 秒。返回 PNG base64。 */
  request(layout: RenderLayout, scale = 2, timeoutMs = 20_000): Promise<string> {
    const entries = [...this.renderers.entries()];
    const target = entries[entries.length - 1];
    if (!target) {
      return Promise.reject(
        new Error("没有可用的渲染端：请保持 ExcelManus 界面打开（浏览器页签或桌面窗口）"),
      );
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
    });
  }
}
