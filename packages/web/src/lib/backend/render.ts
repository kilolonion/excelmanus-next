// 截图渲染端（ADR 0010）：服务端下发版式，界面在离屏 canvas 上绘制并回传 PNG。
// 绘制共享单元格与对象版式，不执行工作簿代码，不加载外部资源。

import { chartPreviewOption, paintWorkbookCells, workbookShapeSource } from "@excelmanus/core";
import type { RenderLayout } from "@excelmanus/protocol";
import type { EChartsOption } from "echarts";

export async function renderLayoutToPng(
  layout: RenderLayout,
  scale = 2,
  isCurrent: () => boolean = () => true,
): Promise<string> {
  const checkCurrent = () => {
    if (!isCurrent()) throw new DOMException("预览已关闭或切换", "AbortError");
  };
  checkCurrent();
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
  paintWorkbookCells(ctx, layout.cells, '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif');
  ctx.save();
  ctx.beginPath();
  ctx.rect(44, 22, Math.max(0, w - 44), Math.max(0, h - 22));
  ctx.clip();
  if (layout.charts?.length) {
    const [echarts, charts, components, renderers, features] = await Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers"),
      import("echarts/features"),
    ]);
    checkCurrent();
    echarts.use([
      charts.BarChart,
      charts.LineChart,
      charts.PieChart,
      charts.ScatterChart,
      components.TitleComponent,
      components.TooltipComponent,
      components.LegendComponent,
      components.GridComponent,
      renderers.CanvasRenderer,
      features.LabelLayout,
      features.LegacyGridContainLabel,
    ]);
    for (const item of layout.charts) {
      const target = document.createElement("canvas");
      const chart = echarts.init(target, undefined, {
        renderer: "canvas",
        width: item.w,
        height: item.h,
        devicePixelRatio: scale,
      });
      try {
        chart.setOption({
          ...chartPreviewOption(item.chart, item.cells),
          backgroundColor: "#ffffff",
        } as EChartsOption);
        ctx.drawImage(chart.renderToCanvas(), item.x, item.y, item.w, item.h);
      } finally {
        chart.dispose();
      }
    }
  }
  for (const item of layout.images ?? []) {
    const image = new Image();
    image.src = `data:${item.mediaType};base64,${item.data}`;
    await image.decode();
    checkCurrent();
    ctx.drawImage(image, item.x, item.y, item.w, item.h);
  }
  for (const item of layout.shapes ?? []) {
    const image = new Image();
    image.src = workbookShapeSource(item.shape, scale);
    await image.decode();
    checkCurrent();
    ctx.drawImage(image, item.x, item.y, item.w, item.h);
  }
  ctx.restore();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  checkCurrent();
  if (!blob) throw new Error("PNG 编码失败");
  const buf = new Uint8Array(await blob.arrayBuffer());
  checkCurrent();
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
