// 对话流：当前查看代理的时间线（用户消息、助手段落、系统条目）+ 排队中的消息 + 发送中的乐观消息。
// 历史行虚拟化；最新一行放在文档流里，流式增长不被估高裁切。

import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Layers } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import {
  agentBusy,
  pendingDispatches,
  rewindableFrom,
  visibleTimeline,
} from "@/lib/session/reducer";
import type { TimelineItem, TurnSegment, UserItem } from "@/lib/session/types";
import { messageEnterVariants } from "@/lib/sidebar-motion";
import {
  cancelQueuedMessage,
  compactNow,
  discardFailedMessage,
  type OptimisticMessage,
  resendFailedMessage,
  restartFrom,
  useChatStore,
} from "@/stores/chat-store";
import { AssistantMessage } from "./AssistantMessage";
import { type ChangedFile, RollbackConfirmDialog } from "./RollbackConfirmDialog";
import { CompactionNotice, ContextNotice, InboxNotice, RewindNotice } from "./SystemNotice";
import { UserMessage } from "./UserMessage";

const TIMESTAMP_GAP_MS = 5 * 60 * 1000;

type Row =
  | {
      key: string;
      kind: "timeline";
      item: TimelineItem;
      at: string;
      origin?: UserItem;
      /** 用户消息是在一轮进行中插入的（之后是同一轮的续段）。 */
      interjected?: boolean;
    }
  | { key: string; kind: "queued"; item: UserItem; at: string }
  | { key: string; kind: "optimistic"; item: OptimisticMessage; at: string };

function formatTimestamp(at: string): string {
  const date = new Date(at);
  const diff = Date.now() - date.getTime();
  const today = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function TimestampSeparator({ at }: { at: string }) {
  return (
    <div className="mx-auto flex max-w-4xl items-center justify-center px-3 py-1 sm:px-4">
      <span className="select-none text-[10px] text-muted-foreground/60">
        {formatTimestamp(at)}
      </span>
    </div>
  );
}

function RenderFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div className="rounded-lg bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
      这条内容渲染失败：{error.message}
      <button
        type="button"
        onClick={onReset}
        className="ml-2 underline underline-offset-2 hover:text-foreground"
      >
        重试
      </button>
    </div>
  );
}

/** 这条用户消息之后改过的文件（用于重新开始前的确认）。 */
function filesChangedAfter(seq: number, agentId: string): ChangedFile[] {
  const { session } = useChatStore.getState();
  const out = new Map<string, ChangedFile>();
  for (const change of session.changes) {
    if (change.seq <= seq || change.agentId !== agentId) continue;
    const prev = out.get(change.path);
    const cells = (prev?.detail ? Number.parseInt(prev.detail, 10) : 0) + change.cells;
    out.set(change.path, {
      path: change.path,
      kind: "workbook",
      detail: cells > 0 ? `${cells} 格` : "结构修改",
    });
  }
  for (const tool of Object.values(session.tools)) {
    if (tool.seq <= seq || tool.agentId !== agentId || tool.status !== "ok") continue;
    if (tool.name !== "write" && tool.name !== "edit") continue;
    const path = (tool.args as { path?: unknown })?.path;
    if (typeof path === "string" && !out.has(path))
      out.set(path, { path, kind: "text", detail: tool.name === "write" ? "写入" : "替换" });
  }
  return [...out.values()];
}

const RowView = memo(function RowView({
  row,
  isLatest,
  canRestart,
  onRestart,
}: {
  row: Row;
  isLatest: boolean;
  canRestart: (origin: UserItem) => boolean;
  onRestart: (origin: UserItem, opts: { text?: string; modelProfileId?: string }) => void;
}) {
  if (row.kind === "optimistic") {
    const o = row.item;
    return (
      <UserMessage
        text={o.text}
        at={o.at}
        context={o.context}
        attachments={o.attachments}
        state={o.error ? "failed" : "sending"}
        {...(o.error ? { error: o.error } : {})}
        onRetrySend={() => void resendFailedMessage(o.clientMessageId)}
        onDiscard={() => discardFailedMessage(o.clientMessageId)}
      />
    );
  }
  if (row.kind === "queued") {
    const u = row.item;
    return (
      <UserMessage
        text={u.text}
        at={u.at}
        context={u.context}
        attachments={u.attachments}
        mode={u.mode}
        state={u.status === "cancelled" ? "cancelled" : "queued"}
        onCancelQueued={() =>
          void cancelQueuedMessage(u).catch((error: unknown) =>
            toast({ tone: "error", title: errorMessage(error, "撤回失败") }),
          )
        }
      />
    );
  }
  const item = row.item;
  switch (item.kind) {
    case "user":
      return (
        <UserMessage
          text={item.text}
          at={item.at}
          context={item.context}
          attachments={item.attachments}
          // 只有真正插进进行中任务的消息才标注派发方式
          {...(row.interjected ? { mode: item.mode } : {})}
          {...(item.skill ? { skill: item.skill } : {})}
          {...(item.chatMode ? { chatMode: item.chatMode } : {})}
          state={item.status === "failed" ? "failed" : "sent"}
          {...(canRestart(item) ? { onRestart: (text: string) => onRestart(item, { text }) } : {})}
        />
      );
    case "turn": {
      const origin = row.origin;
      const restartable = origin && canRestart(origin);
      return (
        <AssistantMessage
          segment={item as TurnSegment}
          isLatest={isLatest}
          {...(restartable
            ? {
                onRetry: () => onRestart(origin, {}),
                onRetryWithModel: (modelProfileId: string) => onRestart(origin, { modelProfileId }),
              }
            : {})}
          onCompact={() => void compactNow(item.agentId).catch(() => undefined)}
        />
      );
    }
    case "compaction":
      return <CompactionNotice item={item} />;
    case "notice":
      return <ContextNotice item={item} />;
    case "inbox":
      return <InboxNotice item={item} />;
    case "rewind":
      return <RewindNotice item={item} />;
  }
});

export function MessageStream() {
  const session = useChatStore((s) => s.session);
  const agentId = useChatStore((s) => s.viewAgentId);
  const optimistic = useChatStore((s) => s.optimistic);
  const sessionId = useChatStore((s) => s.sessionId);
  const compacting = useChatStore((s) => s.compacting[s.viewAgentId] === true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const sizeCache = useRef(new Map<string, number>());
  const seenKeys = useRef(new Set<string>());
  const autoScrollRef = useRef(true);
  const lastScrollTop = useRef(0);
  const positioning = useRef(false);
  const initialDone = useRef(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [confirm, setConfirm] = useState<{
    origin: UserItem;
    opts: { text?: string; modelProfileId?: string };
    files: ChangedFile[];
  } | null>(null);

  const timeline = visibleTimeline(session, agentId);
  const queued = pendingDispatches(session, agentId);
  const busy = agentBusy(session, agentId);
  const restartFloor = rewindableFrom(session, agentId);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const origins = new Map<string, UserItem>();
    let lastUser: UserItem | undefined;
    for (const [index, item] of timeline.entries()) {
      if (item.kind === "user") lastUser = item;
      const next = item.kind === "user" ? timeline[index + 1] : undefined;
      const prev = item.kind === "user" ? timeline[index - 1] : undefined;
      const interjected =
        (next?.kind === "turn" && next.segment > 0) ||
        (item.kind === "user" &&
          item.mode === "interrupt" &&
          prev?.kind === "turn" &&
          prev.status === "interrupted");
      if (item.kind === "turn" && !origins.has(item.turnId) && lastUser)
        origins.set(item.turnId, lastUser);
      out.push({
        key: `${item.kind}:${item.id}`,
        kind: "timeline",
        item,
        at: item.at,
        ...(item.kind === "turn" && origins.get(item.turnId)
          ? { origin: origins.get(item.turnId) }
          : {}),
        ...(interjected ? { interjected: true } : {}),
      });
    }
    for (const q of queued) out.push({ key: `queued:${q.id}`, kind: "queued", item: q, at: q.at });
    for (const o of optimistic)
      if (o.agentId === agentId)
        out.push({ key: `opt:${o.clientMessageId}`, kind: "optimistic", item: o, at: o.at });
    return out;
  }, [timeline, queued, optimistic, agentId]);

  const timestamps = useMemo(() => {
    const set = new Set<number>();
    rows.forEach((row, i) => {
      if (i === 0) {
        set.add(0);
        return;
      }
      const prev = Date.parse(rows[i - 1]?.at ?? "");
      const cur = Date.parse(row.at);
      if (Number.isFinite(prev) && Number.isFinite(cur) && cur - prev >= TIMESTAMP_GAP_MS)
        set.add(i);
    });
    return set;
  }, [rows]);

  const canRestart = useCallback(
    (origin: UserItem) => !busy && origin.seq > restartFloor && origin.status === "applied",
    [busy, restartFloor],
  );

  const onRestart = useCallback(
    (origin: UserItem, opts: { text?: string; modelProfileId?: string }) => {
      const files = filesChangedAfter(origin.seq, origin.agentId);
      if (files.length > 0) setConfirm({ origin, opts, files });
      else void restartFrom(origin, opts);
    },
    [],
  );

  const pinned = rows.at(-1) ?? null;
  const virtualRows = rows.slice(0, -1);
  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (i) => virtualRows[i]?.key ?? i,
    estimateSize: (i) => {
      const row = virtualRows[i];
      const cached = row ? sizeCache.current.get(row.key) : undefined;
      if (cached) return cached;
      const base =
        row?.kind === "timeline" && row.item.kind === "turn"
          ? 160
          : row?.kind === "timeline" && row.item.kind !== "user"
            ? 36
            : 72;
      return timestamps.has(i) ? base + 22 : base;
    },
    overscan: 6,
    paddingStart: 24,
  });

  // 会话或查看的代理切换：重置滚动状态
  useEffect(() => {
    seenKeys.current = new Set();
    sizeCache.current = new Map();
    autoScrollRef.current = true;
    initialDone.current = false;
    setAutoScroll(true);
  }, [sessionId, agentId]);

  const scrollToEnd = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollTop = vp.scrollHeight;
    lastScrollTop.current = vp.scrollTop;
  }, []);

  // 首次有内容时直接定位到底部（不播放入场动画）
  useLayoutEffect(() => {
    if (rows.length === 0 || initialDone.current) return;
    initialDone.current = true;
    for (const row of rows) seenKeys.current.add(row.key);
    positioning.current = true;
    scrollToEnd();
    requestAnimationFrame(() => {
      scrollToEnd();
      positioning.current = false;
    });
  }, [rows, scrollToEnd]);

  // 新行或流式增长：跟随到底部（用户上翻后不打扰）
  const tick = useChatStore((s) => {
    const live = s.session.live[agentId];
    return `${rows.length}:${live?.text.length ?? 0}:${live?.reasoning.length ?? 0}:${Object.keys(live?.toolArgs ?? {}).length}:${s.session.cursor}`;
  });
  useLayoutEffect(() => {
    if (!autoScrollRef.current || !initialDone.current) return;
    scrollToEnd();
  }, [tick, scrollToEnd]);

  // 最新行的高度写回缓存，它进入虚拟区时不跳动
  useLayoutEffect(() => {
    const el = pinnedRef.current;
    if (!el || !pinned) return;
    const write = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) sizeCache.current.set(pinned.key, h);
      if (autoScrollRef.current && initialDone.current) scrollToEnd();
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pinned, scrollToEnd]);

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [pinned?.key, virtualRows.length, virtualizer]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (positioning.current) return;
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    const movedUp = scrollTop < lastScrollTop.current - 1;
    const atBottom = scrollHeight - scrollTop - clientHeight <= 24;
    const next = !movedUp && (autoScrollRef.current || atBottom);
    lastScrollTop.current = scrollTop;
    autoScrollRef.current = next;
    setAutoScroll(next);
  }, []);

  const renderRow = (row: Row, index: number, isLatest: boolean) => {
    const isNew = !seenKeys.current.has(row.key);
    if (isNew) seenKeys.current.add(row.key);
    return (
      <>
        {timestamps.has(index) && <TimestampSeparator at={row.at} />}
        <motion.div
          className="mx-auto max-w-4xl px-3 sm:px-4"
          variants={messageEnterVariants}
          initial={isNew ? "initial" : false}
          animate="animate"
        >
          <ErrorBoundary
            resetKey={row.key}
            fallback={(error, reset) => <RenderFallback error={error} onReset={reset} />}
          >
            <RowView row={row} isLatest={isLatest} canRestart={canRestart} onRestart={onRestart} />
          </ErrorBoundary>
        </motion.div>
      </>
    );
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollArea
        className="min-h-0 flex-1"
        viewportRef={viewportRef}
        onViewportScroll={handleScroll}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = virtualRows[v.index];
            if (!row) return null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={v.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${v.start}px)`,
                }}
              >
                {renderRow(row, v.index, false)}
              </div>
            );
          })}
        </div>
        {pinned && (
          <div ref={pinnedRef} className="relative w-full pb-6">
            {renderRow(pinned, rows.length - 1, true)}
          </div>
        )}
        {compacting && (
          <div className="em-compacting-line" role="status">
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            正在压缩上下文，完成后继续当前任务…
          </div>
        )}
      </ScrollArea>

      <AnimatePresence>
        {!autoScroll && rows.length > 0 && (
          <motion.button
            key="scroll-fab"
            type="button"
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={() => {
              autoScrollRef.current = true;
              setAutoScroll(true);
              scrollToEnd();
            }}
            className="absolute bottom-4 left-1/2 z-20 flex min-h-[40px] -translate-x-1/2 items-center justify-center gap-1.5 rounded-full border border-border/60 bg-background/90 px-4 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur-sm transition-[color,border-color,box-shadow] hover:border-[var(--em-primary-alpha-20)] hover:text-foreground hover:shadow-xl"
          >
            <ArrowDown className="h-3 w-3" />
            回到底部
          </motion.button>
        )}
      </AnimatePresence>

      <RollbackConfirmDialog
        open={confirm !== null}
        files={confirm?.files ?? []}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c) void restartFrom(c.origin, c.opts);
        }}
      />
    </div>
  );
}
