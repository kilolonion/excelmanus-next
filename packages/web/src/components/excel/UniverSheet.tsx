import { ARRAY_CACHE_RESOURCE, arrayStateMutation } from "@excelmanus/protocol";
import { IResourceManagerService, UniverInstanceType } from "@univerjs/core";
import { FormulaDataModel, LexerTreeBuilder } from "@univerjs/preset-sheets-core";
import { TableManager, UniverSheetsTablePlugin } from "@univerjs/sheets-table";
import { UniverSheetsTableUIPlugin } from "@univerjs/sheets-table-ui";
import tableZhCN from "@univerjs/sheets-table-ui/locale/zh-CN";
import { normalizeEditorTableValues } from "@/lib/workbook/table-values";
import "@univerjs/sheets-table-ui/lib/index.css";
import { CellNoteDialog, type NoteContext } from "./CellNoteDialog";
import { WorkbookObjectsLayer } from "./WorkbookObjectsLayer";
import { WorkbookZoom } from "./WorkbookZoom";
// 表格画布：Univer 1.0.2 实例由活文档快照创建。本端编辑产生的 mutation 经 doc.submit 提交
// （baseRev = 编辑开始时看到的修订），远端修订逐条回放；叠加层显示代理读写、待审批区域与刚提交的改动。

import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-find-replace/lib/index.css";
import "@univerjs/sheets-conditional-formatting-ui/lib/index.css";
import {
  formatRange,
  formulaAwareReorderMutation,
  isDerivedWorkbookMutation,
  parseRange,
  safeSortRangeCommand,
} from "@excelmanus/core";
import {
  axisGroupMutation,
  OBJECT_LAYER_MUTATION,
  sheetObjectsMutation,
  sheetPrintMutation,
  sheetTablesMutation,
  WorkbookObjects,
} from "@excelmanus/protocol";
import {
  CommandType,
  ICommandService,
  IUndoRedoService,
  IUniverInstanceService,
  LifecycleService,
  LifecycleStages,
  type Workbook,
} from "@univerjs/core";
import {
  IRenderManagerService,
  SheetInterceptorService,
  SheetSkeletonManagerService,
  UniverSheetsCorePreset,
} from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { UniverSheetsFindReplacePreset } from "@univerjs/preset-sheets-find-replace";
import findZhCN from "@univerjs/preset-sheets-find-replace/locales/zh-CN";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import { UniverSheetsConditionalFormattingPlugin } from "@univerjs/sheets-conditional-formatting";
import { UniverSheetsConditionalFormattingUIPlugin } from "@univerjs/sheets-conditional-formatting-ui";
import cfZhCN from "@univerjs/sheets-conditional-formatting-ui/locale/zh-CN";
import { UniverSheetsDataValidationPlugin } from "@univerjs/sheets-data-validation";
import { UniverSheetsDataValidationUIPlugin } from "@univerjs/sheets-data-validation-ui";
import dvZhCN from "@univerjs/sheets-data-validation-ui/locale/zh-CN";
import "@univerjs/sheets-data-validation-ui/lib/index.css";
import { UniverSheetsFilterPlugin } from "@univerjs/sheets-filter";
import "@univerjs/sheets-filter/facade";
import { SortRangeCommand, UniverSheetsSortPlugin } from "@univerjs/sheets-sort";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { glassMenuItemClass, glassMenuPanelClass } from "@/components/ui/menu-panel";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import type { ChangeEntry } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { type AskKind, SELECTION_ASKS } from "@/lib/workbook/ask-actions";
import { AXIS_ACTIONS, editSelectionAxis } from "@/lib/workbook/axis-actions";
import {
  CHANGE_HIGHLIGHT_MS,
  changeHighlights,
  createChangeHighlightFrames,
} from "@/lib/workbook/change-highlights";
import { EditTracker } from "@/lib/workbook/edit-session";
import { keepEditingRoom, withEditingRoom } from "@/lib/workbook/editing-room";
import { EditorValidationGate } from "@/lib/workbook/editor-validation-gate";
import { EditorMutationBatch } from "@/lib/workbook/mutation-batch";
import { overlayColor, overlayStyles, rgba } from "@/lib/workbook/overlay-colors";
import { rangeDataCommands } from "@/lib/workbook/range-actions";
import { readRangeDataColumns } from "@/lib/workbook/range-data";
import { isWorkbookFormatShortcut } from "@/lib/workbook/shortcuts";
import { dropEditorThemeColor, jadeTheme } from "@/lib/workbook/univer-theme";
import {
  type DocActivity,
  useDocActivity,
  usePendingOverlay,
} from "@/lib/workbook/use-overlay-data";
import {
  captureView,
  isFreshView,
  loadView,
  restoreView,
  saveView,
} from "@/lib/workbook/view-state";
import {
  noteManualView,
  registerDocumentEditor,
  reloadDocument,
  setDraftConflict,
  setInputDraft,
  setSelection,
  submitDocumentMutations,
  useWorkbookStore,
} from "@/stores/workbook-store";
import { focusGrid, type SheetApi } from "./FormatToolbar";
import { type RangeDataContext, RangeDataDialog } from "./RangeDataDialog";

export interface OverlayVisibility {
  activity: boolean;
  pending: boolean;
  changed: boolean;
}

type Sheet = NonNullable<ReturnType<FWorkbook["getActiveSheet"]>>;
type PopupProps = { popup: { extraProps?: Record<string, unknown> } };

/** 解析区域并按表格当前尺寸截断（写入可能新增行列）；不在当前表或完全越界返回 null。 */
function clampedRange(sheet: Sheet, key: string) {
  const p = parseRange(key);
  if (p.sheet && p.sheet !== sheet.getSheetName()) return null;
  const maxRow = sheet.getMaxRows();
  const maxCol = sheet.getMaxColumns();
  const r0 = p.startRow - 1;
  const c0 = p.startCol - 1;
  if (r0 >= maxRow || c0 >= maxCol) return null;
  const r1 = Math.min(p.endRow - 1, maxRow - 1);
  const c1 = Math.min(p.endCol - 1, maxCol - 1);
  return sheet.getRange(r0, c0, r1 - r0 + 1, c1 - c0 + 1);
}

/** 叠加层用的活动：结束后再保留 1.2 秒，让很快的读取也能被看见。 */
export function useActivityOverlay(): DocActivity[] {
  const live = useDocActivity();
  const [shown, setShown] = useState(live);
  useEffect(() => {
    if (live.length > 0) {
      setShown(live);
      return;
    }
    const t = setTimeout(() => setShown([]), 1200);
    return () => clearTimeout(t);
  }, [live]);
  return shown;
}

/** 叠加层角标：计划修改 · 待确认 / 正在读取 / 正在写入。 */
function OverlayTag({ popup }: PopupProps) {
  const p = popup.extraProps ?? {};
  const kind = String(p.kind);
  return (
    <span
      data-em-overlay=""
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 font-sans text-[11px] font-medium whitespace-nowrap shadow-xs",
        kind === "pending" &&
          "border-dashed border-[var(--em-gold)] bg-[color-mix(in_srgb,var(--em-gold)_14%,var(--background))] text-[color-mix(in_srgb,var(--em-gold)_70%,var(--foreground))]",
        kind === "reading" &&
          "border-dashed border-[var(--em-cyan)] bg-[color-mix(in_srgb,var(--em-cyan)_10%,var(--background))] text-[var(--em-cyan)]",
        kind === "writing" &&
          "border-[var(--em-cyan)] bg-[color-mix(in_srgb,var(--em-cyan)_12%,var(--background))] text-[var(--em-cyan)]",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {String(p.text ?? "")}
    </span>
  );
}

/** 修改前后对比浮层（拟修改，尚未写入）。 */
function OverlayDiff({ popup }: PopupProps) {
  const p = popup.extraProps ?? {};
  return (
    <div
      data-em-overlay=""
      className="flex w-56 flex-col gap-1.5 rounded-xl border border-[var(--em-hairline)] bg-popover p-2.5 font-sans text-xs text-foreground shadow-lg"
      role="note"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground">{String(p.cell ?? "")}</span>
        <span>拟修改</span>
        {Number(p.total) > 1 && <span>（共 {Number(p.total)} 处）</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-[11px] text-muted-foreground">修改前</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground line-through">
          {String(p.before ?? "")}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-[11px] text-muted-foreground">修改后</span>
        <span className="min-w-0 truncate font-mono font-semibold text-[var(--em-primary)]">
          {String(p.after ?? "")}
        </span>
      </div>
    </div>
  );
}

/** 仅开放已支持写回的编辑命令；操作对象始终为当前选区。 */
function SheetContextMenu({
  enabled,
  selectionLabel,
  dataOnly,
  onEdit,
  onAsk,
  onReference,
  children,
}: {
  enabled: boolean;
  selectionLabel: string;
  dataOnly: boolean;
  onEdit: (command: string) => void;
  onAsk: (kind: AskKind) => void;
  onReference: () => void;
  children: ReactNode;
}) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const chosen = useRef(false);
  return (
    <DropdownMenu
      open={point !== null && enabled}
      onOpenChange={(open) => !open && setPoint(null)}
      modal={false}
    >
      <div
        className="absolute inset-0"
        onContextMenuCapture={(event) => {
          if (!enabled) return;
          event.preventDefault();
          event.stopPropagation();
          chosen.current = false;
          setPoint({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (enabled && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setPoint({ x: rect.left + 48, y: rect.top + 48 });
          }
        }}
      >
        {children}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="表格右键菜单"
            tabIndex={-1}
            style={{
              position: "fixed",
              left: point?.x ?? 0,
              top: point?.y ?? 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className={glassMenuPanelClass}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div
            className="max-w-64 truncate px-2.5 pb-1 pt-0.5 text-[11px] text-muted-foreground"
            title={selectionLabel}
          >
            当前选区 {selectionLabel}
          </div>
          {[
            { label: "复制", command: "univer.command.copy" },
            {
              label: dataOnly ? "粘贴（仅值）" : "粘贴",
              command: dataOnly ? "sheet.command.paste-value" : "univer.command.paste",
            },
            ...(!dataOnly ? [{ label: "仅粘贴值", command: "sheet.command.paste-value" }] : []),
            { label: "排序选区…", command: "data.sort" },
            ...(!dataOnly
              ? [
                  { label: "筛选数据…", command: "data.filter" },
                  { label: "批注 / 备注…", command: "note.edit" },
                  { label: "移除筛选", command: "sheet.command.remove-sheet-filter" },
                ]
              : []),
            { label: "撤销上一步", command: "univer.command.undo" },
            { label: "重做上一步", command: "univer.command.redo" },
            { label: "清空选区内容", command: "sheet.command.clear-selection-content" },
          ].map((action) => (
            <DropdownMenuItem
              key={action.command}
              className={glassMenuItemClass}
              onSelect={() => {
                chosen.current = true;
                setPoint(null);
                onEdit(action.command);
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className={glassMenuItemClass}
              disabled={dataOnly}
              title={dataOnly ? "CSV/TSV 的行列操作请先另存为 XLSX" : undefined}
            >
              插入或删除行列
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={glassMenuPanelClass}>
              {AXIS_ACTIONS.map((action) => (
                <DropdownMenuItem
                  key={action.id}
                  className={glassMenuItemClass}
                  onSelect={() => {
                    setPoint(null);
                    onEdit(action.id);
                  }}
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator className="mx-1 my-1.5 bg-[var(--em-hairline)]" />
          <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium tracking-wide text-muted-foreground">
            交给代理
          </div>
          <DropdownMenuItem
            className={glassMenuItemClass}
            onSelect={() => {
              chosen.current = true;
              setPoint(null);
              onReference();
            }}
          >
            添加到对话框
          </DropdownMenuItem>
          <DropdownMenuSeparator className="mx-1 my-1.5 bg-[var(--em-hairline)]" />
          {SELECTION_ASKS.map((action) => (
            <DropdownMenuItem
              key={action.kind}
              className={glassMenuItemClass}
              title={action.title}
              onSelect={() => {
                chosen.current = true;
                setPoint(null);
                onAsk(action.kind);
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  );
}

export function UniverSheet({
  visibility,
  changes,
  onApi,
  onAsk,
  onReference,
}: {
  visibility: OverlayVisibility;
  /** 需要闪烁的近期已提交改动。 */
  changes: ChangeEntry[];
  /** 实例就绪 / 销毁时通知外层（格式工具栏执行命令用）。 */
  onApi: (api: SheetApi | null) => void;
  onAsk: (kind: AskKind) => void;
  onReference: () => void;
}) {
  const doc = useWorkbookStore((s) => s.doc);
  const docId = doc?.docId;
  const snapshot = doc?.snapshot;
  const focus = useWorkbookStore((s) => s.rangeFocus);
  const preview = useWorkbookStore((s) => s.rangePreview);
  const selectionLabel = useWorkbookStore((s) => s.selection?.range ?? "");
  const hasSelection = useWorkbookStore(
    (s) => s.selection !== null && s.selection.docId === s.doc?.docId,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SheetApi | null>(null);
  // 快照重读会重建表格实例；销毁前记下位置，重建后接着看
  const [ready, setReady] = useState(0);
  const [snapshotLoad, setSnapshotLoad] = useState<"loading" | "error" | null>(null);
  // 实例创建时刻：canvas 浮层要等首轮布局完成后才能拿到单元格坐标
  const createdAt = useRef(0);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  // 主题切换后重绘叠加层（颜色取自 token）
  const [themeKey, setThemeKey] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const [noteContext, setNoteContext] = useState<NoteContext | null>(null);
  const [dataContext, setDataContext] = useState<RangeDataContext | null>(null);
  const { ranges: pending, values: pendingValues } = usePendingOverlay();
  const activity = useActivityOverlay();

  // Univer 在原生事件阶段处理快捷键，需要先于其监听器拦截 CSV 格式操作。
  useEffect(() => {
    if (!/\.(csv|tsv)$/i.test(doc?.path ?? "")) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof Node) ||
        !hostRef.current?.contains(event.target) ||
        !isWorkbookFormatShortcut(event)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) toast({ title: "CSV 只保存数据；需要设置格式时，请先另存为 XLSX。" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [doc?.path]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !docId || !snapshot) return;
    const current = useWorkbookStore.getState().doc;
    if (current?.docId === docId && current.snapshotRev < current.rev) {
      // 工作台换了位置（侧栏 ↔ 全屏）或期间有远端修订：先取最新快照再建表
      let alive = true;
      setSnapshotLoad("loading");
      void reloadDocument().catch(() => {
        if (alive) setSnapshotLoad("error");
      });
      return () => {
        alive = false;
      };
    }
    setSnapshotLoad(null);
    const { univer, univerAPI } = createUniver({
      theme: jadeTheme,
      plugins: [
        UniverSheetsConditionalFormattingPlugin,
        UniverSheetsConditionalFormattingUIPlugin,
        UniverSheetsTablePlugin,
        UniverSheetsTableUIPlugin,
        UniverSheetsDataValidationPlugin,
        UniverSheetsDataValidationUIPlugin,
        UniverSheetsFilterPlugin,
        UniverSheetsSortPlugin,
      ],
      locale: LocaleType.ZH_CN,
      locales: { [LocaleType.ZH_CN]: mergeLocales(zhCN, findZhCN, cfZhCN, tableZhCN, dvZhCN) },
      presets: [
        // 公式栏与工作表标签用 Univer 自带的；工具栏与右键菜单不开放（只放写回支持的命令）
        UniverSheetsCorePreset({
          container: host,
          header: true,
          toolbar: false,
          formulaBar: true,
          footer: { sheetBar: true, statisticBar: true, menus: false, zoomSlider: false },
          contextMenu: false,
        }),
        // 查找依赖 Core 中的 UI 服务，必须在 Core 之后注册。
        UniverSheetsFindReplacePreset(),
      ],
    });
    const injector = univer.__getInjector();
    univer
      .__getInjector()
      .get(IResourceManagerService)
      .registerPluginResource({
        pluginName: ARRAY_CACHE_RESOURCE,
        businesses: [UniverInstanceType.UNIVER_SHEET],
        onLoad: (unitId, resource) => {
          const model = univer.__getInjector().get(FormulaDataModel);
          model.setArrayFormulaRange({
            ...model.getArrayFormulaRange(),
            [unitId]: resource.ranges ?? {},
          });
          model.setArrayFormulaCellData({
            ...model.getArrayFormulaCellData(),
            [unitId]: resource.cells ?? {},
          });
        },
        onUnLoad: () => {},
        parseJson: JSON.parse,
        toJson: (unitId) => {
          const model = univer.__getInjector().get(FormulaDataModel);
          return JSON.stringify({
            ranges: model.getArrayFormulaRange()[unitId] ?? {},
            cells: model.getArrayFormulaCellData()[unitId] ?? {},
          });
        },
      });

    const sheetOf = (unitId: string, sheetId: string) =>
      injector.get(IUniverInstanceService).getUnit<Workbook>(unitId)?.getSheetBySheetId(sheetId);
    injector
      .get(ICommandService)
      .registerCommand(sheetObjectsMutation(CommandType.MUTATION, sheetOf));
    injector
      .get(ICommandService)
      .registerCommand(sheetPrintMutation(CommandType.MUTATION, sheetOf));
    injector.get(ICommandService).registerCommand(axisGroupMutation(CommandType.MUTATION, sheetOf));
    injector
      .get(ICommandService)
      .registerCommand(arrayStateMutation(CommandType.MUTATION, sheetOf));
    const getTableManager = () => injector.get(TableManager);
    injector.get(ICommandService).beforeCommandExecuted((command) => {
      if (command.id === "sheet.mutation.set-range-values") {
        const p = command.params as {
          unitId: string;
          subUnitId: string;
          cellValue?: Record<string, Record<string, unknown>>;
        };
        if (p.cellValue)
          normalizeEditorTableValues(p.cellValue, p.subUnitId, p.unitId, getTableManager());
      }

      if (command.id !== "formula.mutation.set-super-table") return;
      const p = command.params as {
        unitId: string;
        tableName: string;
        reference: Record<string, unknown>;
      };
      const tableManager = getTableManager();
      const table = tableManager.getTableList(p.unitId).find((t) => t.name === p.tableName);
      const actual = table && tableManager.getTableById(p.unitId, table.id);
      if (actual)
        Object.assign(p.reference, {
          showHeader: actual.isShowHeader(),
          showFooter: actual.isShowFooter(),
        });
    });
    injector.get(ICommandService).registerCommand(
      sheetTablesMutation(CommandType.MUTATION, (unitId, sheetId, tables) => {
        if (!sheetOf(unitId, sheetId)) return false;
        const tableManager = getTableManager();
        for (const t of tableManager.getTablesBySubunitId(unitId, sheetId))
          tableManager.deleteTable(unitId, t.getId());
        tableManager.fromJSON(unitId, {
          [sheetId]: { tables: tables as never[], tableFilteredOutRows: [] },
        });
        return true;
      }),
    );
    const wb = univerAPI.createWorkbook(withEditingRoom(snapshot));
    const sortCommands = injector.get(ICommandService);
    const sortLexer = new LexerTreeBuilder();
    sortCommands.unregisterCommand("sheet.mutation.reorder-range");
    sortCommands.registerCommand(
      formulaAwareReorderMutation(CommandType.MUTATION, sheetOf, (formula, columns, rows) =>
        sortLexer.moveFormulaRefOffset(formula, columns, rows),
      ),
    );
    sortCommands.unregisterCommand(SortRangeCommand.id);
    sortCommands.registerCommand(safeSortRangeCommand(SortRangeCommand, sheetOf));

    // 工作台编辑与代理共用 doc.submit；服务端负责串行化与冲突判定
    wb.setEditable(true);
    const sheetApi: SheetApi = { univer, univerAPI, wb, rendered: false };
    void injector
      .get(LifecycleService)
      .onStage(LifecycleStages.Rendered)
      .then(() => {
        if (!sheetApi.disposed) sheetApi.rendered = true;
      });
    apiRef.current = sheetApi;
    onApi(sheetApi);
    if (import.meta.env.DEV) (window as { __emUniverAPI?: unknown }).__emUniverAPI = univerAPI;
    const tagSub = univerAPI.registerComponent("em-overlay-tag", OverlayTag as never);
    const diffSub = univerAPI.registerComponent("em-overlay-diff", OverlayDiff as never);
    createdAt.current = Date.now();
    setReady((n) => n + 1);
    // 表格跟随应用主题
    const syncTheme = () => {
      const dark = document.documentElement.classList.contains("dark");
      univerAPI.toggleDarkMode(dark);
      setThemeKey(dark);
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributeFilter: ["class"] });
    const sheetSub = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, () =>
      setActiveSheet(wb.getActiveSheet()?.getSheetName() ?? null),
    );
    // 用户正在编辑单元格时不被跟随打断；同时记下编辑开始时的修订与键入的草稿
    const editing = new EditTracker();
    const editSub = univerAPI.addEvent(univerAPI.Event.SheetEditStarted, (p) => {
      noteManualView();
      editing.start(
        p.worksheet.getSheetId(),
        p.row,
        p.column,
        useWorkbookStore.getState().docSync.rev,
      );
    });
    const changingSub = univerAPI.addEvent(univerAPI.Event.SheetEditChanging, (p) => {
      const text = (p.value as { toPlainText?: () => string } | undefined)?.toPlainText?.();
      if (typeof text === "string") {
        editing.typed(text);
        setInputDraft(docId, editing.currentDraft());
      }
    });
    const editEndSub = univerAPI.addEvent(univerAPI.Event.SheetEditEnded, (p) => {
      editing.end(p.isConfirm);
      if (!p.isConfirm) setInputDraft(docId, null);
    });
    setActiveSheet(wb.getActiveSheet()?.getSheetName() ?? null);
    let applyingRemote = false;
    registerDocumentEditor({
      docId,
      applyRemote: async (mutations, source) => {
        applyingRemote = true;
        try {
          for (const mutation of mutations) {
            const clash = editing.remote(mutation);
            if (clash) setDraftConflict({ docId, ...clash, source });
            const ok = await univerAPI.executeCommand(
              mutation.id,
              keepEditingRoom(wb, mutation.id, mutation.params),
              { fromCollab: true, excelmanusReplay: true },
            );
            if (!ok) throw new Error(`远端修订无法回放：${mutation.id}`);
          }
        } finally {
          applyingRemote = false;
        }
      },
    });
    const view = loadView(docId);
    const rememberView = () => saveView(captureView(docId, wb));
    window.addEventListener("pagehide", rememberView);
    let disposed = false;
    if (isFreshView(view, docId))
      // 滚动控制器要等首轮渲染完成才可用
      void injector
        .get(LifecycleService)
        .onStage(LifecycleStages.Rendered)
        .then(() => {
          // An explicit region request takes priority over the previous tab position.
          if (!disposed && !useWorkbookStore.getState().rangeFocus) restoreView(wb, view);
        })
        .catch((error: unknown) => {
          // Closing a sheet before its first render rejects the lifecycle promise.
          if (!disposed) console.warn("[excelmanus] 无法恢复表格视图", error);
        });
    const localBatch = new EditorMutationBatch((mutations, baseRev) =>
      submitDocumentMutations(docId, mutations, baseRev),
    );
    const validationGate = new EditorValidationGate((mutation, revision) =>
      localBatch.push(mutation, revision),
    );
    const validationBeforeSub = injector
      .get(ICommandService)
      .beforeCommandExecuted((command, options) => {
        if (
          !applyingRemote &&
          !options?.fromCollab &&
          !options?.fromChangeset &&
          (command.params as { unitId?: string } | undefined)?.unitId === wb.getId()
        )
          validationGate.before({ id: command.id, params: command.params });
      });
    const validationSub = validationGate.bindValidation(
      injector.get(SheetInterceptorService),
      () => injector.get(IUndoRedoService).pitchTopUndoElement() ?? undefined,
    );
    const commandSub = wb.onCommandExecuted((command, options) => {
      validationGate.after({ id: command.id, params: command.params });
      if (validationGate.isRollback({ id: command.id, params: command.params })) return;
      // We use the filter model without Univer\u0027s filter UI; update the canvas row layout here.
      if (
        [
          "excelmanus.mutation.set-sheet-tables",
          "sheet.mutation.add-table",
          "sheet.mutation.delete-table",
          "sheet.mutation.set-filter-range",
          "sheet.mutation.set-filter-criteria",
          "sheet.mutation.remove-filter",
          "sheet.mutation.re-calc-filter",
        ].includes(command.id)
      ) {
        const sheetId = (command.params as { subUnitId?: string } | undefined)?.subUnitId;
        if (sheetId)
          queueMicrotask(() => {
            if (disposed) return;
            const render = injector.get(IRenderManagerService).getRenderUnitById(wb.getId());
            const skeleton = render?.with(SheetSkeletonManagerService);
            skeleton?.makeDirty({ sheetId });
            if (sheetId === wb.getActiveSheet()?.getSheetId()) skeleton?.setCurrent({ sheetId });
            render?.mainComponent?.makeDirty();
          });
      }
      if (applyingRemote || options?.fromCollab || options?.fromChangeset) return;
      if (command.type !== CommandType.MUTATION) return;
      if (isDerivedWorkbookMutation(command, options)) return;
      const mutation = dropEditorThemeColor({ id: command.id, params: command.params ?? {} });
      validationGate.push(
        mutation,
        editing.baseRevFor(mutation) ?? useWorkbookStore.getState().docSync.rev,
      );
    });
    // 选区跟随：鼠标、键盘与 activate() 都经 set-selections 操作
    const selectionSub = wb.onCommandExecuted((command) => {
      if (command.id !== "sheet.operation.set-selections") return;
      const sheet = wb.getActiveSheet();
      const sel = sheet?.getSelection()?.getActiveRange()?.getRange();
      if (!sheet || !sel) return;
      setSelection(
        formatRange({
          sheet: sheet.getSheetName(),
          startCol: sel.startColumn + 1,
          startRow: sel.startRow + 1,
          endCol: sel.endColumn + 1,
          endRow: sel.endRow + 1,
        }),
      );
    });
    return () => {
      disposed = true;
      sheetApi.disposed = true;
      rememberView();
      window.removeEventListener("pagehide", rememberView);
      themeObserver.disconnect();
      tagSub.dispose();
      diffSub.dispose();
      commandSub.dispose();
      validationBeforeSub.dispose();
      validationSub();
      validationGate.dispose();
      localBatch.flush();
      sheetSub.dispose();
      editSub.dispose();
      changingSub.dispose();
      editEndSub.dispose();
      selectionSub.dispose();
      registerDocumentEditor(null);
      apiRef.current = null;
      onApi(null);
      univer.dispose();
    };
  }, [docId, snapshot, onApi]);

  // 定位：切到工作表、选中并滚动到区域，短暂高亮
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !focus) return;
    try {
      const parsed = parseRange(focus.range);
      const sheet = parsed.sheet ? wb.getSheetByName(parsed.sheet) : wb.getActiveSheet();
      if (!sheet) return;
      const range = sheet.getRange(
        parsed.startRow - 1,
        parsed.startCol - 1,
        parsed.endRow - parsed.startRow + 1,
        parsed.endCol - parsed.startCol + 1,
      );
      wb.setActiveSheet(sheet);
      range.activate();
      sheet.scrollToCell(parsed.startRow - 1, parsed.startCol - 1);
      const highlight = range.highlight({ fill: rgba("read", 0.14), stroke: rgba("read", 1) });
      const timer = setTimeout(() => highlight.dispose(), 2000);
      return () => {
        clearTimeout(timer);
        highlight.dispose();
      };
    } catch {
      useWorkbookStore.setState({ referenceError: "invalid-range" });
    }
  }, [focus, ready]);

  // 悬停区域引用时的虚线预览
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !preview) return;
    try {
      const parsed = parseRange(preview);
      const sheet = wb.getActiveSheet();
      if (!sheet || (parsed.sheet && sheet.getSheetName() !== parsed.sheet)) return;
      const highlight = sheet
        .getRange(
          parsed.startRow - 1,
          parsed.startCol - 1,
          parsed.endRow - parsed.startRow + 1,
          parsed.endCol - parsed.startCol + 1,
        )
        .highlight({ strokeDash: 4, stroke: rgba("read", 1) });
      return () => highlight.dispose();
    } catch {
      return;
    }
  }, [preview]);

  // 「计划修改」来自待审批记录，批准或拒绝后消失
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    const visiblePending = visibility.pending ? pending : "";
    if (!wb || visiblePending === "") return;
    const sheet = wb.getActiveSheet();
    if (!sheet) return;
    const disposers: { dispose(): void }[] = [];
    const style = overlayStyles().pending;
    for (const key of visiblePending.split("\n")) {
      try {
        const r = clampedRange(sheet, key);
        if (r) disposers.push(r.highlight(style));
      } catch {
        // 引用无法解析时跳过该区域
      }
    }
    // 浮层要等 Univer 首轮布局出单元格坐标后再挂；布局稳定后再重挂一次拿到最终坐标
    let cancelled = false;
    const popups: { dispose(): void }[] = [];
    const values = JSON.parse(pendingValues || "{}") as Record<string, unknown>;
    const firstKey = visiblePending.split("\n")[0] ?? null;
    const attachAll = () => {
      for (const d of popups.splice(0)) d.dispose();
      if (cancelled) return;
      // 文字角标：不只靠颜色区分。数量多时只标前几处，完整列表在审批卡与变更导航
      for (const key of visiblePending.split("\n").slice(0, 3)) {
        try {
          const d = clampedRange(sheet, key)?.attachRangePopup({
            componentKey: "em-overlay-tag",
            direction: "top",
            extraProps: { kind: "pending", text: "计划修改 · 待确认" },
          });
          if (d) popups.push(d);
        } catch {
          // 区域不可见或无法解析时不加角标
        }
      }
      // 修改前后对比：首个待审批区域的首格，原值取自当前表格，新值取自审批参数
      if (firstKey && firstKey in values) {
        try {
          const p = parseRange(firstKey);
          const cellRef = formatRange({
            startCol: p.startCol,
            startRow: p.startRow,
            endCol: p.startCol,
            endRow: p.startRow,
          });
          const cell = clampedRange(sheet, p.sheet ? `${p.sheet}!${cellRef}` : cellRef);
          if (cell) {
            const before = cell.getValue();
            const d = cell.attachPopup({
              componentKey: "em-overlay-diff",
              direction: "right",
              extraProps: {
                cell: cellRef,
                before:
                  before === null || before === undefined || before === ""
                    ? "（空）"
                    : String(before),
                after: String(values[firstKey] ?? ""),
                total: visiblePending.split("\n").length,
              },
            });
            if (d) popups.push(d);
          }
        } catch {
          // 对比浮层失败不影响审批
        }
      }
    };
    const firstDelay = Math.max(60, createdAt.current + 800 - Date.now());
    const attachTimer = setTimeout(attachAll, firstDelay);
    const reattachTimer = setTimeout(attachAll, firstDelay + 700);
    return () => {
      cancelled = true;
      clearTimeout(attachTimer);
      clearTimeout(reattachTimer);
      for (const d of popups) d.dispose();
      for (const d of disposers) d.dispose();
    };
  }, [pending, pendingValues, activeSheet, ready, themeKey, visibility.pending]);

  // 已提交改动的短时边框：计时绑定提交时间，主题/选区/工作表切换不会重新播放旧改动
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const sheet = apiRef.current?.wb.getActiveSheet();
    if (!sheet || !visibility.changed || changes.length === 0) return;
    const marks = changeHighlights(changes, sheet.getSheetName());
    if (marks.length === 0) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const frameFor = createChangeHighlightFrames();
    const painted = new Map<string, { signature: string; dispose(): void }>();
    let timer: ReturnType<typeof setTimeout>;
    const draw = () => {
      const color = overlayColor("ok");
      const now = Date.now();
      let remaining = false;
      let nextDelay = CHANGE_HIGHLIGHT_MS;
      for (const mark of marks) {
        const { age, frame, signature } = frameFor(mark.entry, now, motion.matches);
        const key = `${mark.entry.seq}:${mark.range}`;
        const previous = painted.get(key);
        if (frame.stroke === 0) {
          previous?.dispose();
          painted.delete(key);
          continue;
        }
        remaining = true;
        nextDelay = Math.min(
          nextDelay,
          motion.matches
            ? CHANGE_HIGHLIGHT_MS - age
            : age < 650 || age >= CHANGE_HIGHLIGHT_MS - 900
              ? 40
              : CHANGE_HIGHLIGHT_MS - 900 - age,
        );
        if (previous?.signature === signature) continue;
        previous?.dispose();
        painted.delete(key);
        try {
          const range = clampedRange(sheet, mark.range);
          if (range) {
            const shape = range.highlight({
              fill: color(frame.fill),
              stroke: color(frame.stroke),
              strokeWidth: frame.width,
            });
            painted.set(key, { signature, dispose: () => shape.dispose() });
          }
        } catch {
          // 无法定位时保留导航，不扩展网格
        }
      }
      if (remaining) timer = setTimeout(draw, Math.max(1, nextDelay));
    };
    const onMotionChange = () => {
      clearTimeout(timer);
      draw();
    };
    motion.addEventListener("change", onMotionChange);
    draw();
    return () => {
      clearTimeout(timer);
      motion.removeEventListener("change", onMotionChange);
      for (const shape of painted.values()) shape.dispose();
    };
  }, [changes, activeSheet, ready, themeKey, visibility.changed]);

  // 「正在读取 / 正在写入」：来自 workbook_activity 瞬时增量，结束后淡出
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !visibility.activity || activity.length === 0) return;
    const sheet = wb.getActiveSheet();
    if (!sheet) return;
    const disposers: { dispose(): void }[] = [];
    const styles = overlayStyles();
    let tagged = false;
    for (const a of activity) {
      for (const key of a.ranges) {
        try {
          const r = clampedRange(sheet, key);
          if (!r) continue;
          disposers.push(r.highlight(a.kind === "read" ? styles.reading : styles.writing));
          if (!tagged) {
            const d = r.attachRangePopup({
              componentKey: "em-overlay-tag",
              direction: "top",
              extraProps: { kind: a.kind === "read" ? "reading" : "writing", text: a.label },
            });
            if (d) disposers.push(d);
            tagged = true;
          }
        } catch {
          // 区域不在当前表或无法解析
        }
      }
    }
    return () => {
      for (const d of disposers) d.dispose();
    };
  }, [activity, activeSheet, ready, themeKey, visibility.activity]);

  return (
    <>
      {noteContext && (
        <CellNoteDialog
          context={noteContext}
          onClose={() => setNoteContext(null)}
          onSave={async (text, author) => {
            const api = apiRef.current;
            const current = useWorkbookStore.getState().doc;
            if (
              !api ||
              !current ||
              current.docId !== noteContext.docId ||
              current.rev !== noteContext.revision
            )
              throw new Error("工作簿已更新，请关闭后重新打开批注再修改");
            const objects = WorkbookObjects.parse(
              api.wb.getSheetBySheetId(noteContext.sheetId)?.getSheet().getSnapshot().custom
                ?.excelmanusObjects ?? {
                charts: [],
                images: [],
              },
            );
            objects.notes = (objects.notes ?? []).filter((note) => note.ref !== noteContext.ref);
            if (text !== null) objects.notes.push({ ref: noteContext.ref, text, author });
            if (
              !(await api.univerAPI.executeCommand(OBJECT_LAYER_MUTATION, {
                unitId: api.wb.getId(),
                subUnitId: noteContext.sheetId,
                objects,
              }))
            )
              throw new Error("批注保存未完成");
          }}
        />
      )}
      {dataContext && (
        <RangeDataDialog
          context={dataContext}
          onClose={() => {
            setDataContext(null);
            if (apiRef.current) focusGrid(apiRef.current);
          }}
          onApply={async (action) => {
            const api = apiRef.current;
            if (
              !api ||
              api.wb.getId() !== dataContext.unitId ||
              useWorkbookStore.getState().doc?.rev !== dataContext.revision
            )
              throw new Error("表格已更新，请关闭后重新选择区域");
            const commands = rangeDataCommands(dataContext, action);
            const service = api.univer.__getInjector().get(ICommandService);
            for (const cmd of commands)
              if (!service.syncExecuteCommand(cmd.id, cmd.params))
                throw new Error("操作未完成，请检查选区是否包含合并单元格");
          }}
        />
      )}
      <SheetContextMenu
        enabled={hasSelection && snapshotLoad === null}
        selectionLabel={selectionLabel}
        dataOnly={/\.(csv|tsv)$/i.test(doc?.path ?? "")}
        onEdit={(command) => {
          const api = apiRef.current;
          if (!api) return;
          void (async () => {
            try {
              await api.wb.endEditingAsync(true);
              focusGrid(api);
              if (command === "note.edit") {
                const sheet = api.wb.getActiveSheet();
                const range = sheet?.getSelection()?.getActiveRange()?.getRange();
                if (!sheet || !range || !docId) throw new Error("请先选择一个单元格");
                const ref = sheet.getRange(range.startRow, range.startColumn, 1, 1).getA1Notation();
                const objects = WorkbookObjects.parse(
                  sheet.getSheet().getSnapshot().custom?.excelmanusObjects ?? {
                    charts: [],
                    images: [],
                  },
                );
                const note = objects.notes?.find((note) => note.ref === ref);
                setNoteContext({
                  docId,
                  sheetId: sheet.getSheetId(),
                  ref,
                  text: note?.text ?? "",
                  author: note?.author ?? "",
                  exists: !!note,
                  revision: useWorkbookStore.getState().doc!.rev,
                });
                return;
              }
              if (command === "data.sort" || command === "data.filter") {
                const sheet = api.wb.getActiveSheet();
                if (!sheet) throw new Error("工作表已关闭");
                const ranges = sheet.getSelection()?.getActiveRangeList() ?? [];
                if (ranges.length !== 1) throw new Error("请先选择一个连续区域");
                const filter = command === "data.filter" ? sheet.getFilter() : null;
                const selected = filter?.getRange() ?? ranges[0]!;
                const range = selected.getRange();
                if (range.endRow <= range.startRow)
                  throw new Error("请选择包含表头和明细的区域（至少两行）");
                if (
                  (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) >
                  200000
                )
                  throw new Error("请缩小选区，单次最多处理 20 万格");
                const kind = command === "data.sort" ? "sort" : "filter";
                const columns = readRangeDataColumns(
                  kind,
                  range,
                  (r) =>
                    sheet
                      .getRange(
                        r.startRow,
                        r.startColumn,
                        r.endRow - r.startRow + 1,
                        r.endColumn - r.startColumn + 1,
                      )
                      .getValues(),
                  (index) => filter?.getColumnFilterCriteria(index)?.filters,
                );
                setDataContext({
                  kind,
                  unitId: api.wb.getId(),
                  subUnitId: sheet.getSheetId(),
                  range,
                  label: `${sheet.getSheetName()}!${selected.getA1Notation()}`,
                  hasFilter: !!filter,
                  columns,
                  revision: useWorkbookStore.getState().doc!.rev,
                });
                return;
              }
              const axis = AXIS_ACTIONS.find((action) => action.id === command);
              if (axis) {
                if (/\.(csv|tsv)$/i.test(doc?.path ?? ""))
                  throw new Error("CSV/TSV 的行列操作请先另存为 XLSX");
                const sheet = api.wb.getActiveSheet();
                if (!sheet) throw new Error("工作表已关闭");
                editSelectionAxis(sheet, axis.id);
              } else {
                const params =
                  command === "sheet.command.remove-sheet-filter"
                    ? { unitId: api.wb.getId(), subUnitId: api.wb.getActiveSheet()?.getSheetId() }
                    : undefined;
                const ok = await api.univerAPI.executeCommand(command, params);
                if (!ok) toast({ title: "当前没有可执行的操作", tone: "info" });
              }
            } catch (error) {
              toast({ title: errorMessage(error, "操作未完成，请重试"), tone: "error" });
            } finally {
              focusGrid(api);
            }
          })();
        }}
        onAsk={onAsk}
        onReference={onReference}
      >
        <div className="univer-host absolute inset-0" ref={hostRef} />
        <WorkbookZoom api={apiRef.current} ready={ready} />
        <WorkbookObjectsLayer
          api={apiRef.current}
          host={hostRef.current}
          docId={docId}
          revision={doc?.rev}
          sheetKey={activeSheet}
          ready={ready}
        />
        {snapshotLoad !== null && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-background">
            {snapshotLoad === "error" ? (
              <div
                className="flex flex-col items-center gap-3 text-sm text-muted-foreground"
                role="alert"
              >
                表格内容读取失败
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSnapshotLoad("loading");
                    void reloadDocument().catch(() => setSnapshotLoad("error"));
                  }}
                >
                  重新读取
                </Button>
              </div>
            ) : (
              <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在读取最新内容…
              </span>
            )}
          </div>
        )}
      </SheetContextMenu>
    </>
  );
}
