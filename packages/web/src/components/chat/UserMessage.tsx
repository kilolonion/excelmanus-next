import { formatClock } from "@/lib/message-time";
// 用户消息气泡：点击编辑后从这里重新开始；附带的选区与图片、派发状态（排队 / 插话 / 失败）一并显示。

import type { AttachmentRef, ContextRef, DispatchMode } from "@excelmanus/protocol";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  CornerDownRight,
  Eye,
  Image as ImageIcon,
  Loader2,
  LocateFixed,
  Pencil,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { acquireAttachmentUrl } from "@/lib/attachment-urls";
import { cn } from "@/lib/utils";
import { focusRange } from "@/stores/workbook-store";
import { MentionHighlighter } from "./MentionHighlighter";

const MAX_COLLAPSED_HEIGHT = 200;

export type UserMessageState = "sending" | "failed" | "queued" | "sent" | "cancelled";

const MODE_LABEL: Partial<Record<DispatchMode, string>> = {
  steer: "插话",
  interrupt: "打断后发送",
};

function AttachmentThumb({ attachment }: { attachment: AttachmentRef }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    const preview = attachment.mediaType.startsWith("image/")
      ? acquireAttachmentUrl(attachment.sha256)
      : null;
    void preview?.url.then((u) => alive && setUrl(u)).catch(() => undefined);
    return () => {
      alive = false;
      preview?.release();
    };
  }, [attachment.sha256, attachment.mediaType]);
  if (!url)
    return (
      <span className="inline-flex h-6 max-w-[180px] items-center gap-1 rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
        <ImageIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{attachment.name}</span>
      </span>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={attachment.name}
      className="block overflow-hidden rounded-lg border border-[var(--em-hairline)] hover:opacity-90"
    >
      <img src={url} alt={attachment.name} className="h-16 w-16 object-cover" />
    </a>
  );
}

export interface UserMessageProps {
  text: string;
  at?: string;
  context: ContextRef[];
  attachments: AttachmentRef[];
  mode?: DispatchMode;
  skill?: string;
  /** 以问答 / 计划模式发出。 */
  chatMode?: "ask" | "plan";
  state: UserMessageState;
  error?: string;
  /** 从这条消息重新开始（编辑后重发）；不可用时不显示编辑入口。 */
  onRestart?: (text: string) => void;
  onCancelQueued?: () => void;
  onRetrySend?: () => void;
  onDiscard?: () => void;
}

export const UserMessage = React.memo(function UserMessage({
  text,
  at,
  context,
  attachments,
  mode,
  skill,
  chatMode,
  state,
  error,
  onRestart,
  onCancelQueued,
  onRetrySend,
  onDiscard,
}: UserMessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [expanded, setExpanded] = useState(false);
  const [needsExpand, setNeedsExpand] = useState(false);
  const [editWidth, setEditWidth] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editable = Boolean(onRestart) && state === "sent";

  useEffect(() => {
    if (contentRef.current) setNeedsExpand(contentRef.current.scrollHeight > MAX_COLLAPSED_HEIGHT);
  }, [text]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const naturalHeight = el.scrollHeight;
    el.style.height = `${Math.min(naturalHeight, 320)}px`;
    el.style.overflowY = naturalHeight > 320 ? "auto" : "hidden";
  }, []);
  useLayoutEffect(() => {
    if (editing) resize();
  }, [editing, draft, resize]);
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const startEdit = () => {
    if (!editable) return;
    setEditWidth(bubbleRef.current?.getBoundingClientRect().width ?? null);
    setDraft(text);
    setEditing(true);
  };
  const confirm = () => {
    const next = draft.trim();
    if (!next) return;
    setEditing(false);
    onRestart?.(next);
  };
  const clock = formatClock(at);

  return (
    <div className={cn("group flex justify-end py-2.5", state === "cancelled" && "opacity-60")}>
      <div className="flex min-w-0 max-w-[88%] items-start gap-2 sm:max-w-[75%]">
        <div className="flex w-max min-w-0 max-w-full flex-col items-end">
          {chatMode && (
            <span className="em-user-chatmode">
              {chatMode === "ask" ? (
                <Eye className="h-3 w-3" />
              ) : (
                <ClipboardList className="h-3 w-3" />
              )}
              {chatMode === "ask" ? "问答 · 只读" : "计划 · 不改文件"}
            </span>
          )}
          {skill && (
            <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-[var(--em-primary-alpha-10)] px-2 py-0.5 text-[11px] font-medium text-[var(--em-primary)]">
              <Sparkles className="h-3 w-3" />
              技能 · {skill}
            </span>
          )}
          {(text || editing) && (
            <div
              ref={bubbleRef}
              style={editing && editWidth ? { width: Math.max(editWidth, 240) } : undefined}
              className={cn(
                "user-bubble group/bubble relative w-fit max-w-full rounded-2xl border border-[var(--em-primary-alpha-20)] bg-[var(--em-primary-alpha-10)] px-3 py-2",
                editable &&
                  !editing &&
                  "cursor-pointer hover:border-[var(--em-primary-alpha-25)] hover:bg-[var(--em-primary-alpha-15)]",
                state === "failed" && "border-red-500/30 bg-red-500/[0.06]",
              )}
              onClick={editable && !editing ? startEdit : undefined}
              title={editable && !editing ? "点击编辑，从这里重新开始" : undefined}
            >
              {editing ? (
                <textarea
                  ref={textareaRef}
                  aria-label="编辑消息"
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(false);
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      confirm();
                    }
                  }}
                  className="block w-full min-w-0 resize-none border-0 bg-transparent p-0 text-[13px] leading-relaxed whitespace-pre-wrap break-words focus:outline-none"
                />
              ) : (
                <div
                  ref={contentRef}
                  className="overflow-hidden transition-[max-height] duration-300"
                  style={{
                    maxHeight: needsExpand && !expanded ? `${MAX_COLLAPSED_HEIGHT}px` : undefined,
                  }}
                >
                  <MentionHighlighter
                    text={text}
                    className="text-[13px] leading-relaxed whitespace-pre-wrap break-words"
                  />
                </div>
              )}
              {!editing && needsExpand && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded((v) => !v);
                  }}
                  className="mt-1 flex items-center gap-1 text-[11px] text-[var(--em-primary)]"
                >
                  {expanded ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  {expanded ? "收起" : "展开全部"}
                </button>
              )}
              {editable && !editing && (
                <span
                  className="touch-show-desktop absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background opacity-0 shadow-sm transition-opacity group-hover/bubble:opacity-100"
                  aria-hidden="true"
                >
                  <Pencil className="h-3 w-3 text-muted-foreground" />
                </span>
              )}
            </div>
          )}
          {editing && (
            <div className="mt-1.5 flex w-full items-center justify-end gap-1.5">
              <span className="mr-auto text-[11px] text-muted-foreground">
                将从这条消息重新开始（不回滚文件）
              </span>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/80"
              >
                <X className="h-3 w-3" />
                取消
              </button>
              <button
                type="button"
                onClick={confirm}
                className="inline-flex items-center gap-1 rounded-lg bg-[var(--em-primary)] px-2.5 py-1.5 text-xs font-medium text-white shadow-sm hover:opacity-90"
              >
                <Check className="h-3 w-3" />
                重新发送
              </button>
            </div>
          )}
          {(context.length > 0 || attachments.length > 0) && !editing && (
            <div className="mt-1.5 flex max-w-full flex-wrap justify-end gap-1">
              {context.map((ref) => (
                <button
                  key={`${ref.docId}:${ref.range}`}
                  type="button"
                  onClick={() => void focusRange(ref.range, { docId: ref.docId })}
                  className="inline-flex h-6 max-w-[220px] items-center gap-1 rounded-full bg-muted px-2 font-mono text-[11px] text-muted-foreground hover:text-[var(--em-primary)]"
                  title={`附带的选区（修订 ${ref.rev}）`}
                >
                  <LocateFixed className="h-3 w-3 shrink-0" />
                  <span className="truncate">{ref.range}</span>
                </button>
              ))}
              {attachments.map((a) => (
                <AttachmentThumb key={a.sha256} attachment={a} />
              ))}
            </div>
          )}
          {state === "sending" && (
            <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              发送中
            </span>
          )}
          {state === "queued" && (
            <span className="mt-1 inline-flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              {mode && MODE_LABEL[mode] ? `${MODE_LABEL[mode]} · ` : ""}排队中，当前步骤结束后处理
              {onCancelQueued && (
                <button
                  type="button"
                  onClick={onCancelQueued}
                  className="inline-flex items-center gap-0.5 font-medium text-[var(--em-primary)] hover:underline"
                >
                  <Undo2 className="h-3 w-3" />
                  撤回
                </button>
              )}
            </span>
          )}
          {state === "sent" && mode && MODE_LABEL[mode] && (
            <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
              <CornerDownRight className="h-3 w-3" />
              {MODE_LABEL[mode]}
            </span>
          )}
          {state === "cancelled" && (
            <span className="mt-1 text-[10.5px] text-muted-foreground">已撤回</span>
          )}
          {state === "failed" && (
            <span className="mt-1 inline-flex flex-wrap items-center justify-end gap-1.5 text-[11px] text-red-600 dark:text-red-400">
              <AlertCircle className="h-3 w-3" />
              {error ?? "发送失败"}
              {onRetrySend && (
                <button
                  type="button"
                  onClick={onRetrySend}
                  className="inline-flex items-center gap-0.5 font-medium hover:underline"
                >
                  <RotateCcw className="h-3 w-3" />
                  重试
                </button>
              )}
              {onDiscard && (
                <button
                  type="button"
                  onClick={onDiscard}
                  className="font-medium text-muted-foreground hover:underline"
                >
                  放回输入框
                </button>
              )}
            </span>
          )}
        </div>
        {clock && (
          <span className="flex-shrink-0 pt-2 text-[11px] tabular-nums text-muted-foreground/70">
            {clock}
          </span>
        )}
      </div>
    </div>
  );
});
