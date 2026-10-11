// 截图渲染端（ADR 0010）：服务端下发版式，界面在离屏 canvas 上绘制并回传 PNG。
// 只画文本、填充、网格与表头，不执行任何来自工作簿的代码或外部资源。

import type { RenderLayout } from "@excelmanus/protocol";

const GRID = "#d9d9d9";
const HEAD_BG = "#f3f3f3";
const HEAD_TEXT = "#666666";
const FONT = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

function safeColor(c: string | undefined, fallback: string): string {
  return c && /^#?[0-9a-fA-F]{3,8}$/.test(c) ? (c.startsWith("#") ? c : `#${c}`) : fallback;
}

export async function renderLayoutToPng(layout: RenderLayout, scale = 2): Promise<string> {
  const w = Math.max(1, Math.ceil(layout.width));
  const h = Math.max(1, Math.ceil(layout.height));
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  for (const cell of layout.cells) {
    ctx.fillStyle = cell.header ? HEAD_BG : safeColor(cell.fill, "#ffffff");
    if (cell.header || cell.fill) ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
  }
  // 网格线：按单元格边界描边（合并单元格自然没有内部线）
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (const cell of layout.cells) ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w, cell.h);
  for (const cell of layout.cells) {
    if (cell.text === "") continue;
    const size = Math.min(Math.max(cell.fontSize ?? 11, 8), 28) * (96 / 72);
    ctx.font = `${cell.italic ? "italic " : ""}${cell.bold ? "bold " : ""}${Math.round(size)}px ${FONT}`;
    ctx.fillStyle = cell.header ? HEAD_TEXT : safeColor(cell.color, "#1a1c1c");
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
    ctx.clip();
    const pad = 4;
    let align = cell.align ?? "left";
    // 放不下时先缩小字号（最多到 75%），仍放不下则左对齐从尾部裁剪，保证开头可读
    const room = cell.w - pad * 2;
    if (ctx.measureText(cell.text).width > room) {
      const shrunk = Math.max(size * 0.75, (size * room) / ctx.measureText(cell.text).width);
      ctx.font = `${cell.italic ? "italic " : ""}${cell.bold ? "bold " : ""}${Math.round(shrunk)}px ${FONT}`;
      if (ctx.measureText(cell.text).width > room) align = "left";
    }
    ctx.textAlign = align;
    const tx =
      align === "center"
        ? cell.x + cell.w / 2
        : align === "right"
          ? cell.x + cell.w - pad
          : cell.x + pad;
    ctx.fillText(cell.text, tx, cell.y + cell.h / 2);
    ctx.restore();
  }
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG 编码失败");
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * 只作渲染端（桌面离屏截图窗口，13 §1）：不挂界面，只连同步通道订阅 app 主题并响应截图请求。
 */
export async function startRendererOnly(): Promise<void> {
  const { apiClient, bootstrapToken } = await import("./api.ts");
  const { SyncClient } = await import("./ws.ts");
  const token = bootstrapToken();
  if (!token) return;
  const api = apiClient(token);
  const sync: InstanceType<typeof SyncClient> = new SyncClient({
    ticket: async () => (await api.createTicket()).ticket,
    cursor: () => 0,
    onMessage: (msg) => {
      if (msg.type !== "render.request") return;
      const requestId = msg.requestId;
      void renderLayoutToPng(msg.layout, msg.scale ?? 2)
        .then((png) => sync.send({ type: "render.result", requestId, png }))
        .catch((e: unknown) =>
          sync.send({
            type: "render.result",
            requestId,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
    },
  });
  sync.start();
  sync.subscribe("app");
}
