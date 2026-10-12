// 时间线上的系统条目：上下文压缩、环境变化说明、代理间消息、回退标记。居中细行，不抢正文。

import {
  ArrowLeftRight,
  ChevronDown,
  History,
  Info,
  Layers,
  MessageSquareShare,
} from "lucide-react";
import { useState } from "react";
import type { CompactionItem, InboxItem, NoticeItem, RewindItem } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";

function Line({
  icon: Icon,
  children,
  onClick,
  expandable,
  open,
}: {
  icon: typeof Info;
  children: React.ReactNode;
  onClick?: () => void;
  expandable?: boolean;
  open?: boolean;
}) {
  const content = (
    <>
      <span className="h-px flex-1 bg-[var(--em-hairline)]" aria-hidden />
      <span className="flex max-w-[80%] items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{children}</span>
        {expandable && (
          <ChevronDown
            className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")}
          />
        )}
      </span>
      <span className="h-px flex-1 bg-[var(--em-hairline)]" aria-hidden />
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 py-2 hover:[&>span:nth-child(2)]:text-foreground"
      aria-expanded={open}
    >
      {content}
    </button>
  ) : (
    <div className="flex w-full items-center gap-3 py-2">{content}</div>
  );
}

export function CompactionNotice({ item }: { item: CompactionItem }) {
  const [open, setOpen] = useState(false);
  const trigger =
    item.trigger === "manual"
      ? "手动压缩"
      : item.trigger === "overflow"
        ? "超出窗口后压缩"
        : "自动压缩";
  return (
    <div>
      <Line icon={Layers} onClick={() => setOpen((v) => !v)} expandable open={open}>
        {trigger}了上下文 · {item.beforeTokens.toLocaleString()} →{" "}
        {item.afterTokens.toLocaleString()} tokens{item.estimated ? "（估算）" : ""}
      </Line>
      {open && item.summary && (
        <p className="mx-auto mb-2 max-w-2xl rounded-lg bg-[var(--em-fill)] px-3 py-2 text-[12px] leading-5 whitespace-pre-wrap text-muted-foreground">
          {item.summary}
        </p>
      )}
    </div>
  );
}

export function ContextNotice({ item }: { item: NoticeItem }) {
  return <Line icon={Info}>{item.text}</Line>;
}

export function RewindNotice({ item }: { item: RewindItem }) {
  return <Line icon={History}>已从这里重新开始，之前的后续对话不再计入上下文（文件未回滚）</Line>;
}

/** 代理之间的消息：显示在接收方的时间线上。 */
export function InboxNotice({ item }: { item: InboxItem }) {
  const roster = useChatStore((s) => s.session.roster);
  const [open, setOpen] = useState(false);
  const name = (id: string) =>
    id === "user" ? "你" : (roster[id]?.name ?? (id === "main" ? "主代理" : id));
  const verb = item.inboxKind === "report" ? "汇报" : item.inboxKind === "notice" ? "通知" : "消息";
  return (
    <div className="my-1.5 rounded-lg bg-[var(--em-fill)] px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        {item.inboxKind === "report" ? (
          <MessageSquareShare className="h-3.5 w-3.5 shrink-0 text-[var(--em-primary)]" />
        ) : (
          <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground/85">{name(item.from)}</span> →{" "}
          {name(item.to)} 的{verb}
          {item.urgent && (
            <span className="ml-1.5 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">
              紧急
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <p
        className={cn(
          "mt-1 text-[12.5px] leading-5 whitespace-pre-wrap text-foreground/85",
          !open && "line-clamp-2",
        )}
      >
        {item.text}
      </p>
    </div>
  );
}
