import { parseRange } from "./a1.ts";

type ChartObject = {
  type: "column" | "bar" | "line" | "pie" | "doughnut" | "scatter" | "area" | "combo";
  title: string;
  range: string;
};

type Cells = Record<number, Record<number, { v?: unknown } | null | undefined> | undefined>;
/** Build chart data from the current workbook snapshot, never executable OOXML configuration. */
export function chartPreviewOption(chart: ChartObject, cells: Cells) {
  const r = parseRange(chart.range);
  if (r.endRow - r.startRow > 10000 || r.endCol - r.startCol > 32)
    throw new Error("图表预览最多支持 10000 行和 32 个系列");
  const value = (row: number, col: number) => cells[row - 1]?.[col - 1]?.v;
  const numeric = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rows = Array.from(
    { length: Math.max(0, r.endRow - r.startRow) },
    (_, i) => r.startRow + 1 + i,
  );
  const categories =
    chart.type === "scatter" ? [] : rows.map((row) => String(value(row, r.startCol) ?? ""));
  const base = {
    animation: false,
    color: ["#087f68", "#4c8bd5", "#d99a33", "#9865b8", "#d56868", "#4ba4a7"],
    title: { text: chart.title, left: 12, top: 10, textStyle: { fontSize: 15 } },
    legend: { bottom: 8, type: "scroll" },
    tooltip: { trigger: "axis", renderMode: "richText" },
    grid: { left: 52, right: 24, top: 52, bottom: 58, containLabel: true },
  };
  if (chart.type === "pie" || chart.type === "doughnut")
    return {
      ...base,
      tooltip: { trigger: "item", renderMode: "richText" },
      series: [
        {
          type: "pie",
          name: String(value(r.startRow, r.startCol + 1) ?? ""),
          radius: chart.type === "doughnut" ? ["35%", "65%"] : "65%",
          center: ["50%", "50%"],
          data: rows.map((row, i) => ({
            name: categories[i],
            value: numeric(value(row, r.startCol + 1)) ?? 0,
          })),
        },
      ],
    };
  const columns = Array.from(
    { length: Math.max(0, r.endCol - r.startCol) },
    (_, i) => r.startCol + 1 + i,
  );
  const scatterRows: { row: number; x: number }[] = [];
  if (chart.type === "scatter")
    for (const row of rows) {
      const x = numeric(value(row, r.startCol));
      if (x !== null) scatterRows.push({ row, x });
    }
  const scatterData = (column: number) => {
    const data: number[][] = [];
    for (const { row, x } of scatterRows) {
      const y = numeric(value(row, column));
      if (y !== null) data.push([x, y]);
    }
    return data;
  };
  const series = columns.map((column, index) => ({
    name: String(value(r.startRow, column) ?? `系列${index + 1}`),
    type:
      chart.type === "scatter"
        ? "scatter"
        : chart.type === "line" ||
            chart.type === "area" ||
            (chart.type === "combo" && index === columns.length - 1)
          ? "line"
          : "bar",
    ...(chart.type === "area" ? { areaStyle: { opacity: 0.25 } } : {}),
    connectNulls: false,
    data:
      chart.type === "scatter"
        ? scatterData(column)
        : rows.map((row) => numeric(value(row, column))),
  }));
  const category = { type: "category", data: categories, axisLabel: { hideOverlap: true } };
  const numericAxis = { type: "value", scale: chart.type === "scatter" };
  return {
    ...base,
    xAxis: chart.type === "bar" || chart.type === "scatter" ? numericAxis : category,
    yAxis: chart.type === "bar" ? category : numericAxis,
    series,
  };
}
