import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "excel-panel-width";
const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 360;
const MAX_WIDTH_RATIO = 0.85; // 视口宽度的 85%
const FLOAT_THRESHOLD_RATIO = 0.5; // 超过视口 50% 切换为浮动

export interface ResizablePanelState {
  /** 当前面板宽度 */
  panelWidth: number;
  /** 是否因为宽度超过阈值而进入浮动模式 */
  isFloatingByResize: boolean;
  /** 拖拽手柄的 props，直接展开到手柄元素上 */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
  };
  /** 拖拽进行中 */
  isDragging: boolean;
  /** 重置为默认宽度 */
  resetWidth: () => void;
}

function loadWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const n = Number(v);
      if (n >= MIN_WIDTH && n <= window.innerWidth * MAX_WIDTH_RATIO) return n;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

export function useResizablePanel(enabled: boolean, visible = true): ResizablePanelState {
  const [panelWidth, setPanelWidth] = useState(loadWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1920 : window.innerWidth,
  );
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // 视口宽度变化时确保不越界 + 更新 viewportWidth
  useEffect(() => {
    if (!enabled) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const vw = window.innerWidth;
      setViewportWidth(vw);
      const maxW = vw * MAX_WIDTH_RATIO;
      setPanelWidth((prev) => {
        if (prev > maxW) return Math.max(MIN_WIDTH, maxW);
        return prev;
      });
    };
    const onResize = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [enabled]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled || !visible) return;
      e.preventDefault();
      e.stopPropagation();
      startXRef.current = e.clientX;
      startWidthRef.current = panelWidth;
      setIsDragging(true);
    },
    [enabled, visible, panelWidth],
  );

  // 全局 mousemove / mouseup
  useEffect(() => {
    if (!enabled || !visible) {
      if (isDragging) setIsDragging(false);
      return;
    }
    if (!isDragging) return;
    let frame: number | undefined;
    let latestWidth = startWidthRef.current;
    const clamp = (width: number) =>
      Math.min(window.innerWidth * MAX_WIDTH_RATIO, Math.max(MIN_WIDTH, width));
    const onMouseMove = (e: MouseEvent) => {
      // 面板在右侧，鼠标左移 → 宽度增加。只在下一帧提交最新位置。
      latestWidth = clamp(startWidthRef.current + startXRef.current - e.clientX);
      if (frame === undefined)
        frame = requestAnimationFrame(() => {
          frame = undefined;
          setPanelWidth(latestWidth);
        });
    };
    const onMouseUp = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      latestWidth = clamp(latestWidth);
      setPanelWidth(latestWidth);
      saveWidth(latestWidth);
      setIsDragging(false);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, enabled, visible]);

  // 拖拽中禁用文本选择；关闭或卸载时也恢复原样。
  useEffect(() => {
    if (!isDragging || !enabled || !visible) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [isDragging, enabled, visible]);

  const resetWidth = useCallback(() => {
    setPanelWidth(DEFAULT_WIDTH);
    saveWidth(DEFAULT_WIDTH);
  }, []);

  const onDoubleClick = useCallback(() => {
    resetWidth();
  }, [resetWidth]);

  const isFloatingByResize = enabled && panelWidth > viewportWidth * FLOAT_THRESHOLD_RATIO;

  return {
    panelWidth,
    isFloatingByResize,
    handleProps: { onMouseDown, onDoubleClick },
    isDragging,
    resetWidth,
  };
}

export { DEFAULT_WIDTH, FLOAT_THRESHOLD_RATIO, MIN_WIDTH };
