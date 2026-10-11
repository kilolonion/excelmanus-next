import { useLayoutEffect, useRef, useState } from "react";

type Position = {
  following: boolean;
  top: number;
  cursor: number;
  anchor?: { id: string; offset: number };
};

// 仅保存当前浏览器的阅读位置；面板隐藏或切换代理后仍可返回原处。
const positions = new Map<string, Position>();
const BOTTOM_SLOP = 24;

export function useChatScroll(viewKey: string, historyCursor: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const controller = useRef<{ sync: () => void; follow: () => void } | null>(null);
  const [following, setFollowing] = useState(true);
  const cursorRef = useRef(historyCursor);
  cursorRef.current = historyCursor;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const root = rootRef.current;
    if (!viewport || !content || !root) return;
    const position: Position = positions.get(viewKey) ?? {
      following: true,
      top: 0,
      cursor: cursorRef.current,
    };
    let restoring = !position.following;
    let frame = 0;
    let writtenTop: number | null = null;
    let height = viewport.scrollHeight;
    let viewportHeight = viewport.clientHeight;
    let touchY: number | null = null;
    let canResume = false;
    let bottomAtInput = 0;
    let manualUntil = 0;
    let scrollbarPointer: { id: number; y: number } | null = null;
    const nearBottom = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= BOTTOM_SLOP;
    const setFollow = (value: boolean) => {
      position.following = value;
      setFollowing(value);
    };
    const remember = () => {
      position.top = viewport.scrollTop;
      position.cursor = cursorRef.current;
      height = viewport.scrollHeight;
      viewportHeight = viewport.clientHeight;
      if (position.following) {
        position.anchor = undefined;
        return;
      }
      const top = viewport.getBoundingClientRect().top;
      const anchor = [...content.children].find(
        (node) => node.getBoundingClientRect().bottom > top,
      );
      const id = anchor?.getAttribute("data-chat-item");
      position.anchor =
        id && anchor ? { id, offset: anchor.getBoundingClientRect().top - top } : undefined;
    };
    const writeTop = (top: number) => {
      const next = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
      if (Math.abs(viewport.scrollTop - next) > 0.5) {
        viewport.scrollTop = next;
        writtenTop = viewport.scrollTop;
      }
    };
    const sync = () => {
      if (!position.following && performance.now() < manualUntil) {
        // 原生滚动动画/触摸惯性优先，布局观测不能把尚未派发 scroll 的移动拉回。
        if (canResume && viewport.scrollTop >= bottomAtInput - BOTTOM_SLOP) setFollow(true);
        else {
          remember();
          return;
        }
      }
      if (position.following) {
        if (content.dataset.chatEmpty !== "true") writeTop(viewport.scrollHeight);
      } else {
        const anchor = position.anchor;
        const node = anchor
          ? [...content.children].find(
              (child) => child.getAttribute("data-chat-item") === anchor.id,
            )
          : undefined;
        const targetTop =
          node && anchor
            ? viewport.scrollTop +
              node.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top -
              anchor.offset
            : position.top;
        // 返回会话时日志逐条回放，锚点与其下方内容尚未到达前不覆盖保存的位置。
        if (
          restoring &&
          cursorRef.current < position.cursor &&
          (!node || viewport.scrollHeight - viewport.clientHeight < targetTop)
        )
          return;
        restoring = false;
        writeTop(targetTop);
      }
      remember();
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };
    const release = () => {
      if (content.dataset.chatEmpty === "true") return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      writtenTop = null;
      restoring = false;
      canResume = false;
      setFollow(false);
      remember();
    };
    const follow = () => {
      restoring = false;
      setFollow(true);
      sync();
    };
    const scroll = () => {
      if (content.dataset.chatEmpty === "true") {
        remember();
        return;
      }
      if (restoring) {
        schedule();
        return;
      }
      const top = viewport.scrollTop;
      if (writtenTop !== null && Math.abs(top - writtenTop) < 1) {
        writtenTop = null;
        return;
      }
      writtenTop = null;
      // 内容缩短和视口改变产生的浏览器校正不是用户滚动。
      if (height !== viewport.scrollHeight || viewportHeight !== viewport.clientHeight) {
        const clamped = Math.max(
          0,
          Math.min(position.top, viewport.scrollHeight - viewport.clientHeight),
        );
        if (Math.abs(top - clamped) < 1) {
          schedule();
          return;
        }
      }
      if (top < position.top - 0.5) {
        // 向下的原生动画仍可能停在旧底部，不把它的尾帧误认作向上阅读。
        if (position.following && canResume && performance.now() < manualUntil) {
          manualUntil = performance.now() + 200;
          schedule();
          return;
        }
        setFollow(false);
      } else if (canResume && (nearBottom() || top >= bottomAtInput - BOTTOM_SLOP)) setFollow(true);
      if (Math.abs(top - position.top) > 0.5) manualUntil = performance.now() + 200;
      remember();
    };
    const nestedScroll = (target: EventTarget | null) => {
      let node = target instanceof Element ? target : null;
      while (node && node !== viewport && viewport.contains(node)) {
        if (
          node.scrollHeight > node.clientHeight &&
          /auto|scroll/.test(getComputedStyle(node).overflowY)
        )
          return true;
        node = node.parentElement;
      }
      return false;
    };
    const wheel = (event: WheelEvent) => {
      if (content.dataset.chatEmpty === "true") return;
      if (event.ctrlKey || nestedScroll(event.target)) return;
      if (event.deltaY !== 0) manualUntil = performance.now() + 300;
      if (event.deltaY < 0) release();
      else if (event.deltaY > 0) {
        canResume = true;
        bottomAtInput = viewport.scrollHeight - viewport.clientHeight;
        // 合成线程可能仍使用上一帧的底部；本次滚轮足以到达底部时直接恢复跟随。
        if (
          nearBottom() ||
          (event.deltaMode === 0 &&
            viewport.scrollTop + event.deltaY >= bottomAtInput - BOTTOM_SLOP)
        )
          follow();
      }
    };
    const touchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchY === null || nestedScroll(event.target)) return;
      manualUntil = performance.now() + 300;
      if (y > touchY) release();
      else if (y < touchY) {
        canResume = true;
        bottomAtInput = viewport.scrollHeight - viewport.clientHeight;
        if (nearBottom()) follow();
      }
      touchY = y;
    };
    const keyDown = (event: KeyboardEvent) => {
      if (content.dataset.chatEmpty === "true") return;
      const target = event.target;
      if (nestedScroll(target)) return;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, [contenteditable="true"], [role="combobox"], [role="listbox"]',
        )
      )
        return;
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        manualUntil = performance.now() + 300;
        release();
      } else if (event.key === "End") {
        event.preventDefault();
        follow();
      } else if (["ArrowDown", "PageDown", " "].includes(event.key)) {
        manualUntil = performance.now() + 300;
        canResume = true;
        bottomAtInput = viewport.scrollHeight - viewport.clientHeight;
        if (nearBottom()) follow();
      }
    };
    const pointerDown = (event: PointerEvent) => {
      // 选择文字、展开历史详情、拖动滚动条时，将滚动交还用户。
      if (event.button === 0 && !nestedScroll(event.target)) {
        release();
        const onScrollbar = event.target instanceof Node && !viewport.contains(event.target);
        scrollbarPointer = onScrollbar ? { id: event.pointerId, y: event.clientY } : null;
        if (onScrollbar) manualUntil = performance.now() + 300;
        bottomAtInput = viewport.scrollHeight - viewport.clientHeight;
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (scrollbarPointer?.id !== event.pointerId) return;
      manualUntil = performance.now() + 300;
      if (event.clientY < scrollbarPointer.y) release();
      else if (event.clientY > scrollbarPointer.y) canResume = true;
      scrollbarPointer.y = event.clientY;
      bottomAtInput = viewport.scrollHeight - viewport.clientHeight;
    };
    const pointerUp = () => {
      scrollbarPointer = null;
    };
    setFollowing(position.following);
    if (content.dataset.chatEmpty === "true") writeTop(0);
    sync();
    controller.current = { sync: schedule, follow };
    viewport.addEventListener("scroll", scroll, { passive: true });
    root.addEventListener("wheel", wheel, { capture: true, passive: true });
    root.addEventListener("touchstart", touchStart, { capture: true, passive: true });
    root.addEventListener("touchmove", touchMove, { capture: true, passive: true });
    root.addEventListener("keydown", keyDown, true);
    root.addEventListener("pointerdown", pointerDown, true);
    root.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerUp, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    observer.observe(viewport);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", scroll);
      root.removeEventListener("wheel", wheel, true);
      root.removeEventListener("touchstart", touchStart, true);
      root.removeEventListener("touchmove", touchMove, true);
      root.removeEventListener("keydown", keyDown, true);
      root.removeEventListener("pointerdown", pointerDown, true);
      root.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerUp, true);
      // 切换视图时 DOM 可能已换成下一组消息，保存上一次观测的位置。
      positions.delete(viewKey);
      positions.set(viewKey, { ...position });
      if (positions.size > 30) positions.delete(positions.keys().next().value as string);
      controller.current = null;
    };
  }, [viewKey]);

  // React 更新、断线重连回放与瞬时消息落定都经同一个滚动控制器。
  useLayoutEffect(() => controller.current?.sync());

  return {
    rootRef,
    viewportRef,
    contentRef,
    following,
    followLatest: () => controller.current?.follow(),
  };
}
