import { useEffect, useState } from "react";

// 响应式断点定义
const MOBILE_BREAKPOINT = 768; // 手机端
const TABLET_BREAKPOINT = 1024; // 平板端
const DESKTOP_BREAKPOINT = 1280; // 桌面端（三栏布局最小宽度）

/** SSR-safe: returns false on server, synchronous check on client */
export function getIsMobile() {
  if (typeof window === "undefined") return false;
  return window.innerWidth < MOBILE_BREAKPOINT;
}

/** 检查是否为平板尺寸 */
export function getIsTablet() {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= MOBILE_BREAKPOINT && window.innerWidth < TABLET_BREAKPOINT;
}

/** 检查是否支持三栏布局（桌面端） */
export function getIsDesktop() {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= DESKTOP_BREAKPOINT;
}

/** 检查是否为中等屏幕（平板到小桌面） */
export function getIsMediumScreen() {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= TABLET_BREAKPOINT && window.innerWidth < DESKTOP_BREAKPOINT;
}

type MediaSubscription = {
  query: MediaQueryList;
  listeners: Set<(matches: boolean) => void>;
  changed: () => void;
};
const subscriptions = new Map<string, MediaSubscription>();

/** One browser listener per breakpoint, released when its last view unmounts. */
function subscribe(query: string, listener: (matches: boolean) => void) {
  let shared = subscriptions.get(query);
  if (!shared) {
    const media = window.matchMedia(query);
    const listeners = new Set<(matches: boolean) => void>();
    const changed = () => {
      const matches = media.matches;
      for (const notify of listeners) notify(matches);
    };
    shared = { query: media, listeners, changed };
    media.addEventListener("change", changed);
    subscriptions.set(query, shared);
  }
  shared.listeners.add(listener);
  listener(shared.query.matches);
  return () => {
    if (!shared.listeners.delete(listener)) return;
    if (!shared.listeners.size) {
      shared.query.removeEventListener("change", shared.changed);
      subscriptions.delete(query);
    }
  };
}

function useBreakpoint(query: string, initial: () => boolean) {
  const [matches, setMatches] = useState(initial);
  useEffect(() => subscribe(query, setMatches), [query]);
  return matches;
}

export function useIsMobile() {
  return useBreakpoint(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`, getIsMobile);
}

export function useIsTablet() {
  return useBreakpoint(
    `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`,
    getIsTablet,
  );
}

export function useIsDesktop() {
  return useBreakpoint(`(min-width: ${DESKTOP_BREAKPOINT}px)`, getIsDesktop);
}

export function useIsMediumScreen() {
  return useBreakpoint(
    `(min-width: ${TABLET_BREAKPOINT}px) and (max-width: ${DESKTOP_BREAKPOINT - 1}px)`,
    getIsMediumScreen,
  );
}
