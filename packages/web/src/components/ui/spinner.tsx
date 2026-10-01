import type { HTMLAttributes } from "react";
import { Icon, type IconSize } from "../Icon.tsx";
import { cn } from "./cn.ts";

export function Spinner({
  size = "sm",
  label,
  className,
}: {
  size?: IconSize;
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-slot="spinner"
      className={cn("inline-flex", className)}
      role={label ? "status" : undefined}
    >
      <Icon name="spinner" size={size} className="motion-safe:animate-spin" />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

export function Dots({ className }: { className?: string }) {
  return (
    <span
      data-slot="dots"
      aria-hidden
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="size-1 rounded-full bg-current opacity-60 motion-safe:animate-pulse"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      className={cn("h-4 rounded-md bg-muted motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}
