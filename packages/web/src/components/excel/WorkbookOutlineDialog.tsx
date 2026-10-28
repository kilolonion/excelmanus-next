import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createFrameRefresh } from "@/lib/workbook/frame-refresh";
import { axisOutlineRanges, outlineSettings } from "@/lib/workbook/outline-status";
import { useWorkbookStore } from "@/stores/workbook-store";
import type { SheetApi } from "./FormatToolbar";

const SETTING_LABELS = {
  summaryBelow: "汇总行位于下方",
  summaryRight: "汇总列位于右侧",
  showOutlineSymbols: "文件要求显示分组符号",
  applyStyles: "文件要求应用分组样式",
};

export function WorkbookOutlineDialog({ api, onClose }: { api: SheetApi; onClose(): void }) {
  const revision = useWorkbookStore((s) => s.doc?.rev);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const refresh = createFrameRefresh(() => setEpoch((value) => value + 1));
    const sub = api.wb.onCommandExecuted(() => refresh.schedule());
    return () => {
      refresh.dispose();
      sub.dispose();
    };
  }, [api]);
  const view = useMemo(() => {
    void revision;
    void epoch;
    if (api.disposed) return null;
    const sheet = api.wb.getActiveSheet()?.getSheet().getSnapshot();
    if (!sheet) return null;
    return {
      name: sheet.name,
      rows: axisOutlineRanges(sheet.rowData, "rows"),
      cols: axisOutlineRanges(sheet.columnData, "cols"),
      settings: outlineSettings(
        sheet.custom?.excelmanusOutlineSettings as Record<string, string> | undefined,
      ),
    };
  }, [api, api.disposed, revision, epoch]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>分组与隐藏状态（只读）</DialogTitle>
          <DialogDescription>
            当前界面无原生 ± 分组控件；隐藏、层级、折叠标记为独立状态。修改由命令或工作簿工具完成。
          </DialogDescription>
        </DialogHeader>
        {view ? (
          <div className="max-h-[60vh] space-y-4 overflow-auto text-xs">
            <p className="font-medium">当前工作表：{view.name}</p>
            <p className="text-muted-foreground">
              仅列出隐藏、非零层级或有折叠标记的行列。其余行列为可见、层级 0、无折叠标记。
              连续区间按相同状态合并，不代表组边界；取消隐藏不等于清除折叠标记。
            </p>
            {(["rows", "cols"] as const).map((axis) => (
              <section key={axis} aria-label={axis === "rows" ? "行状态" : "列状态"}>
                <h3 className="mb-2 font-medium">{axis === "rows" ? "行状态" : "列状态"}</h3>
                {view[axis].length ? (
                  <table className="w-full text-left">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-1">
                          区间
                        </th>
                        <th scope="col">可见性</th>
                        <th scope="col">层级</th>
                        <th scope="col">折叠标记</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view[axis].map((span) => (
                        <tr key={span.range} className="border-t border-border">
                          <th scope="row" className="py-1.5 font-mono font-normal">
                            {span.range}
                          </th>
                          <td>{span.hidden ? "隐藏" : "可见"}</td>
                          <td>{span.level}</td>
                          <td>{span.collapsed ? "有" : "无"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-muted-foreground">无隐藏、分组层级或折叠标记。</p>
                )}
              </section>
            ))}
            <section className="border-t border-border pt-3" aria-label="文件分组设置">
              <h3 className="mb-2 font-medium">文件分组设置</h3>
              <dl className="space-y-1.5">
                {view.settings.map(({ key, value, raw }) => (
                  <div key={key} className="flex flex-wrap justify-between gap-x-3">
                    <dt>{SETTING_LABELS[key]}</dt>
                    <dd className="text-muted-foreground">
                      {value === null
                        ? `未识别（原值：${raw}）`
                        : `${value ? "是" : "否"}（${raw === undefined ? "默认，文件未指定" : "文件指定"}）`}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-muted-foreground">
                以上为工作簿设置，不代表当前界面提供分组符号或分组样式。
              </p>
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">当前没有可读取的工作表。</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
