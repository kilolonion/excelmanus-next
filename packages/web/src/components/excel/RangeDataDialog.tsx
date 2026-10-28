import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { DataAction, DataTarget } from "@/lib/workbook/range-actions";
import { createRangeValueSearch } from "@/lib/workbook/range-data";
export interface RangeDataContext extends DataTarget {
  kind: "sort" | "filter";
  label: string;
  columns: { index: number; label: string; values: string[]; selected?: string[] }[];
  revision: number;
}
export function RangeDataDialog({
  context,
  onClose,
  onApply,
}: {
  context: RangeDataContext;
  onClose: () => void;
  onApply: (action: DataAction) => Promise<void>;
}) {
  const [column, setColumn] = useState(context.range.startColumn);
  const [header, setHeader] = useState(true);
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = context.columns.find((c) => c.index === column)!;
  const selected = picked[column] ?? current.selected ?? current.values;
  const searchValues = useMemo(() => createRangeValueSearch(current.values), [current.values]);
  const visible = useMemo(
    () => (context.kind === "filter" ? searchValues(query) : []),
    [searchValues, query, context.kind],
  );
  const selectedValues = useMemo(
    () => new Set(context.kind === "filter" ? selected : []),
    [selected, context.kind],
  );
  const toggle = (value: string) =>
    setPicked({
      ...picked,
      [column]: selectedValues.has(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    });
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      await onApply(
        context.kind === "sort"
          ? { kind: "sort", column, header, order }
          : { kind: "filter", column, values: selected },
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{context.kind === "sort" ? "排序选区" : "筛选数据"}</DialogTitle>
          <DialogDescription>
            {context.label} ·{" "}
            {context.kind === "sort"
              ? "仅调整选区内的行顺序，请包含需要一起移动的所有列。"
              : "第一行为表头，勾选需要保留的值；其他列的筛选条件保持不变。"}
          </DialogDescription>
        </DialogHeader>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" aria-label="选择数据列">
              {current.label} ▾
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-64 overflow-y-auto">
            {context.columns.map((c) => (
              <DropdownMenuItem
                key={c.index}
                onSelect={() => {
                  setColumn(c.index);
                  setQuery("");
                }}
              >
                {c.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {context.kind === "sort" ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={header} onCheckedChange={(v) => setHeader(v === true)} />
              首行为表头，不参与排序
            </label>
            <div className="flex gap-2">
              <Button
                variant={order === "asc" ? "default" : "outline"}
                onClick={() => setOrder("asc")}
              >
                升序（A → Z）
              </Button>
              <Button
                variant={order === "desc" ? "default" : "outline"}
                onClick={() => setOrder("desc")}
              >
                降序（Z → A）
              </Button>
            </div>
          </>
        ) : (
          <>
            <Input
              aria-label="搜索筛选值"
              placeholder="搜索值"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setPicked({ ...picked, [column]: [...new Set([...selected, ...visible])] })
                }
              >
                全选搜索结果
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const matches = new Set(visible);
                  setPicked({ ...picked, [column]: selected.filter((v) => !matches.has(v)) });
                }}
              >
                取消搜索结果
              </Button>
            </div>
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-3">
              {visible.slice(0, 200).map((v) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={selectedValues.has(v)} onCheckedChange={() => toggle(v)} />
                  <span className="truncate" title={v}>
                    {v || "（空白）"}
                  </span>
                </label>
              ))}
              {visible.length > 200 && (
                <p className="text-xs text-muted-foreground">仅显示前 200 个值，请搜索缩小范围。</p>
              )}
              {!visible.length && <p className="text-sm text-muted-foreground">没有匹配值</p>}
            </div>
            <p className="text-xs text-muted-foreground">
              已选 {selected.length} / {current.values.length} 个值
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => void apply()}
            disabled={busy || (context.kind === "filter" && !selected.length)}
          >
            {busy ? "处理中…" : "应用"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
