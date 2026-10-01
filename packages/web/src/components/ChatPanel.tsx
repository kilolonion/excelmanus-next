import { useEffect, useRef, useState } from "react";
import { COMPOSER_INPUT_ID, COMPOSER_SUGGEST_ID, focusComposer } from "../dom-ids.ts";
import { renderMarkdown, renderPlainText } from "../md.ts";
import {
  agentView,
  type DisplayItem,
  displayItems,
  isInternalGroup,
  queueAhead,
  queuedCount,
  type SessionState,
  type ToolCard,
  type UiMessage,
} from "../reduce.ts";
import {
  addComposerFiles,
  attachmentUrl,
  cancelDispatch,
  compactNow,
  composerContext,
  dismissContext,
  focusRange,
  openDocument,
  pinSelection,
  previewRange,
  removeComposerAttachment,
  renameSession,
  resumeAgent,
  selectAgent,
  send,
  setLayout,
  setSessionPermission,
  setSettingsOpen,
  stopAgent,
  switchModel,
  undoMemory,
  useApp,
} from "../store.ts";
import { S, toolTitle } from "../strings.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Interactions } from "./Interactions.tsx";
import { Onboarding } from "./Onboarding.tsx";
import {
  type SuggestItem,
  SuggestList,
  suggestOptionId,
  triggerAt,
  useSuggestions,
} from "./Suggest.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import {
  Alert,
  AlertActions,
  AlertTitle,
  Badge,
  Card,
  EmptyState,
  RangeChip,
  statusTone,
} from "./ui/display.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input, Textarea } from "./ui/input.tsx";
import { Disclosure, ScrollArea } from "./ui/overlay.tsx";
import { SimpleSelect } from "./ui/select.tsx";
import { Dots, Spinner } from "./ui/spinner.tsx";
import { Tip } from "./ui/tooltip.tsx";

const TOOL_STATUS: Record<ToolCard["status"], string> = {
  pending: S.toolRunning,
  ok: S.toolOk,
  error: S.toolError,
  not_executed: S.toolNotExecuted,
  cancelled: S.toolCancelled,
  uncertain: S.toolUncertain,
};

type DispatchMode = "steer" | "interrupt" | "queue";
const DISPATCH_MODES: { value: DispatchMode; label: string }[] = [
  { value: "steer", label: S.modeSteer },
  { value: "interrupt", label: S.modeInterrupt },
  { value: "queue", label: S.modeQueue },
];

/** 用户消息下方的派发状态文案（02 §3.2）；accepted 不显示。 */
function dispatchLabel(s: SessionState, m: UiMessage): string | null {
  if (m.role !== "user" || m.dispatchStatus === undefined || m.dispatchStatus === "accepted") {
    return null;
  }
  switch (m.dispatchStatus) {
    case "queued":
      if (m.mode === "interrupt") return S.dispatchQueuedInterrupt;
      if (m.mode === "queue") return S.dispatchQueuedQueue(queueAhead(s, m));
      return S.dispatchQueuedSteer;
    case "applied":
      return S.dispatchApplied;
    case "cancelled":
      return S.dispatchCancelled;
    case "failed":
      return S.dispatchFailed;
  }
}

const TOOL_ICON: Record<ToolCard["status"], IconName> = {
  pending: "clock",
  ok: "check",
  error: "alert",
  not_executed: "info",
  cancelled: "x",
  uncertain: "alert",
};

const TONE_CIRCLE: Record<string, string> = {
  ok: "bg-ok-soft text-ok-ink",
  err: "bg-destructive-soft text-destructive-ink",
  warn: "bg-warn-soft text-warn-ink",
  read: "bg-read-soft text-read-ink",
  neutral: "bg-muted text-muted-foreground",
};

function toolTone(status: ToolCard["status"]) {
  return status === "pending" ? "read" : statusTone(status);
}

function ToolCardView({ card }: { card: ToolCard }) {
  const hasArgs = card.args !== undefined && card.args !== "" && card.args !== "{}";
  const hasResult = card.resultSummary !== undefined && card.resultSummary !== "";
  const tone = toolTone(card.status);
  return (
    <Card elevation="raised" className="flex flex-col gap-2 rounded-xl px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className={cn("flex size-5 items-center justify-center rounded-full", TONE_CIRCLE[tone])}
          aria-hidden="true"
        >
          {card.status === "pending" ? (
            <Spinner size="xs" />
          ) : (
            <Icon name={TOOL_ICON[card.status]} size="xs" />
          )}
        </span>
        <span className="text-sm font-medium">{toolTitle(card.name)}</span>
        {card.targets !== undefined && card.targets.length > 0 && (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {card.targets.slice(0, 3).map((t) => (
              <RangeChip key={t} range={t} tone="read" noIcon />
            ))}
            {card.targets.length > 3 && (
              <span className="text-xs text-muted-foreground">+{card.targets.length - 3}</span>
            )}
          </span>
        )}
        <span className="flex-1" />
        {card.durationMs !== undefined && card.status !== "pending" && (
          <Tip content={S.toolDurationHint}>
            <span className="font-mono text-2xs text-muted-foreground tabular-nums">
              {S.duration(card.durationMs)}
            </span>
          </Tip>
        )}
        <Badge tone={tone}>{TOOL_STATUS[card.status]}</Badge>
      </div>
      {card.status === "uncertain" && (
        <Alert layout="inline" tone="warn">
          {S.uncertainHint}
        </Alert>
      )}
      {card.status === "not_executed" && (
        <Alert layout="inline" tone="muted">
          {S.notExecutedHint}
        </Alert>
      )}
      {card.status === "ok" && card.headline && (
        <div className="text-xs text-muted-foreground">
          <MessageBody text={card.headline} docId={card.docId} plain />
        </div>
      )}
      {hasResult && card.status !== "ok" && (
        <div className="text-xs text-foreground-secondary">
          <MessageBody text={card.resultSummary as string} docId={card.docId} plain />
        </div>
      )}
      {(hasArgs || (hasResult && card.status === "ok") || card.docId) && (
        <div className="flex flex-wrap items-start justify-between gap-2 border-t border-border pt-2">
          {(hasArgs || hasResult) && (
            <Disclosure
              className="flex-1"
              summary={
                <>
                  {S.toolDetails}
                  <span className="font-mono"> · {card.name}</span>
                </>
              }
              contentClassName="flex flex-col gap-2"
            >
              {hasArgs && (
                <div className="flex flex-col gap-1">
                  <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    {S.toolArgs}
                  </span>
                  <div className="max-h-80 overflow-auto rounded-md bg-muted p-2.5 font-mono text-xs">
                    <MessageBody text={card.args as string} docId={card.docId} plain />
                  </div>
                </div>
              )}
              {hasResult && (
                <div className="flex flex-col gap-1">
                  <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    {S.toolResult}
                  </span>
                  <div className="max-h-80 overflow-auto rounded-md bg-muted p-2.5 font-mono text-xs">
                    <MessageBody text={card.resultSummary as string} docId={card.docId} plain />
                  </div>
                </div>
              )}
            </Disclosure>
          )}
          {card.docId && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void openDocument(card.docId as string).catch(() =>
                  useApp.setState({ referenceError: "invalid-range" }),
                )
              }
            >
              <Icon name="sheet" size="xs" />
              {S.openWorkbook}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** 输入框上方的上下文徽标（02 §3.3）：选区自动跟随，可钉住或移除。 */
function ContextChips() {
  const doc = useApp((s) => s.doc);
  const pinned = useApp((s) => s.pinnedSelection);
  const ctx = useApp((s) => composerContext(s));
  if (!ctx) return null;
  const name = doc && doc.docId === ctx.docId ? doc.path.split(/[\\/]/).pop() : null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
      <RangeChip
        range={ctx.range}
        file={name}
        tone={pinned ? "pinned" : "selected"}
        actions={
          <>
            <IconButton
              icon={pinned ? "pinOff" : "pin"}
              size="icon-xs"
              className="size-5"
              label={pinned ? S.unpinSelection : S.pinSelection}
              pressed={pinned !== null}
              onClick={() => pinSelection(pinned === null)}
            />
            <IconButton
              icon="x"
              size="icon-xs"
              className="size-5"
              label={S.removeContext}
              onClick={dismissContext}
            />
          </>
        }
      />
    </div>
  );
}

/** 输入框上方的图片附件（02 §3.3）：上传中/失败可见，可移除。 */
function AttachmentStrip() {
  const items = useApp((s) => s.composerAttachments);
  const visionOff = useApp((s) => {
    const id =
      s.session.roster[s.agentId]?.modelProfileId ?? s.profiles.find((p) => p.isDefault)?.id;
    return s.profiles.find((p) => p.id === id)?.capabilities?.vision?.value === false;
  });
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2 px-3 pt-2.5">
      {items.map((a) => (
        <Tip key={a.id} content={a.error ?? a.name}>
          <span
            className={cn(
              "relative size-14 overflow-hidden rounded-md border border-border bg-muted",
              a.status === "error" && "border-destructive",
            )}
          >
            <img src={a.previewUrl} alt={a.name} className="size-full object-cover" />
            {a.status === "uploading" && (
              <span className="absolute inset-0 grid place-items-center bg-card/70" role="status">
                <Spinner size="sm" />
                <span className="sr-only">{S.attachUploading}</span>
              </span>
            )}
            {a.status === "error" && (
              <span
                className="absolute inset-0 grid place-items-center bg-destructive-soft/80 text-destructive"
                role="alert"
              >
                <Icon name="alert" size="sm" />
                <span className="sr-only">{S.attachFailed}</span>
              </span>
            )}
            <button
              type="button"
              className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={`${S.removeAttachment}：${a.name}`}
              onClick={() => removeComposerAttachment(a.id)}
            >
              <Icon name="x" size="xs" />
            </button>
          </span>
        </Tip>
      ))}
      {visionOff && <span className="text-xs text-muted-foreground">{S.imageNotSentHint}</span>}
    </div>
  );
}

/** 已发送消息里的附件缩略图（带令牌取图）。 */
function MessageAttachment({ sha256, name }: { sha256: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void attachmentUrl(sha256)
      .then((u) => alive && setUrl(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sha256]);
  return (
    <Tip content={name}>
      <span className="grid size-20 place-items-center overflow-hidden rounded-md border border-border bg-muted">
        {url ? (
          <img src={url} alt={name} className="size-full object-cover" />
        ) : (
          <Icon name="file" size="md" />
        )}
      </span>
    </Tip>
  );
}

/** 会话标题：点编辑按钮改名，Enter 保存、Esc 取消（对齐清单 C6）。 */
function SessionTitle({ title, editable }: { title: string; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [failed, setFailed] = useState(false);
  if (editing) {
    const commit = () => {
      setEditing(false);
      if (value.trim() !== "" && value.trim() !== title)
        void renameSession(value).catch(() => setFailed(true));
    };
    return (
      <Input
        size="sm"
        className="max-w-72"
        aria-label={S.renameSession}
        // biome-ignore lint/a11y/noAutofocus: 进入改名后直接输入
        autoFocus
        value={value}
        maxLength={80}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div className="group/title flex min-w-16 flex-1 items-center gap-1">
      <Tip content={failed ? S.renameFailed : title} side="bottom">
        <h1 className={cn("min-w-0 truncate text-md font-semibold", failed && "text-destructive")}>
          {title}
        </h1>
      </Tip>
      {editable && (
        <IconButton
          icon="pencil"
          size="icon-xs"
          label={S.renameSession}
          className="opacity-60 group-hover/title:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            setValue(title);
            setFailed(false);
            setEditing(true);
          }}
        />
      )}
    </div>
  );
}

/** 头部的模型档案与会话权限选择（09 §3、04 §5）。数值只来自档案与会话记录。 */
function HeaderControls() {
  const profiles = useApp((s) => s.profiles);
  const agentId = useApp((s) => s.agentId);
  const current = useApp((s) => s.session.roster[s.agentId]?.modelProfileId ?? null);
  const permission = useApp(
    (s) =>
      s.session.permissionMode ??
      s.sessions.find((x) => x.id === s.sessionId)?.permissionMode ??
      null,
  );
  const [err, setErr] = useState(false);
  if (profiles.length === 0) return null;
  const selected = current ?? profiles.find((p) => p.isDefault)?.id ?? "";
  return (
    <>
      <SimpleSelect
        value={selected}
        onChange={(v) => {
          setErr(false);
          void switchModel(v).catch(() => setErr(true));
        }}
        options={profiles.map((p) => ({ value: p.id, label: p.name }))}
        ariaLabel={err ? `${S.modelSelectHint}（${S.modelSwitchFailed}）` : S.modelSelectHint}
        variant="ghost"
        size="xs"
        icon="cpu"
        className={cn("max-w-36", err && "text-destructive")}
      />
      {agentId === "main" && permission !== null && (
        <SimpleSelect
          value={permission}
          onChange={(v) =>
            void setSessionPermission(v as "confirm" | "standard" | "auto").catch(() =>
              setErr(true),
            )
          }
          options={(["confirm", "standard", "auto"] as const).map((v) => ({
            value: v,
            label: S.permissionLabel[v] ?? v,
          }))}
          ariaLabel={S.permissionSelectHint}
          variant="ghost"
          size="xs"
          icon="shield"
        />
      )}
    </>
  );
}

/** HH:mm（本地时区）；跨天时加月日。 */
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString(S.locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : S.monthDayTime(d.getMonth() + 1, d.getDate(), hm);
}

/** 已打开文档才知道文件名；其余只显示区域。 */
function docName(docId: string): string | null {
  const doc = useApp.getState().doc;
  return doc && doc.docId === docId ? (doc.path.split(/[\\/]/).pop() ?? null) : null;
}

const isStreaming = (it: DisplayItem) => !("kind" in it) && it.id === "streaming";

/** 思考块（02 §3.1）：默认折叠，只展示模型实际返回的内容。 */
function Reasoning({ text, live = false, ms }: { text: string; live?: boolean; ms?: number }) {
  return (
    <Disclosure
      variant="chip"
      icon={live ? <Spinner size="xs" /> : <Icon name="sparkle" size="xs" />}
      summary={live ? S.thinkingLive : ms !== undefined ? S.thoughtFor(ms) : S.thinking}
    >
      <div className="ml-3 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-foreground-secondary">
        {text}
      </div>
    </Disclosure>
  );
}

function EmptyChat({ onPick }: { onPick: (t: string) => void }) {
  return (
    <EmptyState
      size="page"
      icon="sheet"
      title={S.emptyChatTitle}
      description={S.emptyChatHint}
      action={
        <div className="mt-2 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
          {S.emptyChatExamples.map((t) => (
            <Button
              key={t}
              variant="outline"
              className="h-auto min-h-10 justify-start py-2 text-left whitespace-normal"
              onClick={() => onPick(t)}
            >
              <Icon name="sparkle" size="sm" className="text-read" />
              <span className="text-sm font-normal">{t}</span>
            </Button>
          ))}
        </div>
      }
    />
  );
}

function MessageBody({
  text,
  plain = false,
  docId,
}: {
  text: string;
  plain?: boolean;
  docId?: string;
}) {
  // renderMarkdown 已经 DOMPurify 消毒（见 md.ts），此处输出是受信 HTML
  const html = plain ? renderPlainText(text) : renderMarkdown(text);
  const reference = (target: EventTarget): string | null => {
    const a = target instanceof Element ? target.closest("a") : null;
    const href = a?.getAttribute("href");
    if (!href?.startsWith("#range=")) return null;
    try {
      return decodeURIComponent(href.slice(7));
    } catch {
      return null;
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithMouseEvents: 区域引用链接的事件委托（点击/悬停预览），链接本身非交互元素
    <div
      // HTML 已按白名单消毒（md.ts），经 ref 注入而非 dangerouslySetInnerHTML
      ref={(el) => {
        if (el && el.dataset.html !== html) {
          el.dataset.html = html;
          el.innerHTML = html;
        }
      }}
      className="md"
      role="presentation"
      onClick={(e) => {
        const range = reference(e.target);
        if (range) {
          e.preventDefault();
          void focusRange(range, docId);
        }
      }}
      onKeyDown={(e) => {
        const range = reference(e.target);
        if (e.key === "Enter" && range) {
          e.preventDefault();
          void focusRange(range, docId);
        }
      }}
      onMouseOver={(e) =>
        previewRange(!docId || docId === useApp.getState().doc?.docId ? reference(e.target) : null)
      }
      onMouseLeave={() => previewRange(null)}
    />
  );
}

function InternalLine({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="text-foreground-secondary">
        <MessageBody text={text} plain />
      </div>
    </div>
  );
}

export function ChatPanel({ sidebarToggle = false }: { sidebarToggle?: boolean }) {
  const session = useApp((s) => s.session);
  const sessionId = useApp((s) => s.sessionId);
  const agentId = useApp((s) => s.agentId);
  const referenceError = useApp((s) => s.referenceError);
  const commandNotice = useApp((s) => s.commandNotice);
  const roster = useApp((s) => s.session.roster);
  // 02 §3.3：输入草稿按会话保存在本地，刷新不丢
  const draftKey = `excelmanus.draft.${sessionId ?? ""}.${agentId}`;
  const [text, setTextRaw] = useState(() => localStorage.getItem(draftKey) ?? "");
  const setText = (v: string | ((cur: string) => string)) =>
    setTextRaw((cur) => {
      const next = typeof v === "function" ? v(cur) : v;
      if (next === "") localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, next);
      return next;
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换会话/代理时载入对应草稿
  useEffect(() => {
    setTextRaw(localStorage.getItem(draftKey) ?? "");
  }, [draftKey]);
  const [mode, setMode] = useState<DispatchMode>("steer");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = useApp((st) => st.composerAttachments.some((a) => a.status === "uploading"));
  const hasAttachment = useApp((st) => st.composerAttachments.some((a) => a.status === "ready"));
  // 拖入表格文件后由 store 要求追加 @路径（02 §3.3）
  const append = useApp((st) => st.composerAppend);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只响应 nonce 变化
  useEffect(() => {
    if (!append) return;
    setText((cur) => (cur === "" || /\s$/.test(cur) ? cur : `${cur} `) + append.text);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [append?.nonce]);
  const [caret, setCaret] = useState(0);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [suggestClosed, setSuggestClosed] = useState(false);
  const trigger = suggestClosed ? null : triggerAt(text, caret);
  const suggestions = useSuggestions(trigger);
  const pickSuggestion = (it: SuggestItem) => {
    if (!trigger) return;
    let next = text.slice(0, trigger.start) + it.insert + text.slice(caret);
    let pos = trigger.start + it.insert.length;
    if (it.prefix && !next.startsWith("/")) {
      next = it.prefix + next;
      pos += it.prefix.length;
    }
    it.apply?.();
    setText(next);
    setSuggestIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };
  const [sendFailed, setSendFailed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const view = agentView(session, agentId);
  const items = displayItems(view);
  const agentRunning = view.running;
  const queued = queuedCount(session, agentId);
  const viewingName = roster[agentId]?.name ?? agentId;
  const hasDoc = useApp((st) => st.doc !== null);
  const tableCollapsed = useApp((st) => st.layout.tableCollapsed);
  const hasModelProfile = useApp((st) => st.hasModelProfile);
  const onboarding = useApp((st) => st.onboardingOpen);
  const internalLabel = (m: UiMessage) =>
    m.internal
      ? S.internalLine(
          roster[m.internal.from]?.name ?? m.internal.from,
          roster[m.internal.to]?.name ?? m.internal.to,
          m.internal.kind,
        )
      : "";

  const renderItem = (item: DisplayItem) => {
    if (isInternalGroup(item)) {
      return (
        <Disclosure key={item.id} summary={S.internalMessages(item.messages.length)}>
          <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
            {item.messages.map((m) => (
              <InternalLine key={m.id} label={internalLabel(m)} text={m.text} />
            ))}
          </div>
        </Disclosure>
      );
    }
    if ("kind" in item) return <ToolCardView key={`tool-${item.toolCallId}`} card={item} />;
    if (item.role === "internal") {
      return (
        <div key={item.id} className="border-l-2 border-border pl-3">
          <InternalLine label={internalLabel(item)} text={item.text} />
        </div>
      );
    }
    if (item.role === "memory" && item.memory) {
      const mem = item.memory;
      return (
        <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="neutral">
            <Icon name="brain" size="xs" />
            {S.memorySaved}
          </Badge>
          <span className={mem.deleted ? "text-muted-foreground line-through" : ""}>
            {item.text}
          </span>
          {!mem.deleted && (
            <Button size="xs" variant="ghost" onClick={() => void undoMemory(mem.memoryId)}>
              {S.undo}
            </Button>
          )}
          {mem.deleted && <span className="text-xs text-muted-foreground">{S.memoryUndone}</span>}
        </div>
      );
    }
    if (item.role === "notice") {
      return (
        <Disclosure key={item.id} summary={S.noticeLabel(item.noticeKind ?? "")}>
          <div className="text-xs text-muted-foreground">
            <MessageBody text={item.text} plain />
          </div>
        </Disclosure>
      );
    }
    if (item.role === "compaction") {
      return (
        <Disclosure
          key={item.id}
          icon={<Icon name="history" size="xs" />}
          summary={
            item.compaction
              ? S.compactBlockLabel(
                  item.compaction.beforeTokens,
                  item.compaction.afterTokens,
                  item.compaction.estimated,
                )
              : S.compactDone
          }
        >
          <div className="rounded-lg border border-border bg-muted p-3 text-sm">
            <MessageBody text={item.text} />
          </div>
        </Disclosure>
      );
    }
    const isUser = item.role === "user";
    const footer = (() => {
      const label = dispatchLabel(session, item);
      const recallable = item.dispatchStatus === "queued" || item.dispatchStatus === "accepted";
      const time = isUser && item.at ? clockTime(item.at) : null;
      if (label === null && !recallable && time === null) return null;
      return (
        <div
          className={cn(
            "flex items-center gap-2 text-2xs text-muted-foreground",
            isUser && "justify-end",
          )}
        >
          {time !== null && <time dateTime={item.at}>{time}</time>}
          {label !== null && <span>{label}</span>}
          {recallable && (
            <Button size="xs" variant="ghost" onClick={() => recall(item)}>
              {S.recall}
            </Button>
          )}
        </div>
      );
    })();
    return (
      <div
        key={item.id}
        className={cn("flex min-w-0 flex-col gap-1.5", isUser ? "items-end" : "items-stretch")}
      >
        {item.reasoning !== undefined && (
          <Reasoning
            text={item.reasoning}
            {...(item.reasoningMs !== undefined ? { ms: item.reasoningMs } : {})}
          />
        )}
        {item.attachments && item.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {item.attachments.map((a) => (
              <MessageAttachment key={a.sha256} sha256={a.sha256} name={a.name} />
            ))}
          </div>
        )}
        {item.text !== "" &&
          (isUser ? (
            <Card
              elevation="raised"
              className="max-w-[85%] rounded-xl rounded-tr-sm px-4 py-2.5 text-base"
            >
              <MessageBody text={item.text} />
            </Card>
          ) : (
            <div className="text-base leading-relaxed">
              <MessageBody text={item.text} />
            </div>
          ))}
        {item.context && item.context.length > 0 && (
          <div className={cn("flex flex-wrap gap-1", isUser && "justify-end")}>
            {item.context.map((c) => (
              <Tip key={`${c.docId}:${c.range}`} content={`${S.locate} · ${S.revLabel(c.rev)}`}>
                <RangeChip
                  range={c.range}
                  file={docName(c.docId)}
                  tone="read"
                  onClick={() =>
                    void focusRange(c.range, c.docId).catch(() =>
                      useApp.setState({ referenceError: "no-document" }),
                    )
                  }
                />
              </Tip>
            ))}
          </div>
        )}
        {footer}
      </div>
    );
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  });

  const doSend = () => {
    if (uploading) {
      useApp.setState({ commandNotice: S.attachWaiting });
      return;
    }
    // 消息正文必填：只发图片时补一句说明
    const t = text.trim() === "" && hasAttachment ? S.imageOnlyText : text.trim();
    if (t === "" || sessionId === null) return;
    setText("");
    setSendFailed(false);
    void send(t, mode).catch(() => {
      setSendFailed(true);
      setText((current) => (current === "" ? t : current));
    });
  };

  const recall = (m: UiMessage) => {
    void cancelDispatch(m.id)
      .then(() => setText((current) => (current === "" ? m.text : current)))
      .catch(() => {});
  };

  const sessionTitle = useApp(
    (st) => st.sessions.find((x) => x.id === st.sessionId)?.title ?? null,
  );
  const usage = view.live.contextUsage;
  const usagePct =
    usage !== null && usage.window !== null
      ? Math.min(100, Math.round((usage.tokens / usage.window) * 100))
      : null;
  const empty = items.length === 0 && !agentRunning && view.live.reasoningText === "";
  const sendDisabled = (text.trim() === "" && !hasAttachment) || uploading;
  const modeLabel = DISPATCH_MODES.find((m) => m.value === mode)?.label ?? S.modeSteer;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="@container flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background px-3">
        {sidebarToggle && (
          <IconButton
            icon="sidebar"
            label={S.expandSidebar}
            shortcut="B"
            onClick={() => useApp.setState({ sidebarCollapsed: false })}
          />
        )}
        <SessionTitle title={sessionTitle ?? S.untitledSession} editable={agentId === "main"} />
        {agentId !== "main" && (
          <span className="flex min-w-0 items-center gap-1 text-sm text-foreground-secondary">
            <Icon name="chevronRight" size="xs" />
            <span className="truncate">{viewingName}</span>
          </span>
        )}
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          <HeaderControls />
          {usage && (
            <Tip
              content={
                usagePct !== null
                  ? S.contextUsagePct(usagePct, usage.estimated)
                  : S.contextUnknownWindow
              }
              side="bottom"
            >
              <span className="flex items-center gap-1.5 px-1 @max-[640px]:hidden" tabIndex={-1}>
                {usagePct !== null && (
                  <span
                    className="h-1 w-12 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        usagePct >= 80 ? "bg-warn" : "bg-foreground-secondary",
                      )}
                      style={{ width: `${usagePct}%` }}
                    />
                  </span>
                )}
                <span className="font-mono text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {S.tokensShort(usage.tokens, usage.estimated)}
                  {usage.window !== null ? ` / ${S.tokensShort(usage.window, false)}` : ""}
                </span>
              </span>
            </Tip>
          )}
          {sessionId !== null && (
            <Tip content={S.compactHint} side="bottom">
              <Button size="xs" variant="ghost" onClick={() => void compactNow()}>
                {S.compactAction}
              </Button>
            </Tip>
          )}
          {agentId !== "main" && (
            <Button size="sm" variant="ghost" onClick={() => selectAgent("main")}>
              <Icon name="chevronLeft" size="xs" />
              {S.backToMain}
            </Button>
          )}
          {hasDoc && tableCollapsed && (
            <IconButton
              icon="sheet"
              label={S.expandTable}
              onClick={() => setLayout({ tableCollapsed: false })}
            />
          )}
          {hasDoc && !tableCollapsed && (
            <IconButton
              icon="expand"
              label={S.collapseTable}
              className="max-[1279px]:hidden"
              onClick={() => setLayout({ tableCollapsed: true })}
            />
          )}
        </div>
      </header>
      <ScrollArea className="flex-1">
        <div
          className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 py-6"
          aria-live="polite"
          aria-busy={agentRunning || undefined}
        >
          {onboarding && agentId === "main" && <Onboarding />}
          {empty ? (
            onboarding ? null : (
              <EmptyChat
                onPick={(t) => {
                  setText(t);
                  requestAnimationFrame(() => focusComposer());
                }}
              />
            )
          ) : (
            items.filter((it) => !isStreaming(it)).map(renderItem)
          )}
          {view.live.reasoningText !== "" && (
            <Reasoning text={view.live.reasoningText} live={view.live.streamingText === ""} />
          )}
          {items.filter(isStreaming).map(renderItem)}
          {agentRunning && view.live.streamingText === "" && view.live.reasoningText === "" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Dots />
              {S.agentWorking}
            </div>
          )}
          {view.live.retry && (
            <Alert layout="inline" tone="warn" icon="clock" role="status">
              {S.retrying(view.live.retry.attempt, view.live.retry.waitMs)}
            </Alert>
          )}
          {view.live.error && (
            <Alert tone="err" role="alert">
              <AlertTitle>{S.errorKind(view.live.error.kind)}</AlertTitle>
              <div className="text-xs">{view.live.error.message}</div>
              <div className="text-xs">{S.errorNextStep(view.live.error.kind)}</div>
              <AlertActions>
                <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true, "models")}>
                  {S.goSettings}
                </Button>
              </AlertActions>
            </Alert>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="mx-auto flex w-full max-w-[808px] flex-col gap-2 px-5 pb-4">
        <Interactions />
        {!hasModelProfile && !onboarding && (
          <Alert tone="info" role="status">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong className="font-semibold">{S.needModelTitle}</strong> · {S.needModelBody}
              </span>
              <Button size="sm" onClick={() => setSettingsOpen(true, "models")}>
                {S.goSettings}
              </Button>
            </div>
          </Alert>
        )}
        {sendFailed && (
          <Alert tone="err" layout="inline" role="alert">
            {S.sendFailed}
          </Alert>
        )}
        {commandNotice && (
          <Alert tone="muted" layout="inline" role="status">
            {commandNotice}
          </Alert>
        )}
        {referenceError && (
          <Alert tone="warn" layout="inline" role="alert">
            {referenceError === "no-document" ? S.openReferenceFile : S.invalidReference}
          </Alert>
        )}
        {!agentRunning && queued > 0 && (
          <Alert tone="muted" layout="inline" icon="clock">
            <div className="flex items-center justify-between gap-2">
              <span>{S.queuedBanner(queued)}</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void resumeAgent().catch(() => {})}
              >
                {S.resumeSend}
              </Button>
            </div>
          </Alert>
        )}
        {!agentRunning && queued === 0 && session.agentStatus[agentId] === "interrupted" && (
          <Alert tone="muted" layout="inline" icon="alert">
            <div className="flex items-center justify-between gap-2">
              <span>{S.agentInterrupted}</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void resumeAgent().catch(() => {})}
              >
                {S.resume}
              </Button>
            </div>
          </Alert>
        )}
        <div
          className={cn(
            "relative rounded-xl border bg-card shadow-card transition-colors focus-within:border-ring",
            agentRunning ? "border-read/40" : "border-border",
          )}
        >
          <SuggestList
            items={suggestions}
            active={suggestIndex}
            onPick={pickSuggestion}
            onHover={setSuggestIndex}
          />
          <ContextChips />
          <AttachmentStrip />
          <div className="px-3.5 pt-3 pb-1">
            <Textarea
              ref={inputRef}
              id={COMPOSER_INPUT_ID}
              variant="bare"
              value={text}
              placeholder={agentId !== "main" ? S.viewingAgent(viewingName) : S.composerPlaceholder}
              aria-label={S.composerPlaceholder}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={COMPOSER_SUGGEST_ID}
              aria-expanded={suggestions.length > 0}
              aria-activedescendant={
                suggestions.length > 0 ? suggestOptionId(suggestIndex) : undefined
              }
              rows={2}
              className="min-h-11"
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart);
                setSuggestIndex(0);
                setSuggestClosed(false);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length === 0) return;
                e.preventDefault();
                void addComposerFiles(files).catch(() => undefined);
              }}
              onKeyDown={(e) => {
                if (suggestions.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const n = suggestions.length;
                    setSuggestIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const it = suggestions[suggestIndex];
                    if (it) pickSuggestion(it);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSuggestClosed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  doSend();
                }
              }}
            />
          </div>
          <div className="flex items-center gap-1 px-2 pb-2">
            <IconButton
              icon="image"
              label={S.attachImage}
              onClick={() => fileRef.current?.click()}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void addComposerFiles(files).catch(() => undefined);
              }}
            />
            <IconButton
              icon="at"
              label={S.insertReference}
              onClick={() => {
                const el = inputRef.current;
                const pos = el?.selectionStart ?? text.length;
                const pre = text.slice(0, pos);
                const add = pre === "" || /\s$/.test(pre) ? "@" : " @";
                setText(pre + add + text.slice(pos));
                setSuggestClosed(false);
                requestAnimationFrame(() => {
                  el?.focus();
                  const c = pos + add.length;
                  el?.setSelectionRange(c, c);
                  setCaret(c);
                });
              }}
            />
            <span className="ml-1 min-w-0 truncate text-2xs text-muted-foreground">
              {agentRunning ? S.runningHint : S.sendHint}
            </span>
            <span className="flex-1" />
            {agentRunning && (
              <Tip content={S.stopHint}>
                <Button size="sm" variant="destructive-outline" onClick={() => void stopAgent()}>
                  <Icon name="stop" size="xs" />
                  {S.stop}
                </Button>
              </Tip>
            )}
            <div className="flex items-center">
              {agentRunning && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      aria-label={`${S.dispatchModeLabel}：${modeLabel}`}
                      className="rounded-r-none border-r border-primary-foreground/20 pr-2"
                    >
                      {modeLabel}
                      <Icon name="chevronDown" size="xs" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="top">
                    <DropdownMenuRadioGroup
                      value={mode}
                      onValueChange={(v) => setMode(v as DispatchMode)}
                    >
                      {DISPATCH_MODES.map((m) => (
                        <DropdownMenuRadioItem key={m.value} value={m.value}>
                          {m.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button
                size="sm"
                className={agentRunning ? "rounded-l-none" : undefined}
                disabled={sendDisabled}
                onClick={doSend}
              >
                {S.send}
                <Icon name="send" size="xs" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
