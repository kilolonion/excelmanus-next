import { ArrayFormulas } from "./ArrayFormulas";
// 「开始」功能区：只放写回支持的格式项。每个按钮执行 Univer 自带命令，产生的 mutation
// 与单元格编辑一样经 doc.submit 走同一写入路径；CSV 只保存值，因此只保留撤销 / 重做。

import {
  BorderStyleTypes,
  BorderType,
  HorizontalAlign,
  type IStyleData,
  type Univer,
  VerticalAlign,
  WrapStrategy,
} from "@univerjs/core";
import { ILayoutService } from "@univerjs/preset-sheets-core";
import { OpenFindDialogOperation } from "@univerjs/preset-sheets-find-replace";
import type { FUniver } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import {
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Bold,
  ChevronDown,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Ellipsis,
  Grid2x2,
  Info,
  Italic,
  JapaneseYen,
  type LucideIcon,
  PaintBucket,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Percent,
  Plus,
  Redo2,
  RemoveFormatting,
  Search,
  Square,
  SquareDashed,
  Strikethrough,
  TableCellsMerge,
  TableCellsSplit,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";
import {
  Fragment,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { askAgent } from "@/lib/workbook/ask";
import { borderValue } from "@/lib/workbook/border-options";
import { ConditionalFormats } from "./ConditionalFormats";
import { DefinedNames } from "./DefinedNames";
import { FormatPainter } from "./FormatPainter";
import { TableManagerPanel } from "./TableManagerPanel";

export type SheetApi = {
  univer: Univer;
  univerAPI: FUniver;
  wb: FWorkbook;
  disposed?: boolean;
  rendered?: boolean;
};

type FormatState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontFamily: string | null;
  fontSize: number | null;
  textColor: string | null;
  fill: string | null;
  ht: HorizontalAlign | null;
  vt: VerticalAlign | null;
  wrap: boolean;
  pattern: string | null;
  merged: boolean;
  single: boolean;
};

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl+";

const FONTS = [
  "Microsoft YaHei",
  "PingFang SC",
  "SimSun",
  "SimHei",
  "KaiTi",
  "DengXian",
  "Arial",
  "Calibri",
  "Times New Roman",
  "Courier New",
];
const FONT_NAMES: Record<string, string> = {
  "Microsoft YaHei": "微软雅黑",
  "PingFang SC": "苹方",
  SimSun: "宋体",
  SimHei: "黑体",
  KaiTi: "楷体",
  DengXian: "等线",
};
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const DEFAULT_SIZE = 11;

const FORMATS = [
  { label: "常规", pattern: "", sample: "1234.5" },
  { label: "数字", pattern: "#,##0.00", sample: "1,234.50" },
  { label: "整数", pattern: "#,##0", sample: "1,235" },
  { label: "百分比", pattern: "0.00%", sample: "12.35%" },
  { label: "货币", pattern: "¥#,##0.00", sample: "¥1,234.50" },
  { label: "科学计数", pattern: "0.00E+00", sample: "1.23E+03" },
  { label: "日期", pattern: "yyyy-mm-dd", sample: "2026-10-11" },
  { label: "日期时间", pattern: "yyyy-mm-dd hh:mm", sample: "2026-10-11 13:45" },
  { label: "时间", pattern: "hh:mm:ss", sample: "13:45:00" },
  { label: "文本", pattern: "@", sample: "007" },
] as const;

/** 服务端单次提交 20 万格上限；数字格式按格提交，留出余量。 */
const MAX_FORMAT_CELLS = 100_000;

const PALETTE = [
  ["#000000", "#3F3F46", "#71717A", "#A1A1AA", "#D4D4D8", "#E4E4E7", "#F4F4F5", "#FFFFFF"],
  ["#991B1B", "#9A3412", "#854D0E", "#166534", "#115E59", "#1E40AF", "#5B21B6", "#9D174D"],
  ["#DC2626", "#EA580C", "#CA8A04", "#16A34A", "#0D9488", "#2563EB", "#7C3AED", "#DB2777"],
  ["#F87171", "#FB923C", "#FACC15", "#4ADE80", "#2DD4BF", "#60A5FA", "#A78BFA", "#F472B6"],
  ["#FEE2E2", "#FFEDD5", "#FEF9C3", "#DCFCE7", "#CCFBF1", "#DBEAFE", "#EDE9FE", "#FCE7F3"],
];

const ALIGNS: { value: HorizontalAlign; icon: LucideIcon; label: string }[] = [
  { value: HorizontalAlign.LEFT, icon: TextAlignStart, label: "左对齐" },
  { value: HorizontalAlign.CENTER, icon: TextAlignCenter, label: "居中" },
  { value: HorizontalAlign.RIGHT, icon: TextAlignEnd, label: "右对齐" },
];
const VALIGNS: { value: VerticalAlign; icon: LucideIcon; label: string }[] = [
  { value: VerticalAlign.TOP, icon: AlignVerticalJustifyStart, label: "顶端对齐" },
  { value: VerticalAlign.MIDDLE, icon: AlignVerticalJustifyCenter, label: "垂直居中" },
  { value: VerticalAlign.BOTTOM, icon: AlignVerticalJustifyEnd, label: "底端对齐" },
];
const BORDERS: { type: BorderType; icon: LucideIcon; label: string }[] = [
  { type: BorderType.ALL, icon: Grid2x2, label: "所有框线" },
  { type: BorderType.OUTSIDE, icon: Square, label: "外框线" },
  { type: BorderType.INSIDE, icon: Plus, label: "内框线" },
  { type: BorderType.TOP, icon: PanelTop, label: "上框线" },
  { type: BorderType.BOTTOM, icon: PanelBottom, label: "下框线" },
  { type: BorderType.LEFT, icon: PanelLeft, label: "左框线" },
  { type: BorderType.RIGHT, icon: PanelRight, label: "右框线" },
  { type: BorderType.NONE, icon: SquareDashed, label: "无框线" },
];

function readFormat(wb: FWorkbook): FormatState | null {
  const range = wb.getActiveSheet()?.getSelection()?.getActiveRange();
  if (!range) return null;
  const s: IStyleData = range.getCellStyleData() ?? {};
  const r = range.getRange();
  return {
    bold: s.bl === 1,
    italic: s.it === 1,
    underline: s.ul?.s === 1,
    strike: s.st?.s === 1,
    fontFamily: s.ff ?? null,
    fontSize: s.fs ?? null,
    textColor: s.cl?.rgb ?? null,
    fill: s.bg?.rgb ?? null,
    ht: s.ht ?? null,
    vt: s.vt ?? null,
    wrap: s.tb === WrapStrategy.WRAP,
    pattern: s.n?.pattern ?? null,
    merged: range.isPartOfMerge(),
    single: r.startRow === r.endRow && r.startColumn === r.endColumn,
  };
}

/** 选区或样式变化时重读活动单元格格式；每帧最多一次，内容不变不重绘。 */
function useFormatState(api: SheetApi | null): FormatState | null {
  const [state, setState] = useState<FormatState | null>(null);
  useEffect(() => {
    if (!api) {
      setState(null);
      return;
    }
    let frame = 0;
    let last = "";
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = readFormat(api.wb);
        const key = JSON.stringify(next);
        if (key === last) return;
        last = key;
        setState(next);
      });
    };
    update();
    const sub = api.wb.onCommandExecuted((command) => {
      // Scrolling changes the viewport, not the selected cell's format.
      if (command.id !== "sheet.operation.set-scroll") update();
    });
    return () => {
      cancelAnimationFrame(frame);
      sub.dispose();
    };
  }, [api]);
  return state;
}

export function focusGrid(api: SheetApi): void {
  try {
    api.univer.__getInjector().get(ILayoutService).focus();
  } catch {
    // 实例已销毁时无需恢复焦点
  }
}

/** 先结束单元格编辑：编辑中直接加格式会变成单元格内富文本，写回不支持。 */
async function exec(api: SheetApi, id: string, params?: object) {
  try {
    await api.wb.endEditingAsync(true);
    await api.univerAPI.executeCommand(id, params);
  } catch {
    // 命令失败由 Univer 记录；工具栏保持可用
  }
  focusGrid(api);
}

function applyPattern(api: SheetApi, pattern: string) {
  const sheet = api.wb.getActiveSheet();
  if (!sheet) return;
  const maxRow = sheet.getMaxRows() - 1;
  const maxCol = sheet.getMaxColumns() - 1;
  const values: { row: number; col: number; pattern: string }[] = [];
  for (const range of sheet.getSelection()?.getActiveRangeList() ?? []) {
    const r = range.getRange();
    for (let row = r.startRow; row <= Math.min(r.endRow, maxRow); row++)
      for (let col = r.startColumn; col <= Math.min(r.endColumn, maxCol); col++) {
        if (values.length >= MAX_FORMAT_CELLS) {
          toast({ tone: "error", title: "选区太大，请缩小范围后再设置数字格式" });
          return;
        }
        values.push({ row, col, pattern });
      }
  }
  if (values.length > 0) void exec(api, "sheet.command.numfmt.set.numfmt", { values });
}

/** 按下时不抢焦点，让键盘输入继续留在表格里。 */
const keepGridFocus = (e: MouseEvent) => e.preventDefault();

const toolCls =
  "size-7 rounded-md px-0 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10 aria-pressed:bg-[var(--em-primary-alpha-12)] aria-pressed:text-[var(--em-primary)]";

function Tip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="text-xs">
        {label}
        {shortcut ? (
          <span className="ml-1.5 opacity-60">
            {MOD}
            {shortcut}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function ToolButton({
  label,
  icon: Icon,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const btn = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={cn(toolCls, className)}
      onMouseDown={keepGridFocus}
      onClick={onClick}
    >
      {children ?? (Icon && <Icon className="size-4" />)}
    </Button>
  );
  if (disabled) return btn;
  return (
    <Tip label={label} shortcut={shortcut}>
      {btn}
    </Tip>
  );
}

/** 下拉触发按钮：显示当前值 + 小箭头。 */
function MenuTrigger({
  label,
  disabled,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <Button
        variant="ghost"
        size="xs"
        aria-label={label}
        title={label}
        onMouseDown={keepGridFocus}
        className={cn(
          "h-7 gap-1 rounded-md px-1.5 text-xs font-normal text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10 data-[state=open]:bg-[var(--em-primary-alpha-10)] data-[state=open]:text-foreground",
          className,
        )}
      >
        {children}
        <ChevronDown className="size-3 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border/80" />;
}

function ColorControl({
  api,
  kind,
  current,
  disabled,
}: {
  api: SheetApi | null;
  kind: "text" | "fill";
  current: string | null;
  disabled: boolean;
}) {
  const [color, setColor] = useState(kind === "text" ? "#DC2626" : "#FEF9C3");
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const label = kind === "text" ? "文字颜色" : "填充颜色";
  const apply = (value: string | null) => {
    if (!api) return;
    setOpen(false);
    if (value === null) {
      void exec(
        api,
        kind === "text" ? "sheet.command.reset-text-color" : "sheet.command.reset-background-color",
      );
      return;
    }
    setColor(value);
    void exec(
      api,
      kind === "text" ? "sheet.command.set-range-text-color" : "sheet.command.set-background-color",
      { value },
    );
  };
  const submitCustom = () => {
    const hex = custom.trim().replace(/^#?/, "#");
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      apply(hex.toUpperCase());
      setCustom("");
    }
  };
  const selected = current?.toUpperCase() ?? null;
  return (
    <span className="flex shrink-0 items-center">
      <ToolButton
        label={label}
        disabled={disabled}
        onClick={() => api && apply(color)}
        className="w-7 rounded-r-none"
      >
        <span className="flex flex-col items-center gap-[3px]">
          {kind === "text" ? (
            <span className="font-sans text-[13px] leading-none font-semibold">A</span>
          ) : (
            <PaintBucket className="size-3.5" />
          )}
          <span
            className="h-[3px] w-4 rounded-full ring-1 ring-black/10 ring-inset"
            style={{ backgroundColor: color }}
          />
        </span>
      </ToolButton>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild disabled={disabled}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`选择${label}`}
            className="h-7 w-3.5 rounded-l-none px-0 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 data-[state=open]:bg-[var(--em-primary-alpha-10)]"
            onMouseDown={keepGridFocus}
          >
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[244px] p-3"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (api) focusGrid(api);
          }}
        >
          <Button
            variant="ghost"
            size="xs"
            className="mb-2 h-7 w-full justify-start gap-2 px-2 text-xs"
            onClick={() => apply(null)}
          >
            <span
              className={cn(
                "size-4 rounded-sm border border-border",
                kind === "fill" &&
                  "bg-[linear-gradient(to_top_right,transparent_calc(50%-0.75px),var(--destructive)_calc(50%-0.75px),var(--destructive)_calc(50%+0.75px),transparent_calc(50%+0.75px))]",
                kind === "text" && "bg-foreground",
              )}
            />
            {kind === "text" ? "默认颜色" : "无填充"}
          </Button>
          <div className="grid grid-cols-8 gap-1.5">
            {PALETTE.flat().map((value) => (
              <button
                key={value}
                type="button"
                aria-label={value}
                aria-pressed={selected === value}
                className="size-6 rounded-md p-0 ring-offset-1 ring-offset-popover transition-transform hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-[var(--em-primary)]"
                onClick={() => apply(value)}
              >
                <span
                  className="block size-full rounded-[5px] ring-1 ring-black/10 ring-inset"
                  style={{ backgroundColor: value }}
                />
              </button>
            ))}
          </div>
          <form
            className="mt-3 flex items-center gap-2 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitCustom();
            }}
          >
            <span
              className="size-7 shrink-0 rounded-md ring-1 ring-black/10 ring-inset"
              style={{
                backgroundColor: /^#?[0-9a-f]{6}$/i.test(custom.trim())
                  ? custom.trim().replace(/^#?/, "#")
                  : "transparent",
              }}
            />
            <Input
              value={custom}
              placeholder="#1A7F5A"
              aria-label="自定义颜色（十六进制）"
              className="h-8 font-mono text-xs"
              onChange={(e) => setCustom(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" className="h-8 px-2.5">
              应用
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </span>
  );
}

type Ctx = {
  api: SheetApi | null;
  f: FormatState | null;
  off: boolean;
  run: (id: string, params?: object) => void;
  closeToGrid: (e: Event) => void;
};

type GroupKey = "history" | "font" | "style" | "colors" | "align" | "number" | "cells" | "clear";

/** 从左到右的优先顺序；宽度不够时从末尾开始收进「更多」。 */
const ORDER: GroupKey[] = [
  "history",
  "font",
  "style",
  "colors",
  "align",
  "number",
  "cells",
  "clear",
];
/** 各组实测宽度，用于在渲染前决定能放下几组。 */
const GROUP_WIDTH: Record<GroupKey, number> = {
  history: 58,
  font: 170,
  style: 118,
  colors: 86,
  align: 120,
  number: 167,
  cells: 74,
  clear: 28,
};
const GROUP_GAP = 13;
const MORE_WIDTH = 28;

function HistoryGroup({ api, run }: Ctx) {
  return (
    <>
      <ToolButton
        label="撤销"
        icon={Undo2}
        shortcut="Z"
        disabled={!api}
        onClick={() => run("univer.command.undo")}
      />
      <ToolButton
        label="重做"
        icon={Redo2}
        shortcut={isMac ? "⇧Z" : "Y"}
        disabled={!api}
        onClick={() => run("univer.command.redo")}
      />
    </>
  );
}

function FontGroup({ f, off, run, closeToGrid }: Ctx) {
  const fontLabel = f?.fontFamily ? (FONT_NAMES[f.fontFamily] ?? f.fontFamily) : "默认字体";
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label="字体" disabled={off} className="w-[7.5rem] justify-between">
          <span className="truncate">{fontLabel}</span>
        </MenuTrigger>
        <DropdownMenuContent align="start" className="w-52" onCloseAutoFocus={closeToGrid}>
          <DropdownMenuRadioGroup
            value={f?.fontFamily ?? ""}
            onValueChange={(value) => run("sheet.command.set-range-font-family", { value })}
          >
            {FONTS.map((font) => (
              <DropdownMenuRadioItem key={font} value={font}>
                <span style={{ fontFamily: font }}>{FONT_NAMES[font] ?? font}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <MenuTrigger label="字号" disabled={off} className="w-12 justify-between">
          <span className="font-mono tabular-nums">{f?.fontSize ?? DEFAULT_SIZE}</span>
        </MenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-20 min-w-0"
          onCloseAutoFocus={closeToGrid}
        >
          <DropdownMenuRadioGroup
            value={String(f?.fontSize ?? DEFAULT_SIZE)}
            onValueChange={(value) =>
              run("sheet.command.set-range-fontsize", { value: Number(value) })
            }
          >
            {SIZES.map((size) => (
              <DropdownMenuRadioItem key={size} value={String(size)} className="font-mono">
                {size}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function StyleGroup({ f, off, run }: Ctx) {
  return (
    <>
      <ToolButton
        label="加粗"
        icon={Bold}
        shortcut="B"
        pressed={f?.bold}
        disabled={off}
        onClick={() => run("sheet.command.set-range-bold")}
      />
      <ToolButton
        label="斜体"
        icon={Italic}
        shortcut="I"
        pressed={f?.italic}
        disabled={off}
        onClick={() => run("sheet.command.set-range-italic")}
      />
      <ToolButton
        label="下划线"
        icon={Underline}
        shortcut="U"
        pressed={f?.underline}
        disabled={off}
        onClick={() => run("sheet.command.set-range-underline")}
      />
      <ToolButton
        label="删除线"
        icon={Strikethrough}
        pressed={f?.strike}
        disabled={off}
        onClick={() => run("sheet.command.set-range-stroke")}
      />
    </>
  );
}

function ColorsGroup({ api, f, off }: Ctx) {
  return (
    <>
      <ColorControl api={api} kind="text" current={f?.textColor ?? null} disabled={off} />
      <ColorControl api={api} kind="fill" current={f?.fill ?? null} disabled={off} />
    </>
  );
}

function AlignGroup({ f, off, run, closeToGrid }: Ctx) {
  const AlignIcon = ALIGNS.find((a) => a.value === f?.ht)?.icon ?? TextAlignStart;
  const ValignIcon = VALIGNS.find((a) => a.value === f?.vt)?.icon ?? AlignVerticalJustifyEnd;
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label="水平对齐" disabled={off}>
          <AlignIcon className="size-4" />
        </MenuTrigger>
        <DropdownMenuContent align="start" className="w-40" onCloseAutoFocus={closeToGrid}>
          <DropdownMenuRadioGroup
            value={String(f?.ht ?? "")}
            onValueChange={(value) =>
              run("sheet.command.set-horizontal-text-align", { value: Number(value) })
            }
          >
            {ALIGNS.map((a) => (
              <DropdownMenuRadioItem key={a.value} value={String(a.value)}>
                <a.icon className="size-4" />
                {a.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <MenuTrigger label="垂直对齐" disabled={off}>
          <ValignIcon className="size-4" />
        </MenuTrigger>
        <DropdownMenuContent align="start" className="w-40" onCloseAutoFocus={closeToGrid}>
          <DropdownMenuRadioGroup
            value={String(f?.vt ?? "")}
            onValueChange={(value) =>
              run("sheet.command.set-vertical-text-align", { value: Number(value) })
            }
          >
            {VALIGNS.map((a) => (
              <DropdownMenuRadioItem key={a.value} value={String(a.value)}>
                <a.icon className="size-4" />
                {a.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolButton
        label="自动换行"
        icon={WrapText}
        pressed={f?.wrap}
        disabled={off}
        onClick={() =>
          run("sheet.command.set-text-wrap", {
            value: f?.wrap ? WrapStrategy.OVERFLOW : WrapStrategy.WRAP,
          })
        }
      />
    </>
  );
}

function NumberGroup({ api, f, off, run, closeToGrid }: Ctx) {
  return (
    <>
      <ToolButton
        label="货币格式"
        icon={JapaneseYen}
        disabled={off}
        onClick={() => api && applyPattern(api, "¥#,##0.00")}
      />
      <ToolButton
        label="百分比格式"
        icon={Percent}
        disabled={off}
        onClick={() => api && applyPattern(api, "0.00%")}
      />
      <ToolButton
        label="减少小数位数"
        icon={DecimalsArrowLeft}
        disabled={off}
        onClick={() => run("sheet.command.numfmt.subtract.decimal.command")}
      />
      <ToolButton
        label="增加小数位数"
        icon={DecimalsArrowRight}
        disabled={off}
        onClick={() => run("sheet.command.numfmt.add.decimal.command")}
      />
      <DropdownMenu>
        <MenuTrigger label="数字格式" disabled={off}>
          <span className="font-mono text-[11px] font-medium tracking-tight">123</span>
        </MenuTrigger>
        <DropdownMenuContent align="start" className="w-60" onCloseAutoFocus={closeToGrid}>
          <DropdownMenuRadioGroup
            value={f?.pattern ?? ""}
            onValueChange={(pattern) => api && applyPattern(api, pattern)}
          >
            {FORMATS.map((item) => (
              <DropdownMenuRadioItem key={item.label} value={item.pattern}>
                <span className="flex w-full items-center justify-between gap-4">
                  {item.label}
                  <span className="font-mono text-[10px] text-muted-foreground">{item.sample}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

const BORDER_LINES = [
  [BorderStyleTypes.THIN, "细实线"],
  [BorderStyleTypes.MEDIUM, "中实线"],
  [BorderStyleTypes.THICK, "粗实线"],
  [BorderStyleTypes.HAIR, "发丝线"],
  [BorderStyleTypes.DOTTED, "点线"],
  [BorderStyleTypes.DASHED, "虚线"],
  [BorderStyleTypes.DASH_DOT, "点划线"],
  [BorderStyleTypes.DASH_DOT_DOT, "双点划线"],
  [BorderStyleTypes.DOUBLE, "双线"],
  [BorderStyleTypes.MEDIUM_DASHED, "中虚线"],
  [BorderStyleTypes.MEDIUM_DASH_DOT, "中点划线"],
  [BorderStyleTypes.MEDIUM_DASH_DOT_DOT, "中双点划线"],
  [BorderStyleTypes.SLANT_DASH_DOT, "斜点划线"],
] as const;
function CellsGroup({ f, off, run, closeToGrid }: Ctx) {
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState<BorderStyleTypes>(BorderStyleTypes.THIN);
  const [color, setColor] = useState("#000000");
  const applyBorder = (type: BorderType) => {
    const value = borderValue(type, line, color);
    if (!value) {
      toast({ tone: "error", title: "请输入 3 位或 6 位十六进制颜色" });
      return;
    }
    setOpen(false);
    run("sheet.command.set-border-basic", { value });
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="边框"
            disabled={off}
            onMouseDown={keepGridFocus}
          >
            <Grid2x2 className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-3" onCloseAutoFocus={closeToGrid}>
          <p className="mb-2 text-xs text-muted-foreground">先选线型和颜色，再选择边框位置</p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="mb-3 w-full justify-between"
                aria-label="边框线型"
              >
                {BORDER_LINES.find(([value]) => value === line)?.[1]}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-64" align="start">
              <DropdownMenuRadioGroup
                value={String(line)}
                onValueChange={(v) => setLine(Number(v) as BorderStyleTypes)}
              >
                {BORDER_LINES.map(([value, label]) => (
                  <DropdownMenuRadioItem key={value} value={String(value)}>
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="mb-2 grid grid-cols-8 gap-1.5">
            {PALETTE.flat().map((value) => (
              <Button
                key={value}
                variant="ghost"
                size="icon-xs"
                className="size-5 rounded border p-0"
                aria-label={`边框颜色 ${value}`}
                aria-pressed={color.toUpperCase() === value}
                style={{ backgroundColor: value }}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
          <Input
            aria-label="自定义边框颜色"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="#000000"
            className="mb-3 h-8 font-mono text-xs"
          />
          <div className="grid grid-cols-2 gap-1 border-t pt-2">
            {BORDERS.map((b) => (
              <Button
                key={b.type}
                variant="ghost"
                size="sm"
                className="justify-start gap-2 text-xs"
                onClick={() => applyBorder(b.type)}
              >
                <b.icon className="size-4" />
                {b.label}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <ToolButton
        label={f?.merged ? "取消合并" : "合并单元格"}
        icon={f?.merged ? TableCellsSplit : TableCellsMerge}
        pressed={f?.merged}
        disabled={off || (f?.single && !f.merged)}
        onClick={() =>
          run(
            f?.merged
              ? "sheet.command.remove-worksheet-merge"
              : "sheet.command.add-worksheet-merge-all",
          )
        }
      />
    </>
  );
}

function ClearGroup({ off, run }: Ctx) {
  return (
    <ToolButton
      label="清除格式"
      icon={RemoveFormatting}
      disabled={off}
      onClick={() => run("sheet.command.clear-selection-format")}
    />
  );
}

const GROUPS: Record<GroupKey, (ctx: Ctx) => ReactNode> = {
  history: HistoryGroup,
  font: FontGroup,
  style: StyleGroup,
  colors: ColorsGroup,
  align: AlignGroup,
  number: NumberGroup,
  cells: CellsGroup,
  clear: ClearGroup,
};

function Groups({ keys, ctx }: { keys: GroupKey[]; ctx: Ctx }) {
  return keys.map((key, i) => {
    const Group = GROUPS[key];
    return (
      <Fragment key={key}>
        {i > 0 && <Divider />}
        <span className="flex shrink-0 items-center gap-0.5" data-group={key}>
          <Group {...ctx} />
        </span>
      </Fragment>
    );
  });
}

/** 在渲染前按固定组宽决定能放下几组；其余收进「更多」。 */
function useVisibleCount(keys: GroupKey[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  let used = 156;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as GroupKey;
    const need = GROUP_WIDTH[key] + (i > 0 ? GROUP_GAP : 0);
    const reserve = i < keys.length - 1 ? GROUP_GAP + MORE_WIDTH : 0;
    if (used + need + reserve > width) return { ref, visible: Math.max(1, i) };
    used += need;
  }
  return { ref, visible: keys.length };
}

export function FormatToolbar({
  api,
  csv,
  mobile = false,
}: {
  api: SheetApi | null /** CSV 只保存值：格式不可写回。 */;
  csv: boolean;
  mobile?: boolean;
}) {
  const f = useFormatState(api);
  const keys: GroupKey[] = csv ? ["history"] : ORDER;
  const { ref, visible } = useVisibleCount(keys);
  const ctx: Ctx = {
    api,
    f,
    off: !api || !f,
    run: (id, params) => {
      if (api) void exec(api, id, params);
    },
    closeToGrid: (e) => {
      e.preventDefault();
      if (api) focusGrid(api);
    },
  };
  if (mobile) {
    const labels: Record<GroupKey, string> = {
      history: "撤销与重做",
      font: "字体与字号",
      style: "文字样式",
      colors: "文字与填充颜色",
      align: "对齐与换行",
      number: "数字格式",
      cells: "边框与合并",
      clear: "清除格式",
    };
    return (
      <div className="em-mobile-format" aria-label="手机格式工具">
        <Button
          variant="ghost"
          className="justify-start gap-2"
          disabled={!api}
          onClick={() => {
            if (api) void exec(api, OpenFindDialogOperation.id);
          }}
        >
          <Search className="size-4" />
          查找与替换
        </Button>
        {keys.map((key) => {
          const Group = GROUPS[key];
          return (
            <section key={key}>
              <h4>{labels[key]}</h4>
              <div>
                <Group {...ctx} />
              </div>
            </section>
          );
        })}
        {csv ? (
          <p className="text-xs text-muted-foreground">
            CSV 只保存数据。
            <Button variant="ghost" onClick={() => askAgent("save-as-xlsx")}>
              让助手另存为 XLSX
            </Button>
          </p>
        ) : (
          <details>
            <summary>表格与高级格式</summary>
            <div className="em-mobile-format-advanced">
              <div>
                <span>格式刷</span>
                <FormatPainter api={api} disabled={ctx.off} />
              </div>
              <div>
                <span>条件格式</span>
                <ConditionalFormats api={api} disabled={ctx.off} />
              </div>
              <div>
                <span>定义名称</span>
                <DefinedNames api={api} disabled={ctx.off} />
              </div>
              <div>
                <span>表对象</span>
                <TableManagerPanel api={api} disabled={ctx.off} />
              </div>
              <div>
                <span>数组公式</span>
                <ArrayFormulas api={api} disabled={ctx.off} />
              </div>
            </div>
          </details>
        )}
      </div>
    );
  }
  const hidden = keys.slice(visible);
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="格式"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
    >
      <ToolButton
        icon={Search}
        label="查找与替换（Ctrl/⌘+F）"
        disabled={!api}
        onClick={() => {
          if (api) void exec(api, OpenFindDialogOperation.id);
        }}
      />
      {!csv && <FormatPainter api={api} disabled={ctx.off} />}
      {!csv && <ConditionalFormats api={api} disabled={ctx.off} />}
      {!csv && <DefinedNames api={api} disabled={ctx.off} />}
      {!csv && <TableManagerPanel api={api} disabled={ctx.off} />}
      {!csv && <ArrayFormulas api={api} disabled={ctx.off} />}
      <Groups keys={keys.slice(0, visible)} ctx={ctx} />
      {csv && (
        <>
          <Divider />
          <span className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span className="truncate">CSV 只保存数据</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-xs"
            onClick={() => askAgent("save-as-xlsx")}
          >
            让助手另存为 XLSX
          </Button>
        </>
      )}
      {hidden.length > 0 && (
        <>
          <Divider />
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="更多格式"
                title="更多格式"
                className={toolCls}
                onMouseDown={keepGridFocus}
              >
                <Ellipsis className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="flex w-auto max-w-[min(560px,calc(100vw-16px))] flex-wrap items-center gap-0.5 p-1.5"
              onCloseAutoFocus={ctx.closeToGrid}
            >
              <Groups keys={hidden} ctx={ctx} />
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}
