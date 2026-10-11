// 格式工具栏（01 §3.3）：只放写回支持的格式项。每个按钮执行 Univer 自带命令，产生的 mutation
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
import type { FUniver } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import {
  Fragment,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { S } from "../../strings.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Input } from "../ui/input.tsx";
import { isMac } from "../ui/kbd.tsx";
import { Popover, PopoverContent, PopoverTrigger, toast } from "../ui/overlay.tsx";
import { Tip } from "../ui/tooltip.tsx";

export type SheetApi = { univer: Univer; univerAPI: FUniver; wb: FWorkbook };

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
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const DEFAULT_SIZE = 11;

const FORMATS = [
  { key: "general", pattern: "", sample: "1234.5" },
  { key: "number", pattern: "#,##0.00", sample: "1,234.50" },
  { key: "integer", pattern: "#,##0", sample: "1,235" },
  { key: "percent", pattern: "0.00%", sample: "12.35%" },
  { key: "currency", pattern: "¥#,##0.00", sample: "¥1,234.50" },
  { key: "scientific", pattern: "0.00E+00", sample: "1.23E+03" },
  { key: "date", pattern: "yyyy-mm-dd", sample: "2026-10-11" },
  { key: "datetime", pattern: "yyyy-mm-dd hh:mm", sample: "2026-10-11 13:45" },
  { key: "time", pattern: "hh:mm:ss", sample: "13:45:00" },
  { key: "text", pattern: "@", sample: "007" },
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

const ALIGNS: { value: HorizontalAlign; icon: IconName; label: string }[] = [
  { value: HorizontalAlign.LEFT, icon: "alignLeft", label: S.fmt.alignLeft },
  { value: HorizontalAlign.CENTER, icon: "alignCenter", label: S.fmt.alignCenter },
  { value: HorizontalAlign.RIGHT, icon: "alignRight", label: S.fmt.alignRight },
];
const VALIGNS: { value: VerticalAlign; icon: IconName; label: string }[] = [
  { value: VerticalAlign.TOP, icon: "valignTop", label: S.fmt.valignTop },
  { value: VerticalAlign.MIDDLE, icon: "valignMiddle", label: S.fmt.valignMiddle },
  { value: VerticalAlign.BOTTOM, icon: "valignBottom", label: S.fmt.valignBottom },
];
const BORDERS: { type: BorderType; icon: IconName; label: string }[] = [
  { type: BorderType.ALL, icon: "borderAll", label: S.fmt.borderAll },
  { type: BorderType.OUTSIDE, icon: "borderOutside", label: S.fmt.borderOutside },
  { type: BorderType.INSIDE, icon: "borderInside", label: S.fmt.borderInside },
  { type: BorderType.TOP, icon: "borderTop", label: S.fmt.borderTop },
  { type: BorderType.BOTTOM, icon: "borderBottom", label: S.fmt.borderBottom },
  { type: BorderType.LEFT, icon: "borderLeft", label: S.fmt.borderLeft },
  { type: BorderType.RIGHT, icon: "borderRight", label: S.fmt.borderRight },
  { type: BorderType.NONE, icon: "borderNone", label: S.fmt.borderNone },
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
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readFormat(api.wb);
        const key = JSON.stringify(next);
        if (key === last) return;
        last = key;
        setState(next);
      });
    };
    update();
    const sub = api.wb.onCommandExecuted(update);
    return () => {
      cancelAnimationFrame(frame);
      sub.dispose();
    };
  }, [api]);
  return state;
}

function focusGrid(api: SheetApi) {
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
          toast({ tone: "err", title: S.fmt.tooLarge });
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
  "size-7 rounded-md px-0 text-foreground-secondary hover:bg-accent/70 hover:text-foreground aria-pressed:bg-accent aria-pressed:text-primary";

function ToolButton({
  label,
  icon,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string;
  icon?: IconName;
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
      {children ?? (icon && <Icon name={icon} size="md" />)}
    </Button>
  );
  if (disabled) return btn;
  return (
    <Tip content={label} shortcut={shortcut}>
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
  const btn = (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <Button
        variant="ghost"
        size="xs"
        aria-label={label}
        className={cn(
          "h-7 gap-1 rounded-md px-1.5 text-xs font-normal text-foreground-secondary hover:bg-accent/70 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
          className,
        )}
      >
        {children}
        <Icon name="chevronDown" size="xs" className="text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
  );
  if (disabled) return btn;
  return <Tip content={label}>{btn}</Tip>;
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />;
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
  const label = kind === "text" ? S.fmt.textColor : S.fmt.fillColor;
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
            <Icon name="paintBucket" size="sm" />
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
            aria-label={S.fmt.moreColors(label)}
            className="h-7 w-3.5 rounded-l-none px-0 text-muted-foreground hover:bg-accent/70 data-[state=open]:bg-accent"
            onMouseDown={keepGridFocus}
          >
            <Icon name="chevronDown" size="xs" />
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
                "size-4 rounded-sm border border-border-strong",
                kind === "fill" &&
                  "bg-[linear-gradient(to_top_right,transparent_calc(50%-0.75px),var(--destructive)_calc(50%-0.75px),var(--destructive)_calc(50%+0.75px),transparent_calc(50%+0.75px))]",
                kind === "text" && "bg-foreground",
              )}
            />
            {kind === "text" ? S.fmt.resetTextColor : S.fmt.resetFill}
          </Button>
          <div className="grid grid-cols-8 gap-1.5">
            {PALETTE.flat().map((value) => (
              <Button
                key={value}
                variant="ghost"
                size="icon-xs"
                aria-label={value}
                aria-pressed={selected === value}
                className="size-6 rounded-md p-0 ring-offset-1 ring-offset-popover hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-primary"
                onClick={() => apply(value)}
              >
                <span
                  className="size-full rounded-[5px] ring-1 ring-black/10 ring-inset"
                  style={{ backgroundColor: value }}
                />
              </Button>
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
              size="sm"
              mono
              value={custom}
              placeholder="#1A7F5A"
              aria-label={S.fmt.customColor}
              onChange={(e) => setCustom(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" className="h-8 px-2.5">
              {S.fmt.apply}
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
/** 各组实测宽度（按钮 28px、组内间距 2px、下拉触发器宽度），用于在渲染前决定能放下几组。 */
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
/** 分隔线 1px + 两侧 4px 外距 + 两侧 2px 间距。 */
const GROUP_GAP = 13;
const MORE_WIDTH = 28;

function HistoryGroup({ api, run }: Ctx) {
  return (
    <>
      <ToolButton
        label={S.fmt.undo}
        icon="undo"
        shortcut="Z"
        disabled={!api}
        onClick={() => run("univer.command.undo")}
      />
      <ToolButton
        label={S.fmt.redo}
        icon="redo"
        shortcut={isMac ? "⇧Z" : "Y"}
        disabled={!api}
        onClick={() => run("univer.command.redo")}
      />
    </>
  );
}

function FontGroup({ f, off, run, closeToGrid }: Ctx) {
  const fontLabel = f?.fontFamily
    ? (S.fmt.fontNames[f.fontFamily] ?? f.fontFamily)
    : S.fmt.fontDefault;
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label={S.fmt.font} disabled={off} className="w-[7.5rem] justify-between">
          <span className="truncate">{fontLabel}</span>
        </MenuTrigger>
        <DropdownMenuContent align="start" className="w-52" onCloseAutoFocus={closeToGrid}>
          <DropdownMenuRadioGroup
            value={f?.fontFamily ?? ""}
            onValueChange={(value) => run("sheet.command.set-range-font-family", { value })}
          >
            {FONTS.map((font) => (
              <DropdownMenuRadioItem key={font} value={font}>
                <span style={{ fontFamily: font }}>{S.fmt.fontNames[font] ?? font}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <MenuTrigger label={S.fmt.fontSize} disabled={off} className="w-12 justify-between">
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
        label={S.fmt.bold}
        icon="bold"
        shortcut="B"
        pressed={f?.bold}
        disabled={off}
        onClick={() => run("sheet.command.set-range-bold")}
      />
      <ToolButton
        label={S.fmt.italic}
        icon="italic"
        shortcut="I"
        pressed={f?.italic}
        disabled={off}
        onClick={() => run("sheet.command.set-range-italic")}
      />
      <ToolButton
        label={S.fmt.underline}
        icon="underline"
        shortcut="U"
        pressed={f?.underline}
        disabled={off}
        onClick={() => run("sheet.command.set-range-underline")}
      />
      <ToolButton
        label={S.fmt.strike}
        icon="strike"
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
  const alignIcon = ALIGNS.find((a) => a.value === f?.ht)?.icon ?? "alignLeft";
  const valignIcon = VALIGNS.find((a) => a.value === f?.vt)?.icon ?? "valignBottom";
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label={S.fmt.align} disabled={off}>
          <Icon name={alignIcon} size="md" />
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
                <span className="flex items-center gap-2">
                  <Icon name={a.icon} size="sm" />
                  {a.label}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <MenuTrigger label={S.fmt.valign} disabled={off}>
          <Icon name={valignIcon} size="md" />
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
                <span className="flex items-center gap-2">
                  <Icon name={a.icon} size="sm" />
                  {a.label}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolButton
        label={S.fmt.wrap}
        icon="wrap"
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
        label={S.fmt.currency}
        icon="currency"
        disabled={off}
        onClick={() => api && applyPattern(api, "¥#,##0.00")}
      />
      <ToolButton
        label={S.fmt.percent}
        icon="percent"
        disabled={off}
        onClick={() => api && applyPattern(api, "0.00%")}
      />
      <ToolButton
        label={S.fmt.decimalLess}
        icon="decimalLess"
        disabled={off}
        onClick={() => run("sheet.command.numfmt.subtract.decimal.command")}
      />
      <ToolButton
        label={S.fmt.decimalMore}
        icon="decimalMore"
        disabled={off}
        onClick={() => run("sheet.command.numfmt.add.decimal.command")}
      />
      <DropdownMenu>
        <MenuTrigger label={S.fmt.numberFormat} disabled={off}>
          <span className="font-mono text-[11px] font-medium tracking-tight">123</span>
        </MenuTrigger>
        <DropdownMenuContent align="start" className="w-60" onCloseAutoFocus={closeToGrid}>
          <DropdownMenuRadioGroup
            value={f?.pattern ?? ""}
            onValueChange={(pattern) => api && applyPattern(api, pattern)}
          >
            {FORMATS.map((item) => (
              <DropdownMenuRadioItem key={item.key} value={item.pattern}>
                <span className="flex w-full items-center justify-between gap-4">
                  {S.fmt.formats[item.key]}
                  <span className="font-mono text-2xs text-muted-foreground">{item.sample}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function CellsGroup({ f, off, run, closeToGrid }: Ctx) {
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label={S.fmt.borders} disabled={off}>
          <Icon name="borderAll" size="md" />
        </MenuTrigger>
        <DropdownMenuContent align="start" className="w-44" onCloseAutoFocus={closeToGrid}>
          {BORDERS.map((b) => (
            <DropdownMenuItem
              key={b.type}
              onSelect={() =>
                run("sheet.command.set-border-basic", {
                  value: { type: b.type, color: "#000000", style: BorderStyleTypes.THIN },
                })
              }
            >
              <Icon name={b.icon} size="sm" className="text-foreground-secondary" />
              {b.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolButton
        label={f?.merged ? S.fmt.unmerge : S.fmt.merge}
        icon={f?.merged ? "unmerge" : "merge"}
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
      label={S.fmt.clearFormat}
      icon="clearFormat"
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
  let used = 0;
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
  trailing,
}: {
  api: SheetApi | null;
  /** CSV 只保存值：格式不可写回，只保留撤销 / 重做。 */
  csv: boolean;
  trailing?: ReactNode;
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
  const hidden = keys.slice(visible);
  return (
    <div className="flex min-h-0 flex-1 items-center gap-2 bg-card pr-3 pl-2.5">
      <div
        ref={ref}
        role="toolbar"
        aria-label={S.fmt.toolbar}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      >
        <Groups keys={keys.slice(0, visible)} ctx={ctx} />
        {csv && (
          <>
            <Divider />
            <span className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Icon name="info" size="xs" className="shrink-0" />
              <span className="truncate">{S.fmt.csvNote}</span>
            </span>
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
                  aria-label={S.fmt.more}
                  className={toolCls}
                  onMouseDown={keepGridFocus}
                >
                  <Icon name="more" size="md" />
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
      {trailing}
    </div>
  );
}
