import type { ReactNode } from "react";
import { cn } from "./cn.ts";

export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Kbd({
  children,
  className,
  inverted,
}: {
  children: ReactNode;
  className?: string;
  inverted?: boolean;
}) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-b-2 px-1.5 font-mono text-2xs font-medium",
        inverted
          ? "border-primary-foreground/30"
          : "border-border-strong bg-muted text-foreground-secondary",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** 按平台显示修饰键：keys 为不含修饰键的键名，如 "," "B"；mod=false 时不加修饰键 */
export function Shortcut({
  keys,
  mod = true,
  className,
  inverted,
}: {
  keys: string;
  mod?: boolean;
  className?: string;
  inverted?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {mod && <Kbd inverted={inverted}>{isMac ? "⌘" : "Ctrl"}</Kbd>}
      <Kbd inverted={inverted}>{keys}</Kbd>
    </span>
  );
}
