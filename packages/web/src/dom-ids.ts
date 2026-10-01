// 稳定 DOM 钩子：快捷键与跨组件聚焦只依赖这些 id / data-slot，不依赖样式类名
export const COMPOSER_INPUT_ID = "composer-input";
export const COMPOSER_SUGGEST_ID = "composer-suggest";

export function focusComposer(): HTMLTextAreaElement | null {
  const el = document.getElementById(COMPOSER_INPUT_ID) as HTMLTextAreaElement | null;
  el?.focus();
  return el;
}
