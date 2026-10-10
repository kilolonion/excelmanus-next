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
  undoMemory,
  useApp,
} from "../store.ts";
import { S, toolTitle } from "../strings.ts";
import { useChatScroll } from "../use-chat-scroll.ts";
import { BrandMark, Icon, type IconName, ProviderLogo } from "./Icon.tsx";
import { Interactions } from "./Interactions.tsx";
import { RecentFiles } from "./layout/RecentFiles.tsx";
import { ModelReasoningControl } from "./ModelReasoningControl.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { PendingMessage } from "./PendingMessage.tsx";
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
  RangeChip,
  statusTone,
} from "./ui/display.tsx";
import { Input, Textarea } from "./ui/input.tsx";
import { Disclosure, ScrollArea, toast } from "./ui/overlay.tsx";
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
    <Card
      elevation="flat"
      className="flex flex-col gap-2.5 rounded-xl border-border/80 px-4 py-3.5"
    >
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
              summary={S.toolDetails}
              contentClassName="flex flex-col gap-2"
            >
              <span className="font-mono text-2xs text-muted-foreground">{card.name}</span>
              {hasArgs && (
                <div className="flex flex-col gap-1">
                  <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    {S.toolArgs}
                  </span>
                  <ScrollArea
                    className="max-h-80 rounded-md bg-muted"
                    viewportClassName="max-h-80 overscroll-contain"
                    viewportProps={{ tabIndex: 0, role: "region", "aria-label": S.toolArgs }}
                  >
                    <div className="p-2.5 font-mono text-xs">
                      <MessageBody text={card.args as string} docId={card.docId} plain />
                    </div>
                  </ScrollArea>
                </div>
              )}
              {hasResult && (
                <div className="flex flex-col gap-1">
                  <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    {S.toolResult}
                  </span>
                  <ScrollArea
                    className="max-h-80 rounded-md bg-muted"
                    viewportClassName="max-h-80 overscroll-contain"
                    viewportProps={{ tabIndex: 0, role: "region", "aria-label": S.toolResult }}
                  >
                    <div className="p-2.5 font-mono text-xs">
                      <MessageBody text={card.resultSummary as string} docId={card.docId} plain />
                    </div>
                  </ScrollArea>
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

/** 输入框上方的图片附件和工作区文件引用（02 §3.3）。 */
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
              "relative overflow-hidden rounded-md border border-border bg-muted",
              a.previewUrl ? "size-14" : "flex h-14 max-w-56 items-center gap-2 px-3 pr-7",
              a.status === "error" && "border-destructive",
            )}
          >
            {a.previewUrl ? (
              <img src={a.previewUrl} alt={a.name} className="size-full object-cover" />
            ) : (
              <>
                <Icon name="file" size="sm" className="shrink-0 text-muted-foreground" />
                <span className="truncate text-xs">{a.name}</span>
              </>
            )}
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
            <IconButton
              icon="x"
              size="icon-xs"
              tooltip={false}
              variant="default"
              className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring"
              label={`${S.removeAttachment}：${a.name}`}
              onClick={() => removeComposerAttachment(a.id)}
            />
          </span>
        </Tip>
      ))}
      {visionOff && items.some((a) => a.previewUrl) && (
        <span className="text-xs text-muted-foreground">{S.imageNotSentHint}</span>
      )}
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
  const permission = useApp(
    (s) =>
      s.session.permissionMode ??
      s.sessions.find((x) => x.id === s.sessionId)?.permissionMode ??
      null,
  );
  const [err, setErr] = useState(false);
  if (profiles.length === 0) return null;
  return (
    <>
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

const isStreaming = (it: DisplayItem): it is UiMessage => !("kind" in it) && it.id === "streaming";
const displayKey = (item: DisplayItem) =>
  "toolCallId" in item ? `tool-${item.toolCallId}` : item.id;

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

function EmptyChatHeading() {
  return (
    <div className="empty-chat landing-heading flex flex-col gap-3 py-3 motion-safe:animate-surface-in">
      <BrandMark className="brand-mark" />
      <h1 className="empty-chat-title text-3xl font-semibold tracking-tight text-foreground">
        {S.emptyChatTitle}
      </h1>
      <p className="max-w-[480px] text-sm leading-6 text-muted-foreground">{S.emptyChatHint}</p>
    </div>
  );
}

function EmptyChatExtras({
  onPick,
  hasModelProfile,
  files,
  activeFile,
  modelName,
  modelProvider,
  onConfigureModel,
}: {
  onPick: (t: string) => void;
  hasModelProfile: boolean;
  files: number;
  activeFile: string | null;
  modelName: string | null;
  modelProvider?: string;
  onConfigureModel: () => void;
}) {
  return (
    <div className="landing-extras mx-auto flex w-full max-w-[808px] shrink-0 flex-col gap-6">
      <RecentFiles />
      <div className="empty-chat-context order-last grid grid-cols-2 gap-4 border-t border-border/80 pt-5">
        <div className="flex min-w-0 items-center gap-3 px-1">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon name="folder" size="sm" />
          </span>
          <div className="min-w-0">
            <div className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
              {S.emptyChatWorkspace}
            </div>
            <div className="truncate text-sm font-medium">
              {files > 0 ? S.emptyChatWorkspaceReady(files) : S.emptyChatWorkspaceEmpty}
            </div>
            <div className="empty-chat-file-hint truncate text-xs text-muted-foreground">
              {activeFile ? S.emptyChatActiveFile(activeFile) : S.emptyChatNoActiveFile}
            </div>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-3 px-1">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <ProviderLogo provider={modelProvider} size="lg" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
              {S.emptyChatModel}
            </div>
            <div
              className={cn("truncate text-sm font-medium", !hasModelProfile && "text-warn-ink")}
            >
              {hasModelProfile && modelName
                ? S.emptyChatModelReady(modelName)
                : S.emptyChatModelMissing}
            </div>
            {!hasModelProfile && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{S.emptyChatModelMissingHint}</span>
                <Button size="xs" variant="link" onClick={onConfigureModel}>
                  {S.emptyChatConfigureModel}
                </Button>
              </div>
            )}
          </div>
          {hasModelProfile && <Icon name="circleCheck" size="sm" className="text-ok" />}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-xs font-medium tracking-[0.06em] text-muted-foreground">
          {S.emptyChatTaskLabel}
        </div>
        <div className="starter-grid grid gap-3">
          {S.emptyChatTasks.map((task) => (
            <Button
              key={task.title}
              variant="outline"
              className="starter-card group relative h-auto min-h-14 items-center justify-start gap-3 rounded-md border-transparent bg-transparent px-2.5 py-2 text-left whitespace-normal shadow-none hover:bg-muted"
              onClick={() => onPick(task.prompt)}
            >
              <span className="starter-icon flex size-7 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover:text-foreground">
                <Icon name={task.icon as IconName} size="md" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">{task.title}</span>
                <span className="starter-card-hint text-xs font-normal leading-relaxed text-muted-foreground">
                  {task.hint}
                </span>
              </span>
              <Icon
                name="chevronRight"
                size="xs"
                className="ml-auto text-muted-foreground/45 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
              />
            </Button>
          ))}
        </div>
      </div>
    </div>
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

function quoteMessage(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
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
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = useApp((st) => st.composerAttachments.some((a) => a.status === "uploading"));
  const attachmentError = useApp((st) => st.composerAttachments.some((a) => a.status === "error"));
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
  const chatScroll = useChatScroll(JSON.stringify([sessionId, agentId]), session.cursor);
  const view = agentView(session, agentId);
  const items = displayItems(view);
  const agentRunning = view.running;
  const queued = queuedCount(session, agentId);
  const viewingName = roster[agentId]?.name ?? agentId;
  const hasDoc = useApp((st) => st.doc !== null);
  const activeFile = useApp((st) => {
    const path = st.doc?.path;
    return path ? (path.split(/[\\/]/).pop() ?? null) : null;
  });
  const workspaceFileCount = useApp((st) => st.files.filter((file) => file.kind === "file").length);
  const modelProfile = useApp((st) => {
    const id =
      st.session.roster[st.agentId]?.modelProfileId ?? st.profiles.find((p) => p.isDefault)?.id;
    return st.profiles.find((profile) => profile.id === id);
  });
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
    if (isUser && item.dispatchStatus === "cancelled") return null;
    const pending =
      isUser && (item.dispatchStatus === "queued" || item.dispatchStatus === "accepted");
    const footer = (() => {
      const label = dispatchLabel(session, item);

      const time = isUser && item.at ? clockTime(item.at) : null;
      if (pending || (label === null && time === null)) return null;
      return (
        <div
          className={cn(
            "flex items-center gap-2 text-2xs text-muted-foreground",
            isUser && "justify-end",
          )}
        >
          {time !== null && <time dateTime={item.at}>{time}</time>}
          {label !== null && <span>{label}</span>}
        </div>
      );
    })();
    return (
      <div
        key={item.id}
        className={cn(
          "group/message flex min-w-0 flex-col gap-1.5",
          isUser ? "user-message items-end" : "assistant-message items-stretch",
        )}
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
        {pending && sessionId ? (
          <PendingMessage
            message={item}
            sessionId={sessionId}
            agentId={agentId}
            label={dispatchLabel(session, item)}
          />
        ) : (
          item.text !== "" &&
          (isUser ? (
            <Card
              elevation="flat"
              className="max-w-[88%] rounded-2xl rounded-tr-md border-transparent bg-muted/80 px-4 py-3 text-base"
            >
              <MessageBody text={item.text} />
            </Card>
          ) : (
            <div className="text-base leading-relaxed">
              <MessageBody text={item.text} />
            </div>
          ))
        )}
        {item.role === "assistant" && item.text !== "" && (
          <div className="flex items-center gap-0.5 self-start opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
            <IconButton
              icon={copiedMessageId === item.id ? "check" : "copy"}
              size="icon-xs"
              label={copiedMessageId === item.id ? S.copyMessageDone : S.copyMessage}
              onClick={() => void copyMessage(item)}
            />
            <IconButton
              icon="quote"
              size="icon-xs"
              label={S.quoteMessage}
              onClick={() => quoteIntoComposer(item)}
            />
          </div>
        )}
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

  const doSend = () => {
    if (attachmentError) {
      useApp.setState({ commandNotice: S.attachNotReady });
      return;
    }
    if (uploading) {
      useApp.setState({ commandNotice: S.attachWaiting });
      return;
    }
    const t = text.trim() === "" && hasAttachment ? S.fileOnlyText : text.trim();
    if (t === "" || sessionId === null) return;
    setText("");
    setSendFailed(false);
    void send(t).catch(() => {
      setSendFailed(true);
      setText((current) => (current === "" ? t : current));
    });
  };

  /** 失败轮的显式重试：重新派发最近一条用户消息，而不是伪造 resume 接口。 */
  const retryLastMessage = () => {
    const message = lastUserMessage?.text.trim();
    if (!message || agentRunning) return;
    setSendFailed(false);
    void send(message).catch(() => setSendFailed(true));
  };

  const copyMessage = async (m: UiMessage) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(m.text);
      setCopiedMessageId(m.id);
      toast({ tone: "ok", title: S.copyMessageDone, duration: 2000 });
      window.setTimeout(() => {
        setCopiedMessageId((current) => (current === m.id ? null : current));
      }, 2000);
    } catch {
      toast({ tone: "err", title: S.copyMessageFailed });
    }
  };

  const quoteIntoComposer = (m: UiMessage) => {
    const quoted = quoteMessage(m.text);
    const next = text.trim() === "" ? quoted : `${text.replace(/\s+$/, "")}\n\n${quoted}`;
    setText(next);
    requestAnimationFrame(() => {
      const el = inputRef.current ?? focusComposer();
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
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
  const landing = empty && !onboarding;
  const lastUserMessage = [...session.messages]
    .reverse()
    .find(
      (m) =>
        m.role === "user" &&
        m.dispatchStatus !== "cancelled" &&
        (m.agentId === agentId || (agentId === "main" && (m.agentId == null || m.agentId === ""))),
    );
  const errorActions = view.live.error?.actions ?? [];
  const settingsAction = errorActions.some((action) =>
    /\u8bbe\u7f6e|\u51ed\u636e|API\s*Key|\u6a21\u578b\u6863\u6848|\u6a21\u578b ID/i.test(action),
  );
  const sendDisabled = (text.trim() === "" && !hasAttachment) || uploading;
  const pauseButton =
    agentRunning && text.trim() === "" && !hasAttachment && !uploading && !attachmentError;

  const composer = (
    <div
      className="composer-dock mx-auto flex w-full max-w-[808px] shrink-0 flex-col gap-3 bg-card pt-3"
      data-running={agentRunning || undefined}
    >
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
            <Button size="xs" variant="outline" onClick={() => void resumeAgent().catch(() => {})}>
              {S.resumeSend}
            </Button>
          </div>
        </Alert>
      )}
      {!agentRunning && queued === 0 && session.agentStatus[agentId] === "interrupted" && (
        <Alert tone="muted" layout="inline" icon="alert">
          <div className="flex items-center justify-between gap-2">
            <span>{S.agentInterrupted}</span>
            <Button size="xs" variant="outline" onClick={() => void resumeAgent().catch(() => {})}>
              {S.resume}
            </Button>
          </div>
        </Alert>
      )}
      <div
        className={cn(
          "composer-surface relative rounded-2xl border bg-card shadow-composer focus-within:border-read/50",
          agentRunning ? "border-read/40" : "border-border-strong/90",
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
        <div className="px-4 pt-4 pb-2">
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
            className="min-h-14"
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
        <div className="composer-toolbar flex flex-wrap items-center gap-1.5 gap-y-2 px-3 pb-3">
          <IconButton icon="plus" label={S.attachFile} onClick={() => fileRef.current?.click()} />
          <input
            ref={fileRef}
            type="file"
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
          <span className="flex-1" />
          <ModelReasoningControl />
          <IconButton
            icon={pauseButton ? "stop" : "send"}
            label={pauseButton ? S.composerPause : S.send}
            variant="default"
            size="icon"
            className="composer-submit ml-auto size-10 rounded-full bg-[#387ef7] text-white hover:bg-[#2871eb] [&_svg]:size-5"
            disabled={!pauseButton && sendDisabled}
            tooltip={pauseButton ? S.stopHint : S.sendHint}
            onClick={() =>
              agentRunning && sendDisabled
                ? void stopAgent().catch(() => toast({ tone: "err", title: S.pendingActionFailed }))
                : doSend()
            }
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="chat-panel flex min-h-0 flex-1 flex-col" data-empty={landing || undefined}>
      <header className="chat-header @container flex h-16 shrink-0 items-center gap-3 border-b border-border/75 bg-card px-5">
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
        <div className="chat-header-controls flex min-w-0 shrink-0 items-center gap-1.5">
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
              <IconButton
                icon="collapse"
                size="icon-sm"
                label={S.compactAction}
                tooltip={false}
                onClick={() => void compactNow()}
              />
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
        <div className="chat-profile-line flex min-w-0 items-center gap-1.5">
          <HeaderControls />
        </div>
      </header>
      <div
        className={cn(
          "chat-body flex min-h-0 flex-1 flex-col",
          landing ? "overflow-y-auto" : "overflow-hidden",
        )}
        data-empty={landing || undefined}
      >
        <div
          ref={chatScroll.rootRef}
          className={cn(
            "chat-history relative flex min-h-0 flex-col",
            landing ? "shrink-0" : "flex-1",
          )}
        >
          <ScrollArea
            className={cn("chat-history-scroll", landing ? "shrink-0 overflow-visible" : "flex-1")}
            viewportRef={chatScroll.viewportRef}
            viewportClassName={cn(
              "chat-history-viewport overscroll-contain [overflow-anchor:none] [scroll-behavior:auto]",
              landing && "h-auto! overflow-visible!",
            )}
            viewportProps={{ tabIndex: 0, role: "region", "aria-label": S.chatHistory }}
          >
            <div
              ref={chatScroll.contentRef}
              data-chat-empty={empty || undefined}
              className={cn(
                "chat-history-content mx-auto flex w-full max-w-[808px] flex-col gap-5 py-9",
                landing && "py-0",
              )}
              aria-live="polite"
              aria-busy={agentRunning || undefined}
            >
              {onboarding && agentId === "main" && <Onboarding />}
              {empty ? (
                onboarding ? null : (
                  <EmptyChatHeading />
                )
              ) : (
                items
                  .filter((it) => !isStreaming(it))
                  .map((item) => (
                    <div
                      key={displayKey(item)}
                      data-chat-item={displayKey(item)}
                      className="min-w-0"
                    >
                      {renderItem(item)}
                    </div>
                  ))
              )}
              {view.live.reasoningText !== "" && (
                <div data-chat-item="live-reasoning">
                  <Reasoning text={view.live.reasoningText} live={view.live.streamingText === ""} />
                </div>
              )}
              {items.filter(isStreaming).map((item) => (
                <div key={item.id} data-chat-item={item.id} className="min-w-0">
                  {renderItem(item)}
                </div>
              ))}
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
                  {errorActions.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                      {errorActions.map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs">{S.errorNextStep(view.live.error.kind)}</div>
                  )}
                  {(view.live.error.retryable === true || settingsAction) && (
                    <AlertActions>
                      {view.live.error.retryable === true && lastUserMessage && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={agentRunning}
                          onClick={retryLastMessage}
                        >
                          {S.retryTurn}
                        </Button>
                      )}
                      {settingsAction && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSettingsOpen(true, "models")}
                        >
                          {S.goSettings}
                        </Button>
                      )}
                    </AlertActions>
                  )}
                </Alert>
              )}
            </div>
          </ScrollArea>
          {!empty && !chatScroll.following && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
              <Button
                size="sm"
                variant="outline"
                className="pointer-events-auto rounded-full bg-background shadow-card"
                onClick={chatScroll.followLatest}
              >
                <Icon name="chevronDown" size="sm" />
                {agentRunning ? S.followGeneration : S.backToLatest}
              </Button>
            </div>
          )}
        </div>
        {composer}
        {landing && (
          <EmptyChatExtras
            hasModelProfile={hasModelProfile}
            files={workspaceFileCount}
            activeFile={activeFile}
            modelName={modelProfile?.name ?? null}
            modelProvider={modelProfile?.provider}
            onConfigureModel={() => setSettingsOpen(true, "models")}
            onPick={(t) => {
              setText(t);
              requestAnimationFrame(() => focusComposer());
            }}
          />
        )}
      </div>
    </div>
  );
}
