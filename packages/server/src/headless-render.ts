import { chartPreviewOption, paintWorkbookCells, workbookShapeSvg } from "@excelmanus/core";
import type { RenderLayout } from "@excelmanus/protocol";

/** Rasterize the same cell layout as the UI; never launch a browser or load external resources. */
export async function renderHeadless(layout: RenderLayout, scale = 2): Promise<string> {
  const width = Math.ceil(layout.width * scale);
  const height = Math.ceil(layout.height * scale);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 32_000_000
  ) {
    throw new Error("渲染区域像素过大或尺寸无效，请缩小 range 后重试");
  }
  const { createCanvas, loadImage, GlobalFonts } = await import("@napi-rs/canvas");
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, layout.width, layout.height);
  paintWorkbookCells(
    ctx,
    layout.cells,
    '"Noto Sans CJK SC", "Noto Serif CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  );
  ctx.save();
  ctx.beginPath();
  ctx.rect(44, 22, Math.max(0, layout.width - 44), Math.max(0, layout.height - 22));
  ctx.clip();
  if (layout.charts?.length) {
    const echarts = await import("echarts");
    echarts.setPlatformAPI({
      createCanvas: () =>
        createCanvas(1, 1) as unknown as ReturnType<
          NonNullable<Parameters<typeof echarts.setPlatformAPI>[0]["createCanvas"]>
        >,
    });
    for (const item of layout.charts) {
      const target = createCanvas(Math.ceil(item.w * scale), Math.ceil(item.h * scale));
      const chart = echarts.init(
        target as unknown as Parameters<typeof echarts.init>[0],
        undefined,
        {
          renderer: "canvas",
          ssr: true,
          width: item.w,
          height: item.h,
          devicePixelRatio: scale,
        },
      );
      try {
        chart.setOption({
          ...chartPreviewOption(item.chart, item.cells),
          backgroundColor: "#ffffff",
          textStyle: { fontFamily: "Noto Sans CJK SC" },
        });
        chart.getZr().flush();
        ctx.drawImage(target, item.x, item.y, item.w, item.h);
      } finally {
        chart.dispose();
      }
    }
  }
  for (const item of layout.images ?? []) {
    const image = await loadImage(Buffer.from(item.data, "base64"));
    ctx.drawImage(image, item.x, item.y, item.w, item.h);
  }
  // Native SVG decoding does not fall back through CSS font-family lists.
  const shapeFont =
    ["Noto Sans CJK SC", "Noto Sans CJK JP", "DejaVu Sans", "Arial"].find((name) =>
      GlobalFonts.has(name),
    ) ?? GlobalFonts.families[0]?.family;
  for (const item of layout.shapes ?? []) {
    const image = await loadImage(Buffer.from(workbookShapeSvg(item.shape, shapeFont, scale)));
    ctx.drawImage(image, item.x, item.y, item.w, item.h);
  }
  ctx.restore();
  return (await canvas.encode("png")).toString("base64");
}
