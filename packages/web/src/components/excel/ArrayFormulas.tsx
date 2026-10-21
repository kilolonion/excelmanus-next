import { indexToCol, parseRange } from "@excelmanus/core";
import {
  ARRAY_STATE_MUTATION,
  type ArrayFormula,
  effectiveArraysFromSheet,
  fixedArrayCellFormula,
} from "@excelmanus/protocol";
import { type ICellData, type IObjectMatrixPrimitiveType, Tools } from "@univerjs/core";
import { FormulaDataModel } from "@univerjs/preset-sheets-core";
import { SetRangeValuesMutation } from "@univerjs/sheets";
import { Braces, ChevronDown, LocateFixed, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { OverlayCard, OverlayCardBody, OverlayCardHeader } from "@/components/ui/overlay-card";
import { Textarea } from "@/components/ui/textarea";
import { createFrameRefresh } from "@/lib/workbook/frame-refresh";
import { editTable } from "@/lib/workbook/table-edit";
import type { SheetApi } from "./FormatToolbar";

const address = (a: ArrayFormula) =>
  `${indexToCol(a.range.startColumn + 1)}${a.range.startRow + 1}:${indexToCol(a.range.endColumn + 1)}${a.range.endRow + 1}`;
const contains = (a: ArrayFormula, r: number, c: number) =>
  r >= a.range.startRow &&
  r <= a.range.endRow &&
  c >= a.range.startColumn &&
  c <= a.range.endColumn;
export function ArrayFormulas({ api, disabled }: { api: SheetApi | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="数组公式"
        title="数组公式"
        disabled={!api || disabled}
        onClick={() => setOpen(true)}
      >
        <Braces className="size-4" />
      </Button>
      <OverlayCard open={open} onOpenChange={setOpen} size="lg">
        {open && api && <Manager api={api} close={() => setOpen(false)} />}
      </OverlayCard>
    </>
  );
}
function Manager({ api, close }: { api: SheetApi; close: () => void }) {
  const sheet = api.wb.getActiveSheet()!,
    sid = sheet.getSheetId(),
    unitId = api.wb.getId();
  const cells = sheet.getSheet().getSnapshot().cellData;
  const [loadedArrays, setArrays] = useState<ArrayFormula[] | null>(null),
    [draft, setDraft] = useState<ArrayFormula | null>(null),
    [range, setRange] = useState(""),
    [error, setError] = useState("");
  const arrays = loadedArrays ?? [];
  useEffect(() => {
    const model = api.univer.__getInjector().get(FormulaDataModel);
    const read = () =>
      setArrays(
        effectiveArraysFromSheet(
          api.wb.getSheetBySheetId(sid)?.getSheet().getSnapshot(),
          model.getArrayFormulaRange()[unitId]?.[sid] ?? {},
        ),
      );
    read();
    const refresh = createFrameRefresh(read);
    const sub = api.wb.onCommandExecuted((c) => {
      if (c.id.includes("array") || c.id === "sheet.mutation.set-range-values") refresh.schedule();
    });
    return () => {
      refresh.dispose();
      sub.dispose();
    };
  }, [api, sid, unitId]);
  function begin(a?: ArrayFormula) {
    setError("");
    const selection = sheet.getSelection()?.getActiveRange()?.getRange() ?? {
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 0,
    };
    const next = a
      ? structuredClone(a)
      : { id: crypto.randomUUID(), mode: "fixed" as const, formula: "=", range: selection };
    setDraft(next);
    setRange(address(next));
  }
  function apply(next: ArrayFormula | null, old?: ArrayFormula) {
    if (api.disposed) throw Error("工作表已重新加载，请关闭面板后重新打开再试");
    const snapshot = sheet.getSheet().getSnapshot(),
      cells: IObjectMatrixPrimitiveType<ICellData> = {};
    const write = (r: number, c: number, f: string | null) => {
      cells[r] ??= {};
      cells[r][c] = {
        ...Tools.deepClone(snapshot.cellData?.[r]?.[c]),
        f,
        v: null,
        t: null,
        si: null,
        p: null,
      };
    };
    if (old)
      for (let r = old.range.startRow; r <= old.range.endRow; r++)
        for (let c = old.range.startColumn; c <= old.range.endColumn; c++) write(r, c, null);
    if (next) {
      if (next.mode === "dynamic") write(next.range.startRow, next.range.startColumn, next.formula);
      else
        for (let r = next.range.startRow; r <= next.range.endRow; r++)
          for (let c = next.range.startColumn; c <= next.range.endColumn; c++)
            write(r, c, fixedArrayCellFormula(next, r, c));
    }
    const list = arrays.filter((a) => a.id !== old?.id);
    if (next) list.push(next);
    if (
      !editTable(api, [
        { id: ARRAY_STATE_MUTATION, params: { unitId, subUnitId: sid, arrays: list } },
        {
          id: SetRangeValuesMutation.id,
          params: { unitId, subUnitId: sid, cellValue: cells, trigger: "excelmanus.array-edit" },
        },
      ])
    )
      throw Error("数组公式修改失败");
    setDraft(null);
  }
  async function save() {
    try {
      if (!draft) return;
      setError("");
      const r = parseRange(range.replaceAll("$", "").trim()),
        old = arrays.find((a) => a.id === draft.id),
        formula = draft.formula.trim().replace(/^\{(.*)\}$/s, "$1");
      if (!formula.startsWith("=") || formula.length < 2) throw Error("请输入以 = 开头的公式");
      const next: ArrayFormula = {
        ...draft,
        formula,
        range: {
          startRow: r.startRow - 1,
          startColumn: r.startCol - 1,
          endRow: draft.mode === "dynamic" ? r.startRow - 1 : r.endRow - 1,
          endColumn: draft.mode === "dynamic" ? r.startCol - 1 : r.endCol - 1,
        },
      };
      if (
        (next.range.endRow - next.range.startRow + 1) *
          (next.range.endColumn - next.range.startColumn + 1) >
        20000
      )
        throw Error("请将固定数组控制在 20,000 个单元格以内");
      if (
        arrays.some(
          (a) =>
            a.id !== old?.id &&
            a.range.startRow <= next.range.endRow &&
            a.range.endRow >= next.range.startRow &&
            a.range.startColumn <= next.range.endColumn &&
            a.range.endColumn >= next.range.startColumn,
        )
      )
        throw Error("此范围与另一个数组公式重叠");
      const s = sheet.getSheet().getSnapshot();
      if (
        (s.mergeData ?? []).some(
          (a) =>
            a.startRow <= next.range.endRow &&
            a.endRow >= next.range.startRow &&
            a.startColumn <= next.range.endColumn &&
            a.endColumn >= next.range.startColumn,
        )
      )
        throw Error("请先取消数组范围内的合并单元格");
      let occupied = false;
      for (let row = next.range.startRow; row <= next.range.endRow; row++)
        for (let col = next.range.startColumn; col <= next.range.endColumn; col++) {
          if (old && contains(old, row, col)) continue;
          const v = s.cellData?.[row]?.[col];
          if (v?.f || (v?.v != null && v.v !== "")) occupied = true;
        }
      if (
        occupied &&
        !(await confirmAction({
          title: "替换选区已有内容？",
          description: "数组公式将替换目标区域中的单元格内容，可通过撤销恢复。",
          confirmLabel: "替换",
        }))
      )
        return;
      apply(next, old);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  }
  async function clear(a: ArrayFormula) {
    if (
      !(await confirmAction({
        title: "清除整个数组公式？",
        description: `将清除 ${address(a)} 的公式和结果，保留格式，可撤销恢复。`,
        confirmLabel: "清除数组",
        tone: "danger",
      }))
    )
      return;
    try {
      apply(null, a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "清除失败");
    }
  }
  return (
    <>
      <OverlayCardHeader
        title="数组公式"
        description={`${sheet.getSheetName()} · 固定数组整块编辑，动态数组从左上角自动溢出`}
        icon={<Braces className="size-5" />}
      />
      <OverlayCardBody className="space-y-4">
        {draft ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="数组模式">
                  {draft.mode === "fixed" ? "固定区域数组" : "动态溢出数组"}
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup
                  value={draft.mode}
                  onValueChange={(mode) =>
                    setDraft({ ...draft, mode: mode as ArrayFormula["mode"] })
                  }
                >
                  <DropdownMenuRadioItem value="fixed">固定区域数组</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dynamic">动态溢出数组</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <label className="block text-xs space-y-1">
              {draft.mode === "fixed" ? "输出范围" : "起始单元格（使用输入范围的左上角）"}
              <Input
                aria-label="数组范围"
                value={range}
                onChange={(e) => setRange(e.target.value)}
              />
            </label>
            <label className="block text-xs space-y-1">
              公式
              <Textarea
                aria-label="数组表达式"
                rows={3}
                value={draft.formula}
                onChange={(e) => setDraft({ ...draft, formula: e.target.value })}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {draft.mode === "fixed"
                ? "统一修改整个数组，不能单独改动结果格。"
                : "结果区域由公式决定；有内容或合并单元格阻挡时显示 #SPILL!，不会覆盖已有内容。"}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>
                取消编辑
              </Button>
              <Button onClick={() => void save()}>保存数组公式</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">
                {loadedArrays === null ? "正在读取数组…" : `${arrays.length} 个数组`}
              </span>
              <Button size="sm" disabled={loadedArrays === null} onClick={() => begin()}>
                <Plus className="size-4" />
                新增数组
              </Button>
            </div>
            {arrays.map((a) => (
              <div key={a.id} className="flex gap-2 items-center border rounded-lg p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {address(a)} · {a.mode === "fixed" ? "固定区域" : "动态溢出"}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={a.formula}>
                    {a.formula}
                  </p>
                  {cells?.[a.range.startRow]?.[a.range.startColumn]?.v === "#SPILL!" && (
                    <p className="text-xs text-destructive">
                      溢出被阻挡，请清空结果区域的已有内容或取消合并。
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`定位数组 ${address(a)}`}
                  onClick={() => {
                    close();
                    sheet.getRange(address(a)).activate();
                  }}
                >
                  <LocateFixed className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`编辑数组 ${address(a)}`}
                  onClick={() => begin(a)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`清除数组 ${address(a)}`}
                  onClick={() => void clear(a)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex justify-end">
              <Button variant="outline" onClick={close}>
                完成
              </Button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </OverlayCardBody>
    </>
  );
}
