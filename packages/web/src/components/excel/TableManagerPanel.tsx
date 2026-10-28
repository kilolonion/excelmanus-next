import {
  indexToCol,
  parseRange,
  rewriteTableReferences,
  type TableReference,
} from "@excelmanus/core";
import { TABLE_STATE_MUTATION } from "@excelmanus/protocol";
import {
  type ICellData,
  type IMutationInfo,
  type IObjectMatrixPrimitiveType,
  Tools,
} from "@univerjs/core";
import { SetRangeValuesMutation } from "@univerjs/sheets";
import { type ITableJson, TableColumnDataTypeEnum, TableManager } from "@univerjs/sheets-table";
import { ChevronDown, LocateFixed, Pencil, Plus, Table2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const styles = ["蓝色", "绿色", "橙色", "青色", "紫色", "红色"];
const address = (t: ITableJson) =>
  `${indexToCol(t.range.startColumn + 1)}${t.range.startRow + 1}:${indexToCol(t.range.endColumn + 1)}${t.range.endRow + 1}`;
export function TableManagerPanel({ api, disabled }: { api: SheetApi | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="表管理"
        title="表管理"
        disabled={disabled || !api}
        onClick={() => setOpen(true)}
      >
        <Table2 className="size-4" />
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
  const manager = api.univer.__getInjector().get(TableManager);
  const [loadedTables, setTables] = useState<ITableJson[] | null>(null),
    [draft, setDraft] = useState<ITableJson | null>(null),
    [range, setRange] = useState(""),
    [columns, setColumns] = useState(""),
    [error, setError] = useState("");
  const tables = loadedTables ?? [];
  useEffect(() => {
    const read = () => setTables(manager.getTablesBySubunitId(unitId, sid).map((t) => t.toJSON()));
    read();
    const refresh = createFrameRefresh(read);
    const sub = api.wb.onCommandExecuted((c) => {
      if (c.id.includes("table")) refresh.schedule();
    });
    return () => {
      refresh.dispose();
      sub.dispose();
    };
  }, [api, manager, sid, unitId]);
  function begin(t?: ITableJson) {
    setError("");
    if (t) {
      setDraft(structuredClone(t));
      setRange(address(t));
      setColumns(t.columns.map((c) => c.displayName).join("\n"));
      return;
    }
    const r = sheet.getSelection()?.getActiveRange()?.getRange() ?? {
      startRow: 0,
      endRow: 2,
      startColumn: 0,
      endColumn: 1,
    };
    const snap = sheet.getSheet().getSnapshot(),
      names = new Set<string>();
    const cols = Array.from({ length: r.endColumn - r.startColumn + 1 }, (_, i) => {
      const v = snap.cellData?.[r.startRow]?.[r.startColumn + i]?.v;
      let displayName = v == null ? `列${i + 1}` : String(v);
      if (!displayName || names.has(displayName.toLowerCase())) displayName = `列${i + 1}`;
      while (names.has(displayName.toLowerCase())) displayName += "_";
      names.add(displayName.toLowerCase());
      return {
        id: crypto.randomUUID(),
        displayName,
        dataType: TableColumnDataTypeEnum.None,
        formula: "",
        meta: {},
        style: {},
      };
    });
    const tableNames = new Set(manager.getTableList(unitId).map((t) => t.name.toLowerCase()));
    let n = 1;
    while (tableNames.has(`table${n}`)) n++;
    const next: ITableJson = {
      id: crypto.randomUUID(),
      name: `Table${n}`,
      range: r,
      columns: cols,
      options: {
        showHeader: true,
        showFooter: false,
        showAutoFilter: true,
        tableStyleId: "table-default-0",
      },
      filters: {},
      meta: {},
    };
    setDraft(next);
    setRange(address(next));
    setColumns(cols.map((c) => c.displayName).join("\n"));
  }
  function reference(t: ITableJson): TableReference {
    return {
      name: t.name,
      sheet: sheet.getSheetName(),
      range: t.range,
      columns: t.columns.map((c) => c.displayName),
      showHeader: t.options.showHeader !== false,
      showFooter: !!t.options.showFooter,
    };
  }
  function apply(next: ITableJson | null, old?: ITableJson) {
    if (api.disposed) throw Error("工作表已重新加载，请关闭面板后重新打开再试");
    const snapshot = sheet.getSheet().getSnapshot(),
      mutations: IMutationInfo[] = [],
      changes: Record<string, IObjectMatrixPrimitiveType<ICellData>> = {};
    const oldReference = old ? reference(old) : null;
    const nextReference = next ? reference(next) : null;
    if (old && oldReference)
      for (const facade of api.wb.getSheets()) {
        const id = facade.getSheetId(),
          s = facade.getSheet().getSnapshot();
        for (const [row, cells] of Object.entries(s.cellData ?? {}))
          for (const [col, cell] of Object.entries(cells as Record<string, ICellData>)) {
            if (!cell?.f) continue;
            const r = Number(row),
              c = Number(col),
              within =
                id === sid &&
                r >= old.range.startRow &&
                r <= old.range.endRow &&
                c >= old.range.startColumn &&
                c <= old.range.endColumn;
            const f = rewriteTableReferences(cell.f, oldReference, nextReference, r, within);
            if (f !== cell.f) {
              changes[id] ??= {};
              changes[id][r] ??= {};
              changes[id][r][c] = { ...Tools.deepClone(cell), f };
            }
          }
      }
    if (next?.options.showHeader !== false && next)
      next.columns.forEach((c, i) => {
        const r = next.range.startRow,
          col = next.range.startColumn + i;
        changes[sid] ??= {};
        changes[sid][r] ??= {};
        changes[sid][r][col] = {
          ...Tools.deepClone(snapshot.cellData?.[r]?.[col] ?? {}),
          v: c.displayName,
          f: null,
          si: null,
          p: null,
          t: 1,
        };
      });
    const updated = tables.filter((t) => t.id !== old?.id);
    if (next) updated.push(next);
    mutations.push({
      id: TABLE_STATE_MUTATION,
      params: { unitId, subUnitId: sid, tables: updated },
    });
    for (const [id, cellValue] of Object.entries(changes))
      mutations.push({
        id: SetRangeValuesMutation.id,
        params: { unitId, subUnitId: id, cellValue, trigger: "excelmanus.table-edit" },
      });
    if (!editTable(api, mutations)) throw Error("表对象修改未成功");
    setDraft(null);
  }
  function save() {
    try {
      if (!draft) return;
      setError("");
      const r = parseRange(range.replaceAll("$", "").trim()),
        names = columns.split("\n").map((s) => s.trim());
      if (
        !/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(draft.name) ||
        draft.name.length > 255 ||
        /^(?:[A-Z]{1,3}\d+|R\d+C\d+|R|C)$/i.test(draft.name)
      )
        throw Error("表名称需以文字或下划线开头，不能是单元格地址");
      if (
        manager
          .getTableList(unitId)
          .some((t) => t.id !== draft.id && t.name.toLowerCase() === draft.name.toLowerCase())
      )
        throw Error("工作簿中已有同名表");
      if (
        names.length !== r.endCol - r.startCol + 1 ||
        names.some((n) => !n || /[[\]#'@]/.test(n)) ||
        new Set(names.map((n) => n.toLowerCase())).size !== names.length
      )
        throw Error("每行填写一个不重复的列名，数量须与范围列数一致；暂不支持特殊引用符号");
      const nr = {
        startRow: r.startRow - 1,
        endRow: r.endRow - 1,
        startColumn: r.startCol - 1,
        endColumn: r.endCol - 1,
      };
      if (
        nr.endRow - nr.startRow + 1 <
        (draft.options.showHeader ? 1 : 0) + (draft.options.showFooter ? 1 : 0) + 1
      )
        throw Error("范围至少需包含一行数据");
      const overlaps = (a: typeof nr) =>
        a.startRow <= nr.endRow &&
        a.endRow >= nr.startRow &&
        a.startColumn <= nr.endColumn &&
        a.endColumn >= nr.startColumn;
      if (tables.some((t) => t.id !== draft.id && overlaps(t.range)))
        throw Error("范围与其他表重叠");
      if (snapMerge().some(overlaps)) throw Error("请先取消范围内的合并单元格");
      const next: ITableJson = {
        ...draft,
        range: nr,
        columns: names.map((displayName, i) => ({
          ...draft.columns[i],
          id: draft.columns[i]?.id ?? crypto.randomUUID(),
          displayName,
          dataType: TableColumnDataTypeEnum.None,
          formula: draft.columns[i]?.formula ?? "",
          meta: draft.columns[i]?.meta ?? {},
          style: draft.columns[i]?.style ?? {},
        })),
      };
      apply(
        next,
        tables.find((t) => t.id === draft.id),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  }
  function snapMerge() {
    return sheet.getSheet().getSnapshot().mergeData ?? [];
  }
  async function convert(t: ITableJson) {
    if (
      !(await confirmAction({
        title: `将“${t.name}”转换为普通区域？`,
        description: "保留单元格数据，将相关结构化引用改为普通区域引用。可撤销恢复。",
        confirmLabel: "转换",
      }))
    )
      return;
    try {
      apply(null, t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "转换失败");
    }
  }
  return (
    <>
      <OverlayCardHeader
        title="表管理"
        description={`${sheet.getSheetName()} · 表对象随工作簿保存，支持结构化引用`}
        icon={<Table2 className="size-5" />}
      />
      <OverlayCardBody className="space-y-4">
        {draft ? (
          <>
            <label className="block space-y-1 text-xs">
              表名称
              <Input
                aria-label="表名称"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="block space-y-1 text-xs">
              范围
              <Input aria-label="表范围" value={range} onChange={(e) => setRange(e.target.value)} />
            </label>
            <label className="block space-y-1 text-xs">
              列名（每行一个）
              <Textarea
                aria-label="表列名"
                rows={4}
                value={columns}
                onChange={(e) => setColumns(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-4">
              {(
                [
                  ["showHeader", "第一行为表头"],
                  ["showFooter", "最后一行为汇总行"],
                  ["showAutoFilter", "显示筛选"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex gap-2 items-center text-xs">
                  <Checkbox
                    checked={!!draft.options[key]}
                    onCheckedChange={(v) =>
                      setDraft({ ...draft, options: { ...draft.options, [key]: v === true } })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              表头使用上述列名；汇总行沿用现有单元格，不自动覆盖。数据引用排除表头和汇总行。
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="表样式">
                  {styles[Number(draft.options.tableStyleId?.replace("table-default-", ""))] ??
                    "默认"}
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup
                  value={draft.options.tableStyleId ?? "table-default-0"}
                  onValueChange={(v) =>
                    setDraft({ ...draft, options: { ...draft.options, tableStyleId: v } })
                  }
                >
                  {styles.map((s, i) => (
                    <DropdownMenuRadioItem key={s} value={`table-default-${i}`}>
                      {s}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>
                取消编辑
              </Button>
              <Button onClick={save}>保存表对象</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">
                {loadedTables === null ? "正在读取表对象…" : `${tables.length} 个表`}
              </span>
              <Button size="sm" disabled={loadedTables === null} onClick={() => begin()}>
                <Plus className="size-4" />
                从选区创建表
              </Button>
            </div>
            {tables.map((t) => (
              <div key={t.id} className="flex gap-2 items-center border rounded-lg p-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{t.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {address(t)} · {t.columns.length} 列
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`定位表 ${t.name}`}
                  onClick={() => {
                    close();
                    sheet.getRange(address(t)).activate();
                  }}
                >
                  <LocateFixed className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`编辑表 ${t.name}`}
                  onClick={() => begin(t)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => void convert(t)}>
                  转为普通区域
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
