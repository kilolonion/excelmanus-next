import { useEffect, useState } from "react";

export interface GuideViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

function readViewport(): GuideViewport {
  if (typeof window === "undefined") return { left: 0, top: 0, width: 1024, height: 768 };
  const viewport = window.visualViewport;
  const style = getComputedStyle(document.documentElement);
  const inset = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  const left = inset("--sal");
  const right = inset("--sar");
  const top = inset("--sat");
  const bottom = inset("--sab");
  return {
    left: (viewport?.offsetLeft ?? 0) + left,
    top: (viewport?.offsetTop ?? 0) + top,
    width: Math.max(1, (viewport?.width ?? window.innerWidth) - left - right),
    height: Math.max(1, (viewport?.height ?? window.innerHeight) - top - bottom),
  };
}

/** 向导的可视区域几何（含软键盘与安全区）。 */
export function useGuideViewport(): GuideViewport {
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewport(readViewport()));
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  return viewport;
}
