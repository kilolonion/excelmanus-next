import { AnimatePresence, motion } from "framer-motion";
import { Brain, ChevronRight } from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createThinkingLineReader,
  formatThinkingDuration,
  type ThinkingSegment,
  thinkingPreview,
} from "@/lib/thinking";
import { cn } from "@/lib/utils";

interface ThinkingBlockProps {
  content: string;
  duration?: number;
  startedAt?: number;
  isActive?: boolean;
  title?: string;
  defaultExpanded?: boolean;
}

const FADE_MASK =
  "linear-gradient(to bottom, transparent 0%, black 14%, black 86%, transparent 100%)";
const ACTIVE_MAX_H = "6.5rem";
const AUTO_FOLLOW_THRESHOLD_PX = 12;

export function isNearScrollBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= AUTO_FOLLOW_THRESHOLD_PX;
}

export function ThinkingBlock({
  content,
  duration,
  startedAt,
  isActive = false,
  title,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [elapsed, setElapsed] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  // 流式内容默认跟随底部；一旦用户向上查看历史内容，就由用户接管滚动位置。
  const autoFollowRef = useRef(true);
  const lineReader = useRef<ReturnType<typeof createThinkingLineReader> | null>(null);
  const lineNodes = useRef<WeakMap<ThinkingSegment[], ReactNode> | null>(null);

  useEffect(() => {
    if (!isActive) return;
    const origin = startedAt ?? Date.now();
    const tick = () => setElapsed(Math.round((Date.now() - origin) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isActive, startedAt]);

  useEffect(() => {
    if (isActive) autoFollowRef.current = true;
  }, [isActive]);

  useLayoutEffect(() => {
    if (!isActive || !autoFollowRef.current) return;
    const frame = requestAnimationFrame(() => {
      const el = contentRef.current;
      if (autoFollowRef.current && el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [content, isActive]);

  const seconds = isActive ? elapsed : duration != null ? Math.round(duration) : 0;
  const durationStr = formatThinkingDuration(seconds);
  const heading = title ?? (isActive ? "思考中" : "思考完成");
  const showBody = (isActive || expanded) && !!content;
  const preview = useMemo(
    () => (!isActive && !expanded ? thinkingPreview(content) : ""),
    [content, isActive, expanded],
  );

  const body = useMemo(() => {
    if (!showBody) {
      lineReader.current = null;
      lineNodes.current = null;
      return null;
    }
    const read = (lineReader.current ??= createThinkingLineReader());
    const nodes = (lineNodes.current ??= new WeakMap<ThinkingSegment[], ReactNode>());
    return read(content).map((segments, lineIndex) => {
      const cached = nodes.get(segments);
      if (cached !== undefined) return cached;
      const node = (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && "\n"}
          {segments.map((seg, segIndex) =>
            seg.bold ? (
              <strong key={segIndex} className="font-semibold text-foreground">
                {seg.text}
              </strong>
            ) : (
              seg.text
            ),
          )}
        </Fragment>
      );
      nodes.set(segments, node);
      return node;
    });
  }, [content, showBody]);

  return (
    <div className="my-1 min-w-0">
      <button
        type="button"
        onClick={() => !isActive && setExpanded((v) => !v)}
        disabled={isActive}
        aria-expanded={isActive || expanded}
        aria-label={isActive ? heading : expanded ? "收起思考" : "展开思考"}
        className={cn("em-step-row", isActive && "cursor-default")}
      >
        <span className="em-step-icon">
          <Brain
            className={cn(
              "h-3.5 w-3.5 flex-shrink-0",
              isActive
                ? "text-muted-foreground animate-tool-running-pulse"
                : "text-muted-foreground",
            )}
          />
        </span>
        <span className="text-[13px] leading-5 text-foreground/85 whitespace-nowrap shrink-0">
          {heading}
        </span>
        {preview && (
          <span className="hidden sm:inline min-w-0 truncate text-[12px] text-muted-foreground">
            {preview}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          {durationStr && (
            <span className="text-[11px] tabular-nums text-muted-foreground">{durationStr}</span>
          )}
          {!isActive && <ChevronRight className="em-step-chevron h-3.5 w-3.5" />}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {showBody && (
          <motion.div
            key="thinking-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div
              ref={contentRef}
              onScroll={(event) => {
                const target = event.currentTarget;
                autoFollowRef.current = isNearScrollBottom(
                  target.scrollTop,
                  target.clientHeight,
                  target.scrollHeight,
                );
              }}
              onWheelCapture={(event) => {
                // scroll 事件可能晚于下一段流式内容到达，先记录向上滚动的用户意图。
                if (event.deltaY < 0) autoFollowRef.current = false;
              }}
              onTouchStart={() => {
                autoFollowRef.current = false;
              }}
              className={cn(
                "ml-1.5 border-l border-[var(--em-hairline)] pl-3.5 py-1 text-[12px] text-[var(--em-text-secondary)] whitespace-pre-wrap leading-relaxed break-words",
                "max-h-48 overflow-y-auto overscroll-contain",
                isActive && "scrollbar-none",
              )}
              style={
                isActive
                  ? {
                      maxHeight: ACTIVE_MAX_H,
                      maskImage: FADE_MASK,
                      WebkitMaskImage: FADE_MASK,
                    }
                  : undefined
              }
            >
              {body}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
