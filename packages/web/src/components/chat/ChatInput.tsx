import { useIsMobile } from "@/hooks/use-mobile";
import { persistentDraftStorage } from "@/lib/draft-storage";
import { MobileComposerTools } from "./MobileComposerTools";
// 对话输入框：@ 提及工作区文件、/ 命令与技能、附件、区域上下文（workbook-store.composerContext）。
// 发送一律经 chat-store.sendMessage；没有会话时先 ensureActiveSession。

import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowUp, Check, Cpu, Loader2, Play, Settings, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkbookContextChip } from "@/components/excel/WorkbookConversation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentProfileId, usePickerModels } from "@/hooks/use-model-selection";
import { errorMessage } from "@/lib/backend/api";
import { appendDraft, clearDraftIfUnchanged, readDraft, saveDraft } from "@/lib/composer-drafts";
import { agentBusy, visibleTimeline } from "@/lib/session/reducer";
import type { TurnSegment, UserItem } from "@/lib/session/types";
import { useComposerLayout } from "@/lib/use-composer-layout";
import { COMPOSER_SELECTOR } from "@/lib/workbook/ask";
import { useAppStore } from "@/stores/app-store";
import {
  effectiveChatMode,
  restartFrom,
  resumeAgent,
  sendMessage,
  setChatNotice,
  stopAgent,
  switchModel,
  useChatStore,
} from "@/stores/chat-store";
import { ensureActiveSession } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui-store";
import {
  composerMessageContext,
  dismissContext,
  resetComposerContext,
  useWorkbookStore,
} from "@/stores/workbook-store";
import {
  applyMentionSelection,
  buildMentionPopoverItems,
  buildSkillPopoverItems,
  ChatMentionList,
  maybeOpenMentionPopover,
  useChatMentions,
} from "./ChatMentionList";
import { ChatModeTabs } from "./ChatModeTabs";
import { ChatDropzone, ChatUploadButton } from "./ChatUploadButton";
import { CommandPopover, type PopoverItem } from "./CommandPopover";
import { ComposerRecoveryBar } from "./ComposerRecoveryBar";
import { ContextUsageButton } from "./ContextUsageButton";
import { shouldCancelComposerNativeDrop } from "./chat-drop";
import { IMMEDIATE_COMMANDS, type PopoverMode, SLASH_COMMANDS } from "./chat-input-constants";
import {
  applyDisplayReplacements,
  mentionOccurrences,
  reconcileMentionTokens,
  restoreMentionDraft,
} from "./chat-input-insert";
import { registerChatFileUpload } from "./chat-upload-bridge";
import { FileAttachmentChips } from "./FileAttachmentChips";
import { ModeBadges } from "./ModeBadges";
import {
  type ChangedFile,
  filesChangedAfter,
  RollbackConfirmDialog,
} from "./RollbackConfirmDialog";
import { ThinkingLevelSelector } from "./ThinkingLevelSelector";
import { useChatUpload } from "./use-chat-upload";
import { WorkspaceAttachmentPicker } from "./WorkspaceAttachmentPicker";

const COMPOSER_ATTR = COMPOSER_SELECTOR.replace(/^\[|\]$/g, "");

interface ChatInputProps {
  /** 外部填入的草稿（欢迎页建议等）：seq 变化时追加到原有草稿。 */
  draft?: { seq: number; text: string } | null;
  disabled?: boolean;
  onDraftApplied?: () => void;
}

/** 当前代理最近一轮以失败/中断结束、且之后没有新消息时，给出继续 / 换模型重试。 */
function lastFailedTurn(
  timeline: ReturnType<typeof visibleTimeline>,
): { turn: TurnSegment; origin: UserItem | null } | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind === "user") return null;
    if (item.kind !== "turn") continue;
    if (item.status !== "failed" && item.status !== "interrupted") return null;
    let origin: UserItem | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = timeline[j];
      if (prev.kind === "user") {
        origin = prev;
        break;
      }
    }
    return { turn: item, origin };
  }
  return null;
}

export function ChatInput(props: ChatInputProps) {
  const scope = useChatStore(
    (s) => `${s.sessionId ?? `new:${s.workspaceId ?? "default"}`}/${s.viewAgentId}`,
  );
  return <ScopedChatInput key={scope} {...props} scope={scope} />;
}

function ScopedChatInput({
  draft,
  disabled,
  scope,
  onDraftApplied,
}: ChatInputProps & { scope: string }) {
  const isMobile = useIsMobile();
  const sessionId = useChatStore((s) => s.sessionId);
  const isStreaming = useChatStore((s) => agentBusy(s.session, s.viewAgentId));
  const viewAgentName = useChatStore((s) =>
    s.viewAgentId === "main" ? null : (s.session.roster[s.viewAgentId]?.name ?? s.viewAgentId),
  );
  const hasMessages = useChatStore(
    (s) => (s.session.timelines[s.viewAgentId]?.length ?? 0) > 0 || s.optimistic.length > 0,
  );
  // 流式输出期间不需要重算失败尾部，避免逐 token 重渲染整个输入框
  const timeline = useChatStore((s) =>
    agentBusy(s.session, s.viewAgentId) ? null : visibleTimeline(s.session, s.viewAgentId),
  );
  const notice = useChatStore((s) => s.notice);
  const chatMode = useChatStore((s) => effectiveChatMode(s, s.viewAgentId));
  const composerInsert = useChatStore((s) => s.composerInsert);
  const hasModelProfile = useAppStore((s) => s.hasModelProfile);
  const modelsUnresolved = useAppStore((s) => s.profilesLoaded === false);
  const modelsError = useAppStore((s) => s.profilesError);
  const openSettings = useUIStore((s) => s.openSettings);
  const models = usePickerModels();
  const currentProfileId = useCurrentProfileId();
  const visionCapable = models.find((m) => m.id === currentProfileId)?.vision ?? null;

  const sendPendingRef = useRef(false);
  const [initialDraft] = useState(() => {
    try {
      return restoreMentionDraft(readDraft(persistentDraftStorage(), scope));
    } catch {
      return restoreMentionDraft("");
    }
  });
  const [text, setText] = useState(initialDraft.text);
  const initialPlainDraft = useMemo(
    () => applyDisplayReplacements(initialDraft.text, initialDraft.map),
    [initialDraft],
  );
  const savedTextRef = useRef(initialPlainDraft);
  const [inputHint, setInputHint] = useState<string | null>(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [popover, setPopover] = useState<PopoverMode>(null);
  const [popoverFilter, setPopoverFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmedTokens, setConfirmedTokens] = useState<Set<string>>(initialDraft.tokens);
  const [isSending, setIsSending] = useState(false);
  const [draftHighlight, setDraftHighlight] = useState(false);
  const [retryConfirm, setRetryConfirm] = useState<{
    origin: UserItem;
    modelProfileId: string;
    files: ChangedFile[];
  } | null>(null);

  const tokenMapRef = useRef<Map<string, string>>(initialDraft.map);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const inputHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    try {
      const plain = applyDisplayReplacements(text, tokenMapRef.current);
      if (plain) saveDraft(persistentDraftStorage(), scope, plain);
      else clearDraftIfUnchanged(persistentDraftStorage(), scope, savedTextRef.current);
      savedTextRef.current = plain;
    } catch {
      /* private browsing */
    }
  }, [scope, text, confirmedTokens]);

  const failure = useMemo(() => (timeline ? lastFailedTurn(timeline) : null), [timeline]);
  const configBlocked = modelsUnresolved || !hasModelProfile;
  const configHint = modelsUnresolved
    ? modelsError
      ? "模型读取失败，请打开模型设置重试"
      : "正在读取模型，请稍候再发送"
    : "模型未配置，请先完成配置后再发送";

  const { mentionData, fetchMentionData, cancelMentionRead } = useChatMentions();
  const {
    attachments,
    addFiles,
    attachWorkspaceFiles,
    handlePaste,
    hasUploadingFiles,
    hasFailedFiles,
  } = useChatUpload();

  // 桌面菜单等输入框外部入口经桥接注册表复用同一上传管线
  useEffect(() => registerChatFileUpload(addFiles), [addFiles]);

  const showInputHint = useCallback((message: string) => {
    setInputHint(message);
    if (inputHintTimerRef.current) clearTimeout(inputHintTimerRef.current);
    inputHintTimerRef.current = setTimeout(() => {
      setInputHint(null);
      inputHintTimerRef.current = null;
    }, 2600);
  }, []);

  const nudgeInput = useCallback(
    (hint?: string) => {
      const el = textareaRef.current?.parentElement?.parentElement;
      if (el) {
        el.classList.add("animate-shake-subtle");
        setTimeout(() => el.classList.remove("animate-shake-subtle"), 400);
      }
      if (hint) showInputHint(hint);
    },
    [showInputHint],
  );

  useEffect(
    () => () => {
      if (inputHintTimerRef.current) clearTimeout(inputHintTimerRef.current);
    },
    [],
  );

  const slashCommandNames = useMemo(() => new Set(SLASH_COMMANDS.map((c) => c.command)), []);

  const renderHighlightedText = useCallback(
    (raw: string): React.ReactNode => {
      if (!raw) return "​";
      const spans = mentionOccurrences(raw, [...confirmedTokens, ...slashCommandNames]);
      const parts: { text: string; token: boolean }[] = [];
      let cursor = 0;
      for (const span of spans) {
        parts.push({ text: raw.slice(cursor, span.start), token: false });
        parts.push({ text: span.token, token: true });
        cursor = span.end;
      }
      parts.push({ text: raw.slice(cursor), token: false });
      return (
        <>
          {parts.map((part, i) =>
            part.token ? (
              <span
                key={i}
                style={{
                  backgroundColor: "color-mix(in srgb, var(--em-primary) 14%, transparent)",
                  color: "var(--em-primary)",
                  display: "inline",
                  padding: 0,
                  margin: 0,
                  border: "none",
                  borderRadius: "9999px",
                  lineHeight: "inherit",
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  letterSpacing: "inherit",
                  boxDecorationBreak: "clone",
                  WebkitBoxDecorationBreak: "clone",
                }}
              >
                {part.text}
              </span>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
          {"\n"}
        </>
      );
    },
    [confirmedTokens, slashCommandNames],
  );

  const highlightedText = useMemo(() => renderHighlightedText(text), [renderHighlightedText, text]);

  const syncScroll = useComposerLayout(text, textareaRef, backdropRef);

  const resetTokens = useCallback(() => {
    setConfirmedTokens(new Set());
    tokenMapRef.current.clear();
  }, []);

  /** 快捷操作保留未发送的原稿，追加建议后由用户确认发送。 */
  const applyDraft = useCallback(
    (value: string) => {
      const replacements = new Map(tokenMapRef.current);
      resetTokens();
      setText((current) => appendDraft(applyDisplayReplacements(current, replacements), value));
      setDraftHighlight(true);
      window.setTimeout(() => setDraftHighlight(false), 900);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        el?.focus();
        if (el) el.setSelectionRange(el.value.length, el.value.length);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    },
    [resetTokens],
  );

  const draftSeq = draft?.seq;
  const draftText = draft?.text;
  useEffect(() => {
    if (draftSeq === undefined || draftText === undefined) return;
    applyDraft(draftText);
    onDraftApplied?.();
  }, [draftSeq, draftText, applyDraft, onDraftApplied]);

  // chat-store.insertIntoComposer：重新编辑、撤回排队消息、表格「问代理」等
  const insertNonce = composerInsert?.nonce;
  useEffect(() => {
    const insert = useChatStore.getState().composerInsert;
    if (!insert || insertNonce === undefined) return;
    useChatStore.setState({ composerInsert: null });
    if (insert.replace) {
      applyDraft(insert.text);
      return;
    }
    setText((current) => {
      const el = textareaRef.current;
      const pos = el?.selectionStart ?? current.length;
      const before = current.slice(0, pos);
      const sep = before && !/\s$/.test(before) ? " " : "";
      return `${before}${sep}${insert.text}${current.slice(pos)}`;
    });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [insertNonce, applyDraft]);

  const isSlashPopover =
    popover === "slash" || popover === "slash-skills" || popover === "slash-model";

  const popoverItems = useMemo((): PopoverItem[] => {
    const filter = popoverFilter.toLowerCase();
    if (popover === "slash") {
      return SLASH_COMMANDS.filter(
        (c) => c.command.toLowerCase().includes(filter) || c.description.includes(filter),
      );
    }
    if (popover === "slash-skills") return buildSkillPopoverItems(popoverFilter, mentionData);
    if (popover === "slash-model") {
      const items: PopoverItem[] = models
        .filter(
          (m) =>
            !filter ||
            m.label.toLowerCase().includes(filter) ||
            m.model.toLowerCase().includes(filter),
        )
        .map((m) => ({
          command: m.id,
          label: m.label,
          description: m.model,
          icon:
            m.id === currentProfileId ? (
              <Check className="h-3.5 w-3.5" style={{ color: "var(--em-primary)" }} />
            ) : (
              <Cpu className="h-3.5 w-3.5" />
            ),
          isActive: m.id === currentProfileId,
        }));
      if (items.length === 0)
        items.push({
          command: "",
          description: "暂无可用模型",
          icon: <Cpu className="h-3.5 w-3.5 opacity-30" />,
        });
      return items;
    }
    if (popover === "at" || popover === "at-sub")
      return buildMentionPopoverItems(popover, popoverFilter, mentionData);
    return [];
  }, [popover, popoverFilter, mentionData, models, currentProfileId]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [popoverItems.length]);

  const closePopover = () => {
    cancelMentionRead();
    setPopover(null);
    setPopoverFilter("");
  };

  const handleTextChange = (value: string) => {
    setText(value);
    setConfirmedTokens((prev) => reconcileMentionTokens(value, prev, tokenMapRef.current));

    if (value === "/") {
      cancelMentionRead();
      setPopover("slash");
      setPopoverFilter("");
      return;
    }
    if (popover === "slash" && value.startsWith("/") && !value.includes(" ")) {
      setPopoverFilter(value.slice(1));
      return;
    }
    if (popover === "slash-skills" || popover === "slash-model") {
      setPopoverFilter(value);
      return;
    }
    if (maybeOpenMentionPopover(value, fetchMentionData, setPopover, setPopoverFilter)) return;
    if (popover) closePopover();
  };

  const runImmediate = async (command: string) => {
    if (!sessionId) return;
    await sendMessage({ text: command });
  };

  const handleModelSwitch = async (profileId: string) => {
    closePopover();
    setText("");
    const target = models.find((m) => m.id === profileId);
    if (profileId === currentProfileId) {
      setChatNotice(`当前已是「${target?.label ?? profileId}」`);
      return;
    }
    if (!sessionId) {
      setChatNotice("请先开始对话，再切换模型", "error");
      return;
    }
    try {
      const name = await switchModel(profileId);
      setChatNotice(`已切换到模型档案「${name}」`);
    } catch (error) {
      setChatNotice(errorMessage(error, "切换模型失败"), "error");
    }
  };

  const selectPopoverItem = (item: PopoverItem) => {
    if (
      applyMentionSelection({
        item,
        popover,
        text,
        setText,
        tokenMapRef,
        setConfirmedTokens,
        closePopover,
        textareaRef,
      })
    ) {
      return;
    }
    if (popover === "slash") {
      if (item.command === "/skills") {
        fetchMentionData();
        setPopover("slash-skills");
        setPopoverFilter("");
        setText("");
        textareaRef.current?.focus();
        return;
      }
      if (item.command === "/model") {
        cancelMentionRead();
        setPopover("slash-model");
        setPopoverFilter("");
        setText("");
        textareaRef.current?.focus();
        return;
      }
      if (IMMEDIATE_COMMANDS.has(item.command)) {
        closePopover();
        setText("");
        void runImmediate(item.command);
        return;
      }
      setText(`${item.command} `);
      closePopover();
    } else if (popover === "slash-skills") {
      if (!item.command) return;
      setText(`${item.command} `);
      closePopover();
    } else if (popover === "slash-model") {
      if (!item.command) return;
      void handleModelSwitch(item.command);
      return;
    }
    textareaRef.current?.focus();
  };

  const handleSend = async () => {
    if (sendPendingRef.current) return;
    if (disabled) {
      nudgeInput("正在切换对话，请稍候");
      return;
    }
    if (configBlocked) {
      nudgeInput(configHint);
      return;
    }
    if (hasUploadingFiles) {
      nudgeInput("附件上传中，请稍候再发送");
      return;
    }
    if (hasFailedFiles) {
      nudgeInput("有附件未就绪，请重试或移除后再发送");
      return;
    }
    const trimmed = text.trim();
    const readyAttachments = attachments.filter((a) => a.status === "ready").length;
    if (!trimmed && readyAttachments === 0) return;
    closePopover();

    const draftText = text;
    const finalText = applyDisplayReplacements(trimmed, tokenMapRef.current);
    const context = composerMessageContext();
    const sentReferenceState = useWorkbookStore.getState();
    sendPendingRef.current = true;
    setIsSending(true);
    try {
      if (!useChatStore.getState().sessionId) await ensureActiveSession();
      const sent = await sendMessage({
        text: finalText,
        ...(context.length > 0 && !finalText.startsWith("/") ? { context } : {}),
      });
      if (!sent) return;
      try {
        if (
          readDraft(persistentDraftStorage(), scope) ===
          applyDisplayReplacements(draftText, tokenMapRef.current)
        )
          saveDraft(persistentDraftStorage(), scope, "");
      } catch {
        /* private browsing */
      }
      if (textareaRef.current?.value === draftText) {
        setText("");
        resetTokens();
      }
      // 钉住的区域只随这一条消息发送
      resetComposerContext(sentReferenceState);
    } catch (err) {
      nudgeInput(errorMessage(err, "暂时无法发送，请重试"));
    } finally {
      sendPendingRef.current = false;
      setIsSending(false);
    }
  };

  const handleStop = useCallback(() => {
    void stopAgent().catch((err) => nudgeInput(errorMessage(err, "停止失败")));
  }, [nudgeInput]);

  // 「继续」：让当前代理接着中断/失败的地方继续，不产生新的用户消息
  const handleContinue = useCallback(() => {
    if (disabled) {
      nudgeInput("正在切换对话，请稍候");
      return;
    }
    if (configBlocked) {
      nudgeInput(configHint);
      return;
    }
    void resumeAgent().catch((err) => nudgeInput(`继续失败：${errorMessage(err, "未知错误")}`));
  }, [disabled, configBlocked, configHint, nudgeInput]);

  const origin = failure?.origin ?? null;
  const handleRetryWithModel = useCallback(
    (profileId: string) => {
      if (!origin) return;
      const files = filesChangedAfter(origin.seq, origin.agentId);
      if (files.length > 0) setRetryConfirm({ origin, modelProfileId: profileId, files });
      else void restartFrom(origin, { modelProfileId: profileId });
    },
    [origin],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposingRef.current) return;

    if (popover && popoverItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % popoverItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + popoverItems.length) % popoverItems.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const item = popoverItems[selectedIndex];
        if (item) selectPopoverItem(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePopover();
        return;
      }
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const { selectionStart, selectionEnd } = textarea;
      if (selectionStart !== selectionEnd) return;
      const cursor = selectionStart;
      for (const { token, start: idx, end: tokenEnd } of mentionOccurrences(
        text,
        confirmedTokens,
      )) {
        const hit =
          e.key === "Backspace"
            ? cursor > idx && cursor <= tokenEnd
            : cursor >= idx && cursor < tokenEnd;
        if (hit) {
          e.preventDefault();
          const trailSpace = text[tokenEnd] === " " ? 1 : 0;
          const nextText = text.slice(0, idx) + text.slice(tokenEnd + trailSpace);
          const tokenRemains = mentionOccurrences(nextText, [token]).length > 0;
          setText(nextText);
          setConfirmedTokens((prev) => {
            if (tokenRemains) return prev;
            const next = new Set(prev);
            next.delete(token);
            return next;
          });
          if (!tokenRemains) tokenMapRef.current.delete(token);
          requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(idx, idx);
          });
          return;
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hint = inputHint ?? notice?.text ?? null;
  const hintIsError = !inputHint && notice?.tone === "error";
  const empty = !text.trim() && attachments.length === 0;
  // 服务重启中断由消息流末尾的提示自带「继续」，这里不重复
  const continuationOffered = !!failure && !isStreaming && failure.turn.reason !== "restart";

  return (
    <>
      {continuationOffered && failure && (
        <ComposerRecoveryBar
          hint={
            failure.turn.failure?.message ??
            (failure.turn.status === "interrupted" ? "回复已中断" : "回复未完成")
          }
          onContinue={handleContinue}
          {...(origin ? { onRetryWithModel: handleRetryWithModel } : {})}
        />
      )}
      {workspacePickerOpen && (
        <WorkspaceAttachmentPicker
          onClose={() => setWorkspacePickerOpen(false)}
          onPick={(path) =>
            attachWorkspaceFiles([{ path, filename: path.split("/").pop() ?? path }])
          }
        />
      )}
      <ChatDropzone
        onNativeFiles={addFiles}
        onExcelFiles={attachWorkspaceFiles}
        highlighted={draftHighlight}
      >
        <div className="em-composer-tabs" role="toolbar" aria-label="当前引用">
          <WorkbookContextChip />
        </div>

        <ChatMentionList
          popover={popover}
          popoverItems={popoverItems}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          selectPopoverItem={selectPopoverItem}
          popoverRef={popoverRef}
        />

        {isSlashPopover && (
          <CommandPopover
            popover={popover}
            popoverItems={popoverItems}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            selectPopoverItem={selectPopoverItem}
            popoverRef={popoverRef}
            activeSlashCmd={null}
            atCategory={null}
            onBackToSlash={() => {
              cancelMentionRead();
              setPopover("slash");
              setPopoverFilter("");
              setText("/");
            }}
            onBackToAt={() => {}}
          />
        )}

        <AnimatePresence>
          {configBlocked && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="em-nomodel-card">
                <span className="em-nomodel-icon" aria-hidden="true">
                  <Settings className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="em-nomodel-title">
                    {modelsUnresolved
                      ? modelsError
                        ? "模型列表读取失败"
                        : "正在读取模型…"
                      : "还没有可用的模型"}
                  </p>
                  <p className="em-nomodel-desc">
                    {modelsUnresolved
                      ? "文件和表格可以先浏览，模型就绪后再发送任务。"
                      : "添加一个模型档案后就能开始任务；文件和表格现在就可以浏览。"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openSettings("model")}
                  className="em-nomodel-action"
                >
                  {modelsUnresolved ? "查看模型状态" : "去设置模型"}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="em-composer-modebar flex flex-wrap items-center justify-between gap-y-1 px-1 pt-1">
          <div className="flex min-w-0 w-full items-center gap-0.5 pr-1 sm:pr-3 pt-1 pb-0">
            {isMobile ? (
              <MobileComposerTools />
            ) : (
              <>
                <ChatModeTabs />
                <span className="mx-1 h-3.5 w-px bg-[var(--em-line)]" aria-hidden="true" />
                <ModeBadges />
                <ThinkingLevelSelector />
                <ContextUsageButton />
              </>
            )}
            {viewAgentName && (
              <span className="ml-1 truncate rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                发给 {viewAgentName}
              </span>
            )}
          </div>
        </div>

        <FileAttachmentChips files={attachments} visionCapable={visionCapable} />

        <AnimatePresence initial={false}>
          {hint && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="px-3 pb-0.5"
            >
              {hintIsError ? (
                <div
                  role="alert"
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-200/80 bg-red-50/80 px-2 py-1 text-[11px] text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400"
                >
                  <AlertTriangle className="h-3 w-3" />
                  {hint}
                </div>
              ) : (
                <div className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
                  {hint}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="em-input-toolbar flex items-end gap-1 px-1.5 py-1.5">
          <ChatUploadButton
            onPick={addFiles}
            onWorkspacePick={() => setWorkspacePickerOpen(true)}
          />

          <div className="relative min-w-0 flex-1">
            <div
              ref={backdropRef}
              aria-hidden="true"
              className="em-composer-backdrop pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words font-sans"
              style={{
                color: "var(--foreground)",
                padding: "8px 8px",
                fontSize: "13px",
                lineHeight: "20px",
                fontFamily: "var(--font-sans, inherit)",
                wordBreak: "break-all",
                WebkitTextSizeAdjust: "100%",
              }}
            >
              {highlightedText}
            </div>
            <Textarea
              ref={textareaRef}
              {...{ [COMPOSER_ATTR]: "" }}
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={syncScroll}
              onPaste={handlePaste}
              onDragOver={(e) => {
                if (shouldCancelComposerNativeDrop(e.dataTransfer.types, 0)) e.preventDefault();
              }}
              onDrop={(e) => {
                if (shouldCancelComposerNativeDrop(e.dataTransfer.types, 0)) e.preventDefault();
              }}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              placeholder={
                viewAgentName
                  ? `发给 ${viewAgentName}…`
                  : chatMode === "ask"
                    ? "问点什么（只读，不会修改文件）"
                    : chatMode === "plan"
                      ? "说说目标，先给你一份计划"
                      : hasMessages
                        ? "继续分析，或告诉我下一步…"
                        : "有问题，尽管问"
              }
              disabled={disabled}
              className="relative z-10 min-h-[36px] max-h-[180px] resize-none border-0 bg-transparent shadow-none dark:bg-transparent selection:bg-[var(--em-primary)]/20 focus-visible:ring-0 focus-visible:ring-offset-0"
              style={{
                padding: "8px 8px",
                fontSize: "13px",
                lineHeight: "20px",
                fontFamily: "var(--font-sans, inherit)",
                wordBreak: "break-all" as const,
                WebkitTextSizeAdjust: "100%",
                color: "transparent",
                caretColor: "var(--foreground)",
                scrollbarGutter: "stable",
              }}
              rows={1}
            />
          </div>

          <div className="flex-shrink-0">
            {isStreaming && empty ? (
              <Button
                key="stop"
                data-coach-id="coach-stop-btn"
                aria-label="停止生成"
                size="icon"
                className="touch-compact h-9 w-9 rounded-full bg-foreground hover:bg-foreground/80 sm:h-8 sm:w-8"
                onClick={handleStop}
              >
                <Square className="h-3 w-3 fill-background text-background" />
              </Button>
            ) : continuationOffered && empty ? (
              <Button
                key="continue"
                data-coach-id="coach-continue-btn"
                aria-label="继续执行"
                size="icon"
                className="touch-compact send-btn-glow h-9 w-9 rounded-full text-white transition-opacity sm:h-8 sm:w-8"
                style={{ backgroundColor: "var(--em-primary)" }}
                onClick={handleContinue}
                disabled={disabled || configBlocked}
              >
                <Play className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                {isStreaming && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="停止生成"
                    onClick={handleStop}
                  >
                    <Square className="size-3.5" />
                  </Button>
                )}
                <Button
                  key="send"
                  data-coach-id="coach-send-btn"
                  aria-label="发送消息"
                  size="icon"
                  className="touch-compact send-btn-glow h-9 w-9 rounded-full text-white transition-opacity sm:h-8 sm:w-8"
                  style={{ backgroundColor: "var(--em-primary)" }}
                  onClick={() => void handleSend()}
                  disabled={
                    disabled ||
                    isSending ||
                    configBlocked ||
                    empty ||
                    hasUploadingFiles ||
                    hasFailedFiles
                  }
                >
                  {isSending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </ChatDropzone>
      <RollbackConfirmDialog
        open={retryConfirm !== null}
        files={retryConfirm?.files ?? []}
        onCancel={() => setRetryConfirm(null)}
        onConfirm={() => {
          const pending = retryConfirm;
          setRetryConfirm(null);
          if (pending) void restartFrom(pending.origin, { modelProfileId: pending.modelProfileId });
        }}
      />
    </>
  );
}
