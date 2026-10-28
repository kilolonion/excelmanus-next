import { workbookShapeSource } from "@excelmanus/core";
import { ConditionalFormattingService, iconMap } from "@univerjs/sheets-conditional-formatting";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api as backend } from "@/lib/backend/api";
import { buildPrintHtml, type PrintEffect } from "@/lib/workbook/print";
import { printObjectLayout } from "@/lib/workbook/print-objects";
import { blobDataUrl, printChartSource } from "@/lib/workbook/print-render";
import { type PrintScope, workbookPrintPreview } from "@/lib/workbook/print-settings";
import { useWorkbookStore } from "@/stores/workbook-store";
import type { SheetApi } from "./FormatToolbar";

export function WorkbookPrintDialog({
  api,
  name,
  onClose,
}: {
  api: SheetApi;
  name: string;
  onClose(): void;
}) {
  const [settings, setSettings] = useState(() =>
    workbookPrintPreview(api.wb.save(), api.wb.getActiveSheet()?.getSheetId() ?? ""),
  );
  const [scope, setScope] = useState<PrintScope>(settings.scope);
  const [orientation, setOrientation] = useState(settings.orientation);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const [output, setOutput] = useState({ html: "", error: "" });
  useEffect(() => {
    let disposed = false;
    setReady(false);
    setError("");
    setOutput({ html: "", error: "" });
    void (async () => {
      try {
        const active = api.wb.getActiveSheet();
        if (!active) throw new Error("没有活动工作表");
        const snapshot = api.wb.save(),
          sheet = snapshot.sheets[active.getSheetId()];
        const current = workbookPrintPreview(snapshot, active.getSheetId());
        setSettings(current);
        const selection = active.getSelection()?.getActiveRange()?.getRange();
        if (scope === "workbook" && !current.area)
          throw new Error("工作簿打印区域已不可用，请选择当前工作表或当前选区。");
        if (scope === "selection" && !selection) throw new Error("请先选择一个区域");
        const { range, objects: placed } = printObjectLayout(
          sheet,
          scope === "workbook" ? current.area : scope === "selection" ? selection : undefined,
        );
        const { workspaceId, doc } = useWorkbookStore.getState();
        const objects = await Promise.all(
          placed.map(async ({ object, left, top }) => {
            let src: string;
            if ("range" in object) src = await printChartSource(object, sheet.cellData ?? {});
            else if ("type" in object) src = workbookShapeSource(object);
            else {
              if (!workspaceId || !doc) throw new Error("工作簿尚未就绪，无法读取图片");
              src = await blobDataUrl(
                await backend().getDocImage(workspaceId, doc.docId, active.getSheetId(), object.id),
              );
            }
            return {
              left,
              top,
              width: object.width,
              height: object.height,
              title: object.title,
              src,
            };
          }),
        );
        if (disposed || api.disposed) return;
        const effects: Record<string, PrintEffect> = {};
        const cf = api.univer.__getInjector().get(ConditionalFormattingService);
        for (let r = range.startRow; r <= range.endRow; r++)
          for (let c = range.startColumn; c <= range.endColumn; c++) {
            const effect = cf.composeStyle(api.wb.getId(), active.getSheetId(), r, c);
            if (effect)
              effects[`${r}:${c}`] = {
                ...effect,
                iconSrc: effect.iconSet
                  ? iconMap[effect.iconSet.iconType]?.[Number(effect.iconSet.iconId)]
                  : undefined,
              };
          }
        const display = active
          .getRange(
            range.startRow,
            range.startColumn,
            range.endRow - range.startRow + 1,
            range.endColumn - range.startColumn + 1,
          )
          .getDisplayValues();
        setOutput({
          html: buildPrintHtml({
            sheet,
            effects,
            objects,
            styles: snapshot.styles,
            range,
            display,
            orientation,
            title: `${name} · ${sheet.name}`,
          }),
          error: "",
        });
      } catch (e) {
        if (!disposed)
          setOutput({ html: "", error: e instanceof Error ? e.message : "生成预览失败" });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [api, name, scope, orientation]);
  const print = async () => {
    try {
      const target = frame.current?.contentWindow;
      if (!target) throw new Error("打印预览尚未准备好");
      await target.document.fonts.ready;
      await Promise.all([...target.document.images].map((image) => image.decode()));
      target.focus();
      target.print();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开打印窗口");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>导出 PDF / 打印</DialogTitle>
          <DialogDescription>
            在浏览器打印窗口选择“另存为 PDF”。这是独立的浏览器预览，不代表 XLSX
            打印保真。范围和方向切换仅影响本次预览，不会写回工作簿。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={scope === "workbook" ? "default" : "outline"}
            aria-pressed={scope === "workbook"}
            disabled={!settings.area}
            onClick={() => {
              if (scope !== "workbook") setReady(false);
              setScope("workbook");
            }}
          >
            工作簿打印区域
          </Button>
          <Button
            variant={scope === "sheet" ? "default" : "outline"}
            aria-pressed={scope === "sheet"}
            onClick={() => {
              if (scope !== "sheet") setReady(false);
              setScope("sheet");
            }}
          >
            当前工作表
          </Button>
          <Button
            variant={scope === "selection" ? "default" : "outline"}
            aria-pressed={scope === "selection"}
            onClick={() => {
              if (scope !== "selection") setReady(false);
              setScope("selection");
            }}
          >
            当前选区
          </Button>
          <Button
            variant={orientation === "portrait" ? "default" : "outline"}
            aria-pressed={orientation === "portrait"}
            onClick={() => {
              if (orientation !== "portrait") setReady(false);
              setOrientation("portrait");
            }}
          >
            纵向 A4
          </Button>
          <Button
            variant={orientation === "landscape" ? "default" : "outline"}
            aria-pressed={orientation === "landscape"}
            onClick={() => {
              if (orientation !== "landscape") setReady(false);
              setOrientation("landscape");
            }}
          >
            横向 A4
          </Button>
        </div>
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            预览自动适宽，页边距固定为 12mm，未采用工作簿缩放和页边距。
            手动分页、重复标题和页眉页脚（含动态字段）未投影。
          </p>
          <p>
            保留可复制文字、边框、条件格式和受支持的图表图片；范围会扩展至相交合并单元格。
            范围外对象会裁剪，引用区外数据的图表不包含在区域导出中。
          </p>
          {settings.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <details className="max-h-40 overflow-y-auto rounded border p-2">
            <summary className="cursor-pointer font-medium text-foreground">
              工作簿页面设置摘要{settings.areaLabel ? ` · 打印区域 ${settings.areaLabel}` : ""}
            </summary>
            <dl className="mt-2 space-y-1">
              {settings.summary.map(({ label, value }) => (
                <div key={label} className="flex flex-wrap gap-x-2 break-all">
                  <dt className="font-medium">{label}：</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
        {(output.error || error) && (
          <p role="alert" className="text-sm text-destructive">
            {output.error || error}
          </p>
        )}
        {!output.html && !output.error && <p role="status">正在准备单元格、图表和图片…</p>}
        {output.html && (
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: iframe load reports preview readiness; it is not a user interaction handler.
          <iframe
            key={scope + orientation}
            ref={frame}
            title="PDF 导出预览"
            sandbox="allow-same-origin allow-modals"
            srcDoc={output.html}
            onLoad={() => setReady(true)}
            className="h-[40vh] min-h-48 w-full rounded border bg-white"
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button disabled={!ready || !!output.error} onClick={() => void print()}>
            打开打印预览
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
