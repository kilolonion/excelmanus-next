import { workbookShapeSource } from "@excelmanus/core";
import type { ChartObject, ImageObject, ShapeObject } from "@excelmanus/protocol";
import type { EChartsOption } from "echarts";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { chartPreviewOption } from "@/lib/workbook/chart-preview";
import { useWorkbookStore } from "@/stores/workbook-store";

type ChartInstance = ReturnType<typeof import("echarts/core")["init"]>;

type Props = { popup: { extraProps?: Record<string, unknown> } };
export function WorkbookObject({ popup }: Props) {
  const p = popup.extraProps ?? {};
  const chart = p.chart as ChartObject | undefined;
  const image = p.image as ImageObject | undefined;
  const shape = p.shape as ShapeObject | undefined;
  const chartRevision = chart && !image ? p.revision : undefined;
  const host = useRef<HTMLDivElement>(null);
  const renderedChart = useRef<{
    host: HTMLDivElement;
    instance: ChartInstance;
    width: number;
    height: number;
    optionKey?: string;
  } | null>(null);
  const chartMode = Boolean(chart && !image);
  useEffect(
    () => () => {
      renderedChart.current?.instance.dispose();
      renderedChart.current = null;
    },
    [chartMode, p.docId, p.sheetId],
  );
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [owner, setOwner] = useState<{
    source: ChartObject | ImageObject | undefined;
    docId: unknown;
    sheetId: unknown;
    attempt: number;
    chartRevision: unknown;
  } | null>(null);
  const current =
    owner?.source === (chart ?? image) &&
    owner?.docId === p.docId &&
    owner?.sheetId === p.sheetId &&
    owner?.attempt === attempt &&
    owner?.chartRevision === chartRevision;
  const visibleError = current ? error : undefined;
  const visibleSrc = current ? src : undefined;
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    setError(undefined);
    setSrc(undefined);
    setOwner({
      source: chart ?? image,
      docId: p.docId,
      sheetId: p.sheetId,
      attempt,
      chartRevision,
    });
    if (image) {
      const { workspaceId } = useWorkbookStore.getState();
      if (!workspaceId) return;
      void api()
        .getDocImage(workspaceId, String(p.docId), String(p.sheetId), image.id)
        .then((blob) => {
          if (disposed) return;
          const url = URL.createObjectURL(blob);
          setSrc(url);
          cleanup = () => URL.revokeObjectURL(url);
        })
        .catch((e) => {
          if (!disposed) setError(errorMessage(e, "图片加载失败"));
        });
    } else if (chart) {
      void Promise.all([
        import("echarts/core"),
        import("echarts/charts"),
        import("echarts/components"),
        import("echarts/renderers"),
      ])
        .then(([core, charts, components, renderers]) => {
          if (disposed || !host.current) return;
          const option = chartPreviewOption(
            chart,
            p.cells as Parameters<typeof chartPreviewOption>[1],
          ) as EChartsOption;
          let rendered = renderedChart.current;
          if (!rendered || rendered.host !== host.current) {
            rendered?.instance.dispose();
            renderedChart.current = null;
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
            rendered = {
              host: host.current,
              instance: core.init(host.current, undefined, { renderer: "svg" }),
              width: chart.width,
              height: chart.height,
            };
            renderedChart.current = rendered;
          } else if (rendered.width !== chart.width || rendered.height !== chart.height) {
            rendered.instance.resize();
            rendered.width = chart.width;
            rendered.height = chart.height;
          }
          const optionKey = JSON.stringify(option);
          if (rendered.optionKey !== optionKey) {
            rendered.instance.setOption(option, { notMerge: true });
            rendered.optionKey = optionKey;
          }
        })
        .catch((e) => {
          if (!disposed) {
            renderedChart.current?.instance.dispose();
            renderedChart.current = null;
            setError(errorMessage(e, "图表无法预览"));
          }
        });
    }
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [chart, image, p.docId, p.sheetId, p.cells, chartRevision, attempt]);
  if (p.note) {
    const note = p.note as { title: string; threaded?: boolean };
    return (
      <span
        role="note"
        aria-label={note.title}
        title={note.title}
        className={`block h-0 w-0 border-l-[8px] border-t-[8px] border-l-transparent ${note.threaded ? "border-t-[var(--em-primary)]" : "border-t-red-500"}`}
      />
    );
  }
  const object = chart ?? image ?? shape;
  if (!object) return null;
  return (
    <div
      data-em-workbook-object={object.id}
      className={
        shape
          ? "group relative overflow-hidden"
          : "group relative overflow-hidden rounded border border-border bg-white text-slate-800 shadow-sm"
      }
      style={{ width: object.width, height: object.height }}
    >
      {image && typeof p.onDelete === "function" && (
        <Button
          size="icon"
          variant="outline"
          className="absolute right-1 top-1 z-10 h-7 w-7 bg-background opacity-0 group-hover:opacity-100 focus:opacity-100"
          aria-label={`删除图片：${image.title || image.id}`}
          onClick={() =>
            void (async () => {
              if (
                !(await confirmAction({
                  title: "删除这张图片？",
                  description: "可在修订历史中撤销。",
                  confirmLabel: "删除图片",
                  tone: "danger",
                }))
              )
                return;
              try {
                await (p.onDelete as () => Promise<void>)();
              } catch (e) {
                toast({ title: errorMessage(e, "图片删除失败"), tone: "error" });
              }
            })()
          }
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
      {shape ? (
        <img
          src={workbookShapeSource(shape)}
          alt={shape.title || "工作簿形状"}
          className="h-full w-full"
        />
      ) : visibleError ? (
        <div role="alert" className="space-y-2 p-3 text-sm">
          <p>
            {object.title ? `${object.title}：` : ""}
            {visibleError}
          </p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            重新加载
          </Button>
        </div>
      ) : image ? (
        <img
          src={visibleSrc}
          alt={image.title || "工作簿图片"}
          className="h-full w-full object-contain"
        />
      ) : (
        <div
          ref={host}
          role="img"
          aria-label={`图表：${chart?.title}`}
          style={{ width: "100%", height: "100%" }}
        />
      )}
    </div>
  );
}
