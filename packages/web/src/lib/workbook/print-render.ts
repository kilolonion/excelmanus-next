import type { ChartObject } from "@excelmanus/protocol";
import type { EChartsOption } from "echarts";
import { chartPreviewOption } from "./chart-preview";

/** Use the same chart option builder and SVG renderer as the workbench. */
export async function printChartSource(
  chart: ChartObject,
  cells: Parameters<typeof chartPreviewOption>[1],
) {
  const [core, charts, components, renderers] = await Promise.all([
    import("echarts/core"),
    import("echarts/charts"),
    import("echarts/components"),
    import("echarts/renderers"),
  ]);
  core.use([
    charts.BarChart,
    charts.LineChart,
    charts.PieChart,
    charts.ScatterChart,
    components.TitleComponent,
    components.TooltipComponent,
    components.LegendComponent,
    components.GridComponent,
    renderers.SVGRenderer,
  ]);
  const instance = core.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: chart.width,
    height: chart.height,
  });
  try {
    instance.setOption(chartPreviewOption(chart, cells) as EChartsOption);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(instance.renderToSVGString())}`;
  } finally {
    instance.dispose();
  }
}
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}
