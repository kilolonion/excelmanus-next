// 从表格交给代理：把区域钉成本条消息的上下文，提问放进输入框并聚焦。

import { getIsMobile } from "@/hooks/use-mobile";
import { insertIntoComposer } from "@/stores/chat-store";
import {
  composerContext,
  pinRange,
  pinSelection,
  setFullView,
  setPanelOpen,
  useWorkbookStore,
} from "@/stores/workbook-store";
import { type AskKind, askPrompt } from "./ask-actions";

/** 输入框在页面上的唯一标记（ChatInput 的 textarea）。 */
export const COMPOSER_SELECTOR = "[data-composer-input]";

export function focusComposer(): void {
  // 手机上表格与对话不同屏：先回到对话
  if (getIsMobile()) {
    setFullView(false);
    setPanelOpen(false);
  }
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)?.focus(),
  );
}

export function askAgent(kind: AskKind, opts: { range?: string } = {}): void {
  const st = useWorkbookStore.getState();
  const doc = st.doc;
  if (!doc) return;
  const range = opts.range ?? composerContext(st)?.range ?? null;
  if (range) pinRange(range);
  insertIntoComposer(askPrompt(kind, { path: doc.path, range }), true);
  focusComposer();
}

/** 把当前选区加到对话（钉住，直到发送或移除）。 */
export function referenceSelection(): void {
  pinSelection(true);
  focusComposer();
}
