// 工具结果的内联展示：读取的数据预览、写入的改动与修改前后、脚本的待发布清单与输出、文本改动。
// 统一扁平样式：浅底色块，不加卡片边框。

import { formatRange, indexToCol, parseRange } from "@excelmanus/core";
import { ArrowRight, ExternalLink, Loader2, LocateFixed, Table2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { openWorkspaceFile } from "@/lib/open-file";
import { fileName } from "@/lib/paths";
import type { ChangeEntry, ToolState } from "@/lib/session/types";
import { editDiff, type TextDiff, writeDiff } from "@/lib/text-diff";
import { cn } from "@/lib/utils";
import { readComparisonSnapshot, readRevisionBefore } from "@/lib/workbook/change-reads";
import { downloadWorkspaceFile } from "@/stores/files-store";
import {
  focusRange,
  openWorkbook,
  openWorkbookById,
  useWorkbookStore,
} from "@/stores/workbook-store";
import { RelatedFilesCard } from "./FileCapsule";
import { ScrollablePreview } from "./ScrollablePreview";
import { TextDiffView } from "./TextDiffView";

/** 交付入口来自成功的工具结果，不依赖模型是否把文件名写成链接。 */
export function OutputFiles({ paths }: { paths: string[] }) {
  return (
    <RelatedFilesCard
      files={[...new Set(paths)].map((path) => ({
        key: path,
        filename: fileName(path),
        filePath: path,
        onOpen: () => openWorkspaceFile(path),
        onDownload: () => {
          void downloadWorkspaceFile(path).catch(() => undefined);
        },
      }))}
    />
  );
}

const MAX_PREVIEW_ROWS = 50;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 浅底色块：工具结果的统一容器。 */
export function ResultBlock({
  title,
  meta,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg bg-[var(--em-fill)] text-xs", className)}>
      {(title || meta || action) && (
        <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
          {title && (
            <div className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] font-medium text-foreground/85">
              {title}
            </div>
          )}
          {meta && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{meta}</span>
          )}
          {action && <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

function LinkButton({
  onClick,
  children,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
    >
      {children}
    </button>
  );
}

/** 区域数据网格：列号取自区域起点，行号同 Excel。 */
export function ValuesGrid({
  range,
  values,
  formulas,
}: {
  range?: string;
  values: unknown[][];
  formulas?: (string | null)[][];
}) {
  let startRow = 1;
  let startCol = 1;
  try {
    if (range) {
      const p = parseRange(range);
      startRow = p.startRow;
      startCol = p.startCol;
    }
  } catch {
    // 区域解析失败时按 A1 起算
  }
  const rows = values.slice(0, MAX_PREVIEW_ROWS);
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (rows.length === 0 || width === 0)
    return <p className="px-2.5 pb-2 text-[11px] text-muted-foreground">区域为空</p>;
  return (
    <ScrollablePreview collapsedHeight={180} expandedHeight={420}>
      <div className="overflow-x-auto bg-background/70">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 w-8 min-w-8 border-b border-r border-[var(--em-hairline)] bg-[var(--em-fill)] px-1 py-0.5 text-center text-[10px] font-normal text-muted-foreground/70" />
              {Array.from({ length: width }, (_, i) => (
                <th
                  key={i}
                  className="sticky top-0 z-10 min-w-14 border-b border-r border-[var(--em-hairline)] bg-[var(--em-fill)] px-2 py-0.5 text-center text-[10px] font-medium text-muted-foreground"
                >
                  {indexToCol(startCol + i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <td className="sticky left-0 z-10 border-b border-r border-[var(--em-hairline)] bg-[var(--em-fill)] px-1 py-0.5 text-center text-[10px] text-muted-foreground/70 tabular-nums">
                  {startRow + r}
                </td>
                {Array.from({ length: width }, (_, c) => {
                  const v = row[c];
                  const f = formulas?.[r]?.[c];
                  const text = cellText(v);
                  return (
                    <td
                      key={c}
                      title={f ? `${f}\n= ${text}` : text}
                      className={cn(
                        "max-w-[200px] truncate border-b border-r border-[var(--em-hairline)]/60 px-2 py-0.5 whitespace-nowrap",
                        typeof v === "number" ? "text-right tabular-nums" : "text-left",
                        f && "text-[var(--em-primary)]",
                      )}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ScrollablePreview>
  );
}

function openTarget(data: { docId?: unknown; path?: unknown }, range?: string) {
  const docId = typeof data.docId === "string" ? data.docId : undefined;
  const path = typeof data.path === "string" ? data.path : undefined;
  if (range) void focusRange(range, docId ? { docId } : path ? { path } : undefined);
  else if (docId) void openWorkbookById(docId);
  else if (path) void openWorkbook(path);
}

/** workbook_read 的结果：区域数据、表格行、结构概览或搜索命中。 */
export function WorkbookReadResult({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const path = typeof d.path === "string" ? d.path : "";
  const title = (
    <>
      <Table2 className="h-3.5 w-3.5 shrink-0 text-[var(--em-primary)]" />
      <span className="truncate">{fileName(path) || "工作簿"}</span>
    </>
  );
  if (d.mode === "range" && Array.isArray(d.values)) {
    const range = typeof d.range === "string" ? d.range : undefined;
    const values = d.values as unknown[][];
    return (
      <ResultBlock
        title={title}
        meta={`${range ?? ""}${d.truncated === true ? " · 已截断" : ""}`}
        action={
          <LinkButton onClick={() => openTarget(d, range)} title="在表格中定位">
            <LocateFixed className="h-3 w-3" />
            定位
          </LinkButton>
        }
      >
        <ValuesGrid
          range={range}
          values={values}
          formulas={Array.isArray(d.formulas) ? (d.formulas as (string | null)[][]) : undefined}
        />
        {values.length > MAX_PREVIEW_ROWS && (
          <p className="px-2.5 py-1 text-[10.5px] text-muted-foreground">
            只显示前 {MAX_PREVIEW_ROWS} 行
          </p>
        )}
      </ResultBlock>
    );
  }
  if (d.mode === "table" && Array.isArray(d.columns) && Array.isArray(d.rows)) {
    const columns = (d.columns as unknown[]).map(String);
    const allRows = d.rows as Record<string, unknown>[];
    const rows = allRows.slice(0, MAX_PREVIEW_ROWS).map((row) => columns.map((c) => row[c]));
    return (
      <ResultBlock
        title={title}
        meta={`${typeof d.total === "number" ? d.total : allRows.length} 行 × ${columns.length} 列`}
      >
        <ScrollablePreview collapsedHeight={180} expandedHeight={420}>
          <div className="overflow-x-auto bg-background/70">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c}
                      className="sticky top-0 border-b border-r border-[var(--em-hairline)] bg-[var(--em-fill)] px-2 py-1 text-left font-semibold whitespace-nowrap text-muted-foreground"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((v, j) => {
                      const text = cellText(v);
                      return (
                        <td
                          key={j}
                          title={text}
                          className={cn(
                            "max-w-[200px] truncate border-b border-r border-[var(--em-hairline)]/60 px-2 py-0.5 whitespace-nowrap",
                            typeof v === "number" && "text-right tabular-nums",
                          )}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ScrollablePreview>
      </ResultBlock>
    );
  }
  if (d.mode === "overview" && Array.isArray(d.sheets)) {
    const sheets = d.sheets as {
      name?: unknown;
      rows?: unknown;
      cols?: unknown;
      rowCount?: unknown;
      columnCount?: unknown;
      hidden?: unknown;
    }[];
    return (
      <ResultBlock title={title} meta={`${sheets.length} 张工作表`}>
        <div className="flex flex-wrap gap-1 px-2.5 pb-2">
          {sheets.map((sh, i) => {
            const rows = sh.rows ?? sh.rowCount;
            const cols = sh.cols ?? sh.columnCount;
            return (
              <button
                key={i}
                type="button"
                onClick={() =>
                  openTarget(
                    d,
                    typeof sh.name === "string" ? `'${sh.name.replace(/'/g, "''")}'!A1` : undefined,
                  )
                }
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md bg-background px-2 text-[11px] hover:text-[var(--em-primary)]",
                  sh.hidden === true && "opacity-60",
                )}
              >
                {String(sh.name ?? `表 ${i + 1}`)}
                {typeof rows === "number" && typeof cols === "number" && (
                  <span className="text-muted-foreground">
                    {rows}×{cols}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </ResultBlock>
    );
  }
  if (d.mode === "search" && Array.isArray(d.matches)) {
    const matches = d.matches as {
      sheet?: unknown;
      cell?: unknown;
      ref?: unknown;
      value?: unknown;
    }[];
    return (
      <ResultBlock
        title={title}
        meta={`${matches.length} 处命中${d.truncated === true ? "（已截断）" : ""}`}
      >
        <div className="flex flex-wrap gap-1 px-2.5 pb-2">
          {matches.slice(0, 24).map((m, i) => {
            const ref =
              typeof m.ref === "string"
                ? m.ref
                : typeof m.cell === "string"
                  ? typeof m.sheet === "string"
                    ? `${m.sheet}!${m.cell}`
                    : m.cell
                  : null;
            return ref ? (
              <button
                key={i}
                type="button"
                onClick={() => openTarget(d, ref)}
                title={cellText(m.value)}
                className="inline-flex h-6 max-w-56 items-center gap-1 truncate rounded-md bg-background px-2 font-mono text-[11px] hover:text-[var(--em-primary)]"
              >
                {ref}
              </button>
            ) : null;
          })}
        </div>
      </ResultBlock>
    );
  }
  return null;
}

interface DiffRow {
  ref: string;
  before: string;
  after: string;
}

/** 一次写入的「修改前 / 现在」逐格对照：修改前来自该修订的逆操作，现在来自当前快照。 */
function EditDiffRows({ change }: { change: ChangeEntry }) {
  const workspaceId = useWorkbookStore((s) => s.workspaceId);
  const [rows, setRows] = useState<DiffRow[] | "same" | "error" | null>(null);
  useEffect(() => {
    if (!workspaceId || change.rev === null) return;
    let alive = true;
    const doc = useWorkbookStore.getState().doc;
    const currentRev = doc?.docId === change.docId ? doc.rev : null;
    setRows(null);
    void Promise.all([
      readRevisionBefore(workspaceId, change.docId, change.rev),
      readComparisonSnapshot(workspaceId, change.docId, currentRev),
    ])
      .then(([{ cells }, current]) => {
        if (!alive) return;
        if (cells.length === 0) {
          setRows("same");
          return;
        }
        const sheets =
          (
            current.snapshot as {
              sheets?: Record<
                string,
                {
                  name?: string;
                  cellData?: Record<string, Record<string, { v?: unknown; f?: unknown }>>;
                }
              >;
            } | null
          )?.sheets ?? {};
        const byName = new Map(Object.values(sheets).map((sh) => [sh.name, sh]));
        setRows(
          cells.slice(0, 40).map((c) => {
            const now = byName.get(c.sheet)?.cellData?.[String(c.row)]?.[String(c.col)];
            return {
              ref: `${c.sheet}!${formatRange({ startCol: c.col + 1, startRow: c.row + 1, endCol: c.col + 1, endRow: c.row + 1 })}`,
              before: c.formula ?? cellText(c.value),
              after: typeof now?.f === "string" && now.f ? now.f : cellText(now?.v),
            };
          }),
        );
      })
      .catch(() => alive && setRows("error"));
    return () => {
      alive = false;
    };
  }, [workspaceId, change.docId, change.rev]);
  if (rows === null)
    return (
      <p className="flex items-center gap-1.5 px-2.5 pb-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        正在读取修改前的值…
      </p>
    );
  if (rows === "same")
    return <p className="px-2.5 pb-2 text-[11px] text-muted-foreground">写入的值与原值相同</p>;
  if (rows === "error")
    return (
      <p className="px-2.5 pb-2 text-[11px] text-muted-foreground">
        无法读取修改前的值（文档可能已关闭或修订已压缩）
      </p>
    );
  return (
    <div className="max-h-64 overflow-auto bg-background/70">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-[10px] text-muted-foreground">
            <th className="sticky top-0 w-28 bg-[var(--em-fill)] px-2.5 py-1 text-left font-medium">
              单元格
            </th>
            <th className="sticky top-0 bg-[var(--em-fill)] px-2 py-1 text-left font-medium">
              修改前
            </th>
            <th className="sticky top-0 w-4 bg-[var(--em-fill)]" />
            <th className="sticky top-0 bg-[var(--em-fill)] px-2 py-1 text-left font-medium">
              现在
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ref} className="border-t border-[var(--em-hairline)]/60">
              <td className="px-2.5 py-0.5">
                <button
                  type="button"
                  onClick={() => void focusRange(row.ref, { docId: change.docId })}
                  className="font-mono text-muted-foreground hover:text-[var(--em-primary)]"
                >
                  {row.ref}
                </button>
              </td>
              <td
                className="max-w-[180px] truncate px-2 py-0.5 font-mono text-muted-foreground line-through decoration-muted-foreground/40"
                title={row.before}
              >
                {row.before || "（空）"}
              </td>
              <td className="text-muted-foreground/50">
                <ArrowRight className="h-3 w-3" />
              </td>
              <td
                className="max-w-[180px] truncate px-2 py-0.5 font-mono font-medium text-[var(--em-primary)]"
                title={row.after}
              >
                {row.after || "（空）"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** workbook_edit 写入后的改动：区域、格数、结构变化，可展开看修改前后。 */
export function WorkbookEditResult({ change, dryRun }: { change: ChangeEntry; dryRun?: boolean }) {
  const [open, setOpen] = useState(false);
  const cells = change.cells;
  return (
    <ResultBlock
      title={
        <>
          <Table2 className="h-3.5 w-3.5 shrink-0 text-[var(--em-primary)]" />
          <span className="truncate">{fileName(change.path) || "工作簿"}</span>
        </>
      }
      meta={[
        dryRun ? "预演（未写入）" : change.rev !== null ? `修订 ${change.rev}` : null,
        cells > 0 ? `${cells} 格` : null,
        change.structural.length > 0 ? change.structural.join("，") : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      action={
        <>
          {change.rev !== null && !dryRun && (
            <LinkButton onClick={() => setOpen((v) => !v)}>
              {open ? "收起对照" : "修改前后"}
            </LinkButton>
          )}
          <LinkButton
            onClick={() => openTarget({ docId: change.docId, path: change.path }, change.ranges[0])}
            title="在表格中查看"
          >
            <ExternalLink className="h-3 w-3" />
            查看
          </LinkButton>
        </>
      }
    >
      {change.ranges.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2.5 pb-2">
          {change.ranges.slice(0, 8).map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => void focusRange(range, { docId: change.docId })}
              className="inline-flex h-5 items-center rounded-md bg-[var(--em-primary-alpha-08)] px-1.5 font-mono text-[10.5px] text-[var(--em-primary)] hover:bg-[var(--em-primary-alpha-12)]"
            >
              {range}
            </button>
          ))}
          {change.ranges.length > 8 && (
            <span className="text-[11px] text-muted-foreground">等 {change.ranges.length} 处</span>
          )}
        </div>
      )}
      {open && <EditDiffRows change={change} />}
    </ResultBlock>
  );
}

interface PublishItem {
  path?: unknown;
  kind?: unknown;
  create?: unknown;
  created?: unknown;
  opsCount?: unknown;
  changes?: { ranges?: unknown; cellsBySheet?: unknown };
  preview?: { range?: unknown; values?: unknown }[];
  bytes?: unknown;
  diffHead?: unknown;
}

/** 脚本待发布 / 已发布清单：工作簿区域预览、文本前几行。 */
export function PublishPlan({ items, title = "待发布的修改" }: { items: unknown; title?: string }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
      {(items as PublishItem[]).map((item, i) => {
        const path = typeof item.path === "string" ? item.path : `文件 ${i + 1}`;
        if (item.kind === "text") {
          const head = typeof item.diffHead === "string" ? item.diffHead : "";
          return (
            <ResultBlock
              key={i}
              title={fileName(path)}
              meta={`${item.created === true ? "新建" : "修改"}文本${typeof item.bytes === "number" ? ` · ${item.bytes} 字节` : ""}`}
            >
              {head && <pre className="em-step-pre max-h-40 bg-background/70">{head}</pre>}
            </ResultBlock>
          );
        }
        const rawRanges: unknown = item.changes?.ranges;
        const ranges = Array.isArray(rawRanges) ? rawRanges.slice(0, 3).map(String) : [];
        return (
          <ResultBlock
            key={i}
            title={
              <>
                <Table2 className="h-3.5 w-3.5 shrink-0 text-[var(--em-primary)]" />
                <span className="truncate">{fileName(path)}</span>
              </>
            }
            meta={`${item.create === true ? "新建工作簿" : "修改工作簿"}${typeof item.opsCount === "number" ? ` · ${item.opsCount} 项操作` : ""}${ranges.length ? ` · ${ranges.join("、")}` : ""}`}
          >
            {(item.preview ?? [])
              .slice(0, 2)
              .map((p, j) =>
                Array.isArray(p.values) ? (
                  <ValuesGrid
                    key={j}
                    range={typeof p.range === "string" ? p.range : undefined}
                    values={p.values as unknown[][]}
                  />
                ) : null,
              )}
          </ResultBlock>
        );
      })}
    </div>
  );
}

/** run_script 的输出：控制台输出、返回值与已发布的修改。 */
export function ScriptResult({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const d = data as { stdout?: unknown; value?: unknown; published?: unknown };
  const stdout =
    typeof d.stdout === "string" ? d.stdout : Array.isArray(d.stdout) ? d.stdout.join("\n") : "";
  const hasValue = d.value !== undefined && d.value !== null;
  return (
    <div className="grid gap-1.5">
      {stdout.trim() && (
        <div className="em-step-block">
          <div className="em-step-block-label">输出</div>
          <pre className="em-step-pre">{stdout.trimEnd()}</pre>
        </div>
      )}
      {hasValue && (
        <div className="em-step-block">
          <div className="em-step-block-label">返回值</div>
          <pre className="em-step-pre">
            {typeof d.value === "string" ? d.value : JSON.stringify(d.value, null, 2)}
          </pre>
        </div>
      )}
      <PublishPlan items={d.published} title="已发布的修改" />
    </div>
  );
}

/** write / edit：直接从参数组成改动展示。 */
export function TextChange({ tool }: { tool: ToolState }) {
  const diff: TextDiff | null = useMemo(
    () => tool.name === "edit" ? editDiff(tool.args) : tool.name === "write" ? writeDiff(tool.args) : null,
    [tool.name, tool.args],
  );
  if (!diff) return null;
  return <TextDiffView data={diff} defaultOpen={tool.phase !== "done" || tool.status === "ok"} />;
}
