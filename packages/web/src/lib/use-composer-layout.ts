import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** Text commits size once; parent height changes caused by that sizing do not feed back. */
export function useComposerLayout(
  text: string,
  textarea: RefObject<HTMLTextAreaElement | null>,
  backdrop: RefObject<HTMLDivElement | null>,
) {
  const frame = useRef<number | undefined>(undefined);
  const syncScroll = useCallback(() => {
    const el = textarea.current,
      mirror = backdrop.current;
    if (!el || !mirror) return;
    const width = `${el.clientWidth}px`;
    if (mirror.style.width !== width) mirror.style.width = width;
    if (mirror.scrollTop !== el.scrollTop) mirror.scrollTop = el.scrollTop;
    if (mirror.scrollLeft !== el.scrollLeft) mirror.scrollLeft = el.scrollLeft;
  }, [textarea, backdrop]);
  const resize = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    const height = Math.min(el.scrollHeight, 180);
    el.style.height = `${height}px`;
    el.style.overflow = height >= 180 ? "auto" : "hidden";
    syncScroll();
  }, [textarea, syncScroll]);
  useLayoutEffect(() => {
    void text;
    resize();
  }, [text, resize]);
  useEffect(() => {
    const parent = textarea.current?.parentElement;
    if (!parent) return;
    let width = parent.getBoundingClientRect().width;
    const schedule = () => {
      if (frame.current !== undefined) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        resize();
      });
    };
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next === undefined || next === width) return;
      width = next;
      schedule();
    });
    observer.observe(parent);
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    fonts?.addEventListener("loadingdone", schedule);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener("loadingdone", schedule);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [textarea, resize]);
  return syncScroll;
}
