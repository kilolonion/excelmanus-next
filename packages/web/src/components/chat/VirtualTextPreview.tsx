import { cloneElement, type ReactElement, useLayoutEffect, useMemo, useRef, useState } from "react";

const ROW_HEIGHT = 20;
const OVERSCAN = 6;
export const VIRTUAL_TEXT_THRESHOLD = 400;

interface VirtualTextPreviewProps {
  count: number;
  renderRow: (index: number) => ReactElement;
  columns: number;
  height: number;
  expandedHeight: number;
  /** Identity changes when the streamed content changes, including same-line appends. */
  contentVersion: unknown;
  copies: { label: string; text: string }[];
  waiting?: boolean;
  initialScroll?: { following: boolean; rowOffset: number };
}

/** Fixed-height, unwrapped rows. Full rendering is an explicit user choice. */
export function VirtualTextPreview({
  count,
  renderRow,
  columns,
  height,
  expandedHeight,
  contentVersion,
  copies,
  waiting,
  initialScroll,
}: VirtualTextPreviewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(initialScroll?.following ?? true);
  const initialOffset = useRef((initialScroll?.rowOffset ?? 0) * ROW_HEIGHT);
  const [offset, setOffset] = useState(initialOffset.current);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const viewportHeight = expanded ? expandedHeight : height;
  const bottom = Math.max(0, count * ROW_HEIGHT - viewportHeight);
  const top = follow.current ? bottom : Math.min(offset, bottom);
  const start = full ? 0 : Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const end = full
    ? count
    : Math.min(count, Math.ceil((top + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  useLayoutEffect(() => {
    if (scroller.current && !follow.current) scroller.current.scrollTop = initialOffset.current;
    // Only seed the position when switching from the small, non-virtual preview.
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Entering the full view starts at the beginning for selection and browser Find.
    // Returning to the virtual view resumes the latest streamed row.
    if (follow.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollTop > bottom) el.scrollTop = bottom;
    setOffset(el.scrollTop);
  }, [contentVersion, count, viewportHeight, full, bottom]);

  const rows = useMemo(() => {
    // Content can change without changing the visible line count.
    void contentVersion;
    const next = [];
    for (let i = start; i < end; i++) next.push(cloneElement(renderRow(i), { key: i }));
    return next;
  }, [start, end, renderRow, contentVersion]);
  const spacer = (size: number, key: string) =>
    size > 0 ? (
      <tr key={key} aria-hidden="true">
        <td colSpan={columns} style={{ height: size, padding: 0, border: 0 }} />
      </tr>
    ) : null;
  return (
    <div>
      <div
        ref={scroller}
        role="region"
        aria-label={full ? "完整文本内容" : "文本预览（按可见行加载）"}
        tabIndex={0}
        className="overflow-auto overscroll-contain"
        style={{ height: Math.min(viewportHeight, count * ROW_HEIGHT), overflowAnchor: "none" }}
        onWheelCapture={(event) => {
          if (event.deltaY < 0) follow.current = false;
        }}
        onTouchStart={() => {
          follow.current = false;
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current = !full && el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
          if (!full) setOffset(el.scrollTop);
        }}
      >
        <table
          className="w-full font-mono text-[11px] border-collapse"
          style={{ lineHeight: `${ROW_HEIGHT}px` }}
        >
          <tbody>
            {spacer(start * ROW_HEIGHT, "before")}
            {rows}
            {spacer((count - end) * ROW_HEIGHT, "after")}
          </tbody>
        </table>
      </div>
      {waiting && (
        <div className="py-1 text-center text-[10px] text-muted-foreground">等待新内容...</div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-border/30 bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="hover:text-foreground"
        >
          {expanded ? "收起区域" : "展开更大区域"}
        </button>
        <button
          type="button"
          onClick={() => {
            follow.current = full;
            if (!full && scroller.current) scroller.current.scrollTop = 0;
            setOffset(0);
            setFull((value) => !value);
          }}
          className="hover:text-foreground"
        >
          {full ? "返回流式预览" : "查看完整内容"}
        </button>
        {copies.map(({ label, text }) => (
          <button
            key={label}
            type="button"
            className="hover:text-foreground"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopyStatus(`${label}：已复制`);
              } catch {
                setCopyStatus("复制失败，请在完整内容中选择并复制");
              }
            }}
          >
            {label}
          </button>
        ))}
        <span role="status">{copyStatus}</span>
      </div>
      <div className="px-2 py-1 text-[10px] text-muted-foreground/70">
        {full
          ? "完整内容已加载，可使用浏览器查找或选择文本。"
          : "浏览器查找和跨屏选择请使用「查看完整内容」。"}
      </div>
    </div>
  );
}
