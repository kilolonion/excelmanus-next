import { FileText, Loader2 } from "lucide-react";
import { type ReactElement, type ReactNode, useMemo, useRef } from "react";
import { fileName } from "@/lib/paths";
import { CodeBlock } from "./CodeBlock";
import { ScrollablePreview } from "./ScrollablePreview";
import { VirtualTextPreview, VIRTUAL_TEXT_THRESHOLD } from "./VirtualTextPreview";
const EMPTY_LINES: string[] = [];

interface StreamingTextPreviewProps {
  toolName: string;
  rawArgs: string;
}

// ── JSON 流式解析工具 ─────────────────────────────────────

/**
 * 从流式累积的 JSON 字符串中提取指定 key 的字符串值。
 * 处理 JSON 转义字符，支持值尚未闭合（流式截断）的情况。
 */
export function extractJsonStringValue(rawArgs: string, key: string): string | null {
  const patterns = [`"${key}":"`, `"${key}": "`, `"${key}" : "`];
  let startIdx = -1;
  let patternLen = 0;
  for (const p of patterns) {
    const idx = rawArgs.indexOf(p);
    if (idx !== -1) {
      startIdx = idx;
      patternLen = p.length;
      break;
    }
  }
  if (startIdx === -1) return null;

  const start = startIdx + patternLen;
  let end = rawArgs.indexOf('"', start);
  for (; end >= 0; end = rawArgs.indexOf('"', end + 1)) {
    let slash = end - 1;
    while (slash >= start && rawArgs[slash] === "\\") slash--;
    if ((end - slash - 1) % 2 === 0) break;
  }
  const value = rawArgs.slice(start, end < 0 ? undefined : end);
  if (!value.includes("\\")) return value;
  // Decode ordinary JSON escapes natively, including an unfinished final backslash.
  // Keep the existing loose behavior for unknown escapes and partial unicode sequences.
  if (!/\\[^ntr"\\/]/.test(value)) {
    let slash = value.length - 1;
    while (slash >= 0 && value[slash] === "\\") slash--;
    try {
      return JSON.parse('"' + value + ((value.length - slash - 1) % 2 ? "\\" : "") + '"');
    } catch {
      // Partial model arguments may contain raw control characters.
    }
  }
  const afterQuote = value;
  let result = "";
  let i = 0;
  while (i < afterQuote.length) {
    const ch = afterQuote[i];
    if (ch === '"') break;
    if (ch === "\\") {
      const next = afterQuote[i + 1];
      if (next === "n") {
        result += "\n";
        i += 2;
        continue;
      }
      if (next === "t") {
        result += "\t";
        i += 2;
        continue;
      }
      if (next === "r") {
        result += "\r";
        i += 2;
        continue;
      }
      if (next === '"') {
        result += '"';
        i += 2;
        continue;
      }
      if (next === "\\") {
        result += "\\";
        i += 2;
        continue;
      }
      if (next === "/") {
        result += "/";
        i += 2;
        continue;
      }
      result += ch;
      i += 1;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

function extractFilePath(rawArgs: string): string | null {
  return extractJsonStringValue(rawArgs, "path");
}

// ── edit 专用：提取第一处替换的 old + new ───────────────

interface EditDiffParts {
  oldString: string | null;
  newString: string | null;
}

function extractEditDiffParts(rawArgs: string): EditDiffParts {
  return {
    oldString: extractJsonStringValue(rawArgs, "oldText"),
    newString: extractJsonStringValue(rawArgs, "newText"),
  };
}

/** Reuse completed rows while the streamed tail changes; retain only the previous render. */
function useStreamingRows(
  lines: string[],
  renderRow: (line: string, index: number, last: boolean) => ReactNode,
): ReactNode[] {
  const previous = useRef<{
    lines: string[];
    rows: ReactNode[];
    renderRow: typeof renderRow;
  } | null>(null);
  return useMemo(() => {
    const prior = previous.current;
    const rows = lines.map((line, i) =>
      prior?.renderRow === renderRow &&
      prior.lines[i] === line &&
      (i === prior.lines.length - 1) === (i === lines.length - 1)
        ? prior.rows[i]
        : renderRow(line, i, i === lines.length - 1),
    );
    previous.current = { lines, rows, renderRow };
    return rows;
  }, [lines, renderRow]);
}

function renderAddedLine(line: string, i: number, last: boolean): ReactElement {
  return (
    <tr key={`a-${i}`} className="bg-green-50 dark:bg-green-950/25">
      <td className="w-8 select-none" />
      <td className="w-8 text-right pr-1.5 text-[10px] text-muted-foreground/25 select-none bg-green-100/50 dark:bg-green-900/15">
        {i + 1}
      </td>
      <td className="pl-2 pr-3 py-0 whitespace-pre text-green-900 dark:text-green-200">
        {line}
        {/* 最后一行：闪烁光标 */}
        {last && (
          <span className="inline-block w-[6px] h-[13px] bg-green-500 dark:bg-green-400 animate-pulse ml-0.5 align-middle" />
        )}
      </td>
    </tr>
  );
}

function renderWrittenLine(line: string, i: number, last: boolean): ReactElement {
  return (
    <tr key={i} className="bg-green-50 dark:bg-green-950/25">
      <td className="w-8 text-right pr-1.5 text-[10px] text-muted-foreground/25 select-none bg-green-100/50 dark:bg-green-900/15">
        {i + 1}
      </td>
      <td className="pl-2 pr-3 py-0 whitespace-pre text-green-900 dark:text-green-200">
        {line}
        {last && (
          <span className="inline-block w-[6px] h-[13px] bg-green-500 dark:bg-green-400 animate-pulse ml-0.5 align-middle" />
        )}
      </td>
    </tr>
  );
}

function renderDeletedLine(line: string, i: number): ReactElement {
  return (
    <tr key={`d-${i}`} className="bg-red-50 dark:bg-red-950/25">
      <td className="w-8 text-right pr-1.5 text-[10px] text-muted-foreground/25 select-none bg-red-100/50 dark:bg-red-900/15">
        {i + 1}
      </td>
      <td className="w-8 select-none" />
      <td className="pl-2 pr-3 py-0 whitespace-pre text-red-900 dark:text-red-200">{line}</td>
    </tr>
  );
}

// ── 子组件：流式 Diff 预览（edit_text_file） ──────────────

function StreamingDiffBody({
  filePath,
  oldString,
  newString,
}: {
  filePath: string | null;
  oldString: string | null;
  newString: string | null;
}) {
  const oldLines = useMemo(() => (oldString ? oldString.split("\n") : []), [oldString]);
  const newLines = useMemo(() => (newString ? newString.split("\n") : []), [newString]);
  const initialScroll = useRef({ following: true, rowOffset: 0 });
  const virtual = oldLines.length + newLines.length > VIRTUAL_TEXT_THRESHOLD;
  const newRows = useStreamingRows(virtual ? EMPTY_LINES : newLines, renderAddedLine);
  const deletions = oldLines.length;
  const additions = newLines.length;
  const filename = filePath ? fileName(filePath) || filePath : null;
  const isNewStringStreaming = newString !== null;
  const isWaiting = !oldString && !newString;

  const oldRows = useMemo(
    () => (virtual ? [] : oldLines.map(renderDeletedLine)),
    [oldLines, virtual],
  );

  if (isWaiting) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>正在生成内容...</span>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg bg-[var(--em-fill)] text-xs">
      {/* ── 文件头（与 TextDiffView 风格一致） ── */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 select-none">
        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
        {filename && (
          <span
            className="font-medium text-foreground/80 truncate text-[12px]"
            title={filePath ?? ""}
          >
            {filename}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 text-[11px] font-semibold">
          {additions > 0 && (
            <span className="text-green-600 dark:text-green-400">+{additions}</span>
          )}
          {deletions > 0 && (
            <span className="text-red-600 dark:text-red-400 ml-0.5">-{deletions}</span>
          )}
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40 ml-1" />
        </div>
      </div>

      {/* ── Diff 内容 ── */}
      <div
        className="border-t border-[var(--em-hairline)] bg-background/60"
        onWheelCapture={(event) => {
          if (!virtual && event.deltaY < 0) initialScroll.current.following = false;
        }}
        onScrollCapture={(event) => {
          if (virtual) return;
          const el = event.target as HTMLElement;
          initialScroll.current = {
            following: el.scrollHeight - el.scrollTop - el.clientHeight <= 16,
            rowOffset: el.scrollTop / 17.6,
          };
        }}
      >
        {virtual ? (
          <VirtualTextPreview
            initialScroll={initialScroll.current}
            count={oldLines.length + newLines.length}
            columns={3}
            height={200}
            expandedHeight={420}
            contentVersion={newString ?? oldString}
            waiting={!isNewStringStreaming}
            copies={[
              { label: "复制修改前", text: oldString ?? "" },
              { label: "复制修改后", text: newString ?? "" },
            ]}
            renderRow={(i) =>
              i < oldLines.length
                ? renderDeletedLine(oldLines[i], i)
                : renderAddedLine(
                    newLines[i - oldLines.length],
                    i - oldLines.length,
                    i === oldLines.length + newLines.length - 1,
                  )
            }
          />
        ) : (
          <ScrollablePreview collapsedHeight={200} expandedHeight={420} autoScroll>
            <table className="w-full font-mono text-[11px] leading-[1.6] border-collapse">
              <tbody>
                {/* 删除行（old_string） */}
                {oldRows}

                {/* 新增行（new_string，流式追加） */}
                {newRows}

                {/* old_string 已到但 new_string 尚未开始 → 等待提示 */}
                {oldLines.length > 0 && !isNewStringStreaming && (
                  <tr>
                    <td
                      colSpan={3}
                      className="py-2 text-center text-[10px] text-muted-foreground/50 italic"
                    >
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        等待新内容...
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollablePreview>
        )}
      </div>
    </div>
  );
}

// ── 子组件：流式全绿预览（write_text_file / write_plan） ──

function StreamingWriteBody({ filePath, content }: { filePath: string | null; content: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const initialScroll = useRef({ following: true, rowOffset: 0 });
  const virtual = lines.length > VIRTUAL_TEXT_THRESHOLD;
  const rows = useStreamingRows(virtual ? EMPTY_LINES : lines, renderWrittenLine);
  const filename = filePath ? fileName(filePath) || filePath : null;

  return (
    <div className="overflow-hidden rounded-lg bg-[var(--em-fill)] text-xs">
      {/* 文件头 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 select-none">
        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
        {filename && (
          <span
            className="font-medium text-foreground/80 truncate text-[12px]"
            title={filePath ?? ""}
          >
            {filename}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 text-[11px] font-semibold">
          <span className="text-green-600 dark:text-green-400">+{lines.length}</span>
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40 ml-1" />
        </div>
      </div>

      {/* 内容 */}
      <div
        className="border-t border-[var(--em-hairline)] bg-background/60"
        onWheelCapture={(event) => {
          if (!virtual && event.deltaY < 0) initialScroll.current.following = false;
        }}
        onScrollCapture={(event) => {
          if (virtual) return;
          const el = event.target as HTMLElement;
          initialScroll.current = {
            following: el.scrollHeight - el.scrollTop - el.clientHeight <= 16,
            rowOffset: el.scrollTop / 17.6,
          };
        }}
      >
        {virtual ? (
          <VirtualTextPreview
            initialScroll={initialScroll.current}
            count={lines.length}
            columns={2}
            height={160}
            expandedHeight={400}
            contentVersion={content}
            copies={[{ label: "复制完整内容", text: content }]}
            renderRow={(i) => renderWrittenLine(lines[i], i, i === lines.length - 1)}
          />
        ) : (
          <ScrollablePreview collapsedHeight={160} expandedHeight={400} autoScroll>
            <table className="w-full font-mono text-[11px] leading-[1.6] border-collapse">
              <tbody>{rows}</tbody>
            </table>
          </ScrollablePreview>
        )}
      </div>
    </div>
  );
}

// ── 主组件 ──────────────────────────────────────────────

export default function StreamingTextPreview({ toolName, rawArgs }: StreamingTextPreviewProps) {
  const filePath = useMemo(
    () => (toolName === "run_script" ? null : extractFilePath(rawArgs)),
    [rawArgs, toolName],
  );

  if (toolName === "run_script") {
    const code = extractJsonStringValue(rawArgs, "code");
    return code ? (
      <CodeBlock
        label="正在编写脚本"
        language="typescript"
        code={code}
        streaming
        maxHeightClass="max-h-64"
      />
    ) : null;
  }

  // edit → 流式 diff
  if (toolName === "edit") {
    const { oldString, newString } = extractEditDiffParts(rawArgs);
    return <StreamingDiffBody filePath={filePath} oldString={oldString} newString={newString} />;
  }

  // write → 全部新增
  const content = extractJsonStringValue(rawArgs, "content");
  if (!content) {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>正在生成内容…</span>
      </div>
    );
  }
  return <StreamingWriteBody filePath={filePath} content={content} />;
}
