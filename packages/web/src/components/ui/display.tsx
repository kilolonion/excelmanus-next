// 展示类组件：Badge/StatusDot/statusTone、Card、Alert、EmptyState、Separator、RangeChip、NavItem
import * as SEP from "@radix-ui/react-separator";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { cn } from "./cn.ts";

export type Tone = "neutral" | "read" | "warn" | "ok" | "err" | "outline";

/** 状态 → 色调的唯一映射 */
export function statusTone(status: string | null | undefined): Exclude<Tone, "outline"> {
  switch (status) {
    case "ok":
    case "done":
    case "completed":
    case "connected":
    case "succeeded":
    case "success":
      return "ok";
    case "error":
    case "err":
    case "failed":
      return "err";
    case "pending":
    case "uncertain":
    case "blocked":
    case "queued":
    case "interrupted":
    case "in_progress":
    case "waiting":
    case "connecting":
      return "warn";
    case "running":
      return "read";
    default:
      return "neutral";
  }
}

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs border px-1.5 text-2xs font-medium leading-none whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-transparent bg-muted/80 text-foreground-secondary",
        read: "border-transparent bg-read-soft text-read-ink",
        warn: "border-transparent bg-warn-soft text-warn-ink",
        ok: "border-transparent bg-ok-soft text-ok-ink",
        err: "border-transparent bg-destructive-soft text-destructive-ink",
        outline: "border-border bg-transparent text-foreground-secondary",
      },
      mono: { true: "font-mono tabular-nums slashed-zero", false: "" },
    },
    defaultVariants: { tone: "neutral", mono: false },
  },
);

export function Badge({
  className,
  tone,
  mono,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone, mono }), className)} {...props} />
  );
}

const DOT: Record<Exclude<Tone, "outline">, string> = {
  neutral: "bg-muted-foreground/60",
  read: "bg-read",
  warn: "bg-warn",
  ok: "bg-ok",
  err: "bg-destructive",
};

export function StatusDot({
  tone,
  pulse,
  label,
  className,
}: {
  tone: Exclude<Tone, "outline">;
  pulse?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <span data-slot="status-dot" className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping",
            DOT[tone],
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT[tone])} />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

const cardVariants = cva("rounded-lg bg-card text-foreground", {
  variants: {
    elevation: { flat: "border border-border", raised: "shadow-card" },
    accent: {
      none: "",
      warn: "border-l-[3px] border-l-warn",
      read: "border-l-[3px] border-l-read",
      err: "border-l-[3px] border-l-destructive",
    },
  },
  defaultVariants: { elevation: "flat", accent: "none" },
});

export const Card = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants> & { asChild?: boolean }
>(function Card({ className, elevation, accent, asChild, ...props }, ref) {
  const C = asChild ? Slot : "div";
  return (
    <C
      ref={ref}
      data-slot="card"
      data-elevation={elevation ?? "flat"}
      className={cn(cardVariants({ elevation, accent }), className)}
      {...props}
    />
  );
});

const alertVariants = cva("flex gap-3 text-sm leading-relaxed", {
  variants: {
    tone: {
      info: "border-read/30 bg-read-soft text-read-ink",
      warn: "border-warn/40 bg-warn-soft text-warn-ink",
      err: "border-destructive/30 bg-destructive-soft text-destructive-ink",
      ok: "border-ok/30 bg-ok-soft text-ok-ink",
      muted: "border-border bg-muted text-foreground-secondary",
    },
    layout: {
      block: "items-start rounded-lg border px-4 py-3.5",
      bar: "items-center border-b px-4 py-2 text-xs",
      inline: "items-start rounded-md border px-2.5 py-1.5 text-xs",
    },
  },
  defaultVariants: { tone: "info", layout: "block" },
});

const ALERT_ICON: Record<string, IconName> = {
  info: "info",
  warn: "alert",
  err: "circleAlert",
  ok: "circleCheck",
  muted: "info",
};

export function Alert({
  tone = "info",
  layout = "block",
  icon,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & { icon?: IconName | false }) {
  return (
    <div
      data-slot="alert"
      data-tone={tone}
      data-layout={layout}
      className={cn(alertVariants({ tone, layout }), className)}
      {...props}
    >
      {icon !== false && (
        <Icon
          name={icon ?? ALERT_ICON[tone ?? "info"] ?? "info"}
          size={layout === "block" ? "md" : "sm"}
          className={layout === "block" ? "mt-0.5" : "mt-px"}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </div>
  );
}

export function AlertTitle({ children }: { children: ReactNode }) {
  return <div className="font-semibold">{children}</div>;
}

export function AlertActions({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap items-center gap-2">{children}</div>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  size = "section",
  className,
}: {
  icon?: IconName | ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: "page" | "section" | "inline";
  className?: string;
}) {
  if (size === "inline") {
    return <p className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}>{title}</p>;
  }
  const iconNode =
    typeof icon === "string" ? (
      <span
        className={cn(
          "flex items-center justify-center text-foreground-secondary",
          size === "page" ? "mb-1 size-12 rounded-lg bg-muted" : "size-9",
        )}
      >
        <Icon name={icon as IconName} size={size === "page" ? "lg" : "md"} />
      </span>
    ) : (
      icon
    );
  return (
    <div
      data-slot="empty-state"
      data-size={size}
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        size === "page" ? "py-16" : "px-6 py-10",
        className,
      )}
    >
      {iconNode}
      <div className={cn("font-medium text-foreground", size === "page" ? "text-xl" : "text-sm")}>
        {title}
      </div>
      {description && (
        <div
          className={cn(
            "max-w-md leading-relaxed text-muted-foreground",
            size === "page" ? "text-sm" : "text-xs",
          )}
        >
          {description}
        </div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Separator({
  orientation = "horizontal",
  className,
}: {
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  return (
    <SEP.Root
      orientation={orientation}
      decorative
      className={cn(
        "shrink-0 bg-border",
        orientation === "vertical" ? "w-px self-stretch" : "h-px w-full",
        className,
      )}
    />
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("text-2xs font-medium text-muted-foreground", className)}>{children}</span>
  );
}

export type ChipTone = "selected" | "pinned" | "read" | "pending" | "changed" | "empty";

const CHIP: Record<ChipTone, { cls: string; icon: IconName }> = {
  selected: { cls: "border-border-strong bg-card text-foreground", icon: "target" },
  pinned: { cls: "border-read/50 bg-read-soft text-read-ink", icon: "pin" },
  read: { cls: "border-dashed border-read/50 bg-read-soft text-read-ink", icon: "eye" },
  pending: { cls: "border-dashed border-warn bg-warn-soft text-warn-ink", icon: "pencil" },
  changed: { cls: "border-ok/50 bg-ok-soft text-ok-ink", icon: "check" },
  empty: {
    cls: "border-dashed border-border-strong bg-transparent text-muted-foreground",
    icon: "target",
  },
};

/** 区域徽标：等宽区域、文件名截断；tone 带固定图标，不只靠颜色 */
export const RangeChip = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    range: ReactNode;
    file?: string | null;
    tone?: ChipTone;
    actions?: ReactNode;
    noIcon?: boolean;
  }
>(function RangeChip(
  { range, file, tone = "read", actions, noIcon, className, onClick, ...props },
  ref,
) {
  const t = CHIP[tone];
  const body = (
    <>
      {!noIcon && <Icon name={t.icon} size="xs" className="opacity-80" />}
      {file && (
        <>
          <span className="max-w-40 truncate font-sans">{file}</span>
          <span aria-hidden className="opacity-50">
            ·
          </span>
        </>
      )}
      <span className="truncate font-mono tabular-nums slashed-zero">{range}</span>
    </>
  );
  const cls = cn(
    "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-xs border px-2 text-xs whitespace-nowrap",
    t.cls,
    className,
  );
  if (!onClick && !actions) {
    return (
      <span data-slot="range-chip" className={cls}>
        {body}
      </span>
    );
  }
  return (
    <span data-slot="range-chip" className={cn(cls, actions && "pr-0.5")}>
      {onClick ? (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          className="inline-flex min-w-0 items-center gap-1 rounded-xs hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          {...props}
        >
          {body}
        </button>
      ) : (
        body
      )}
      {actions && <span className="ml-0.5 inline-flex items-center">{actions}</span>}
    </span>
  );
});

/** 侧栏/设置导航共用项：actions 在悬停/聚焦/当前项时显示并隐藏 meta */
export const NavItem = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: ReactNode;
    meta?: ReactNode;
    actions?: ReactNode;
    current?: boolean;
    muted?: boolean;
  }
>(function NavItem({ icon, meta, actions, current, muted, className, children, ...props }, ref) {
  return (
    <div
      className={cn(
        "group/nav relative flex h-9 min-w-0 items-center rounded-md text-sm transition-colors duration-150",
        current
          ? "bg-accent/80 font-medium text-foreground"
          : "text-foreground-secondary hover:bg-accent/60 hover:text-foreground",
        muted && "text-muted-foreground",
        className,
      )}
      data-slot="nav-item"
      data-current={current || undefined}
    >
      <button
        ref={ref}
        type="button"
        aria-current={current ? "page" : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        {...props}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {meta && !actions && (
          <span
            data-slot="nav-meta"
            className="shrink-0 text-2xs text-muted-foreground tabular-nums"
          >
            {meta}
          </span>
        )}
      </button>
      {actions && (
        <span
          data-slot="nav-trailing"
          className="mr-1 inline-grid shrink-0 items-center justify-items-end"
        >
          {meta && (
            <span
              data-slot="nav-meta"
              className={cn(
                "col-start-1 row-start-1 pr-1.5 text-2xs text-muted-foreground tabular-nums group-focus-within/nav:invisible group-hover/nav:invisible",
                current && "invisible",
              )}
            >
              {meta}
            </span>
          )}
          <span
            data-slot="nav-actions"
            className={cn(
              "pointer-events-none col-start-1 row-start-1 flex items-center opacity-0 transition-opacity duration-150 group-focus-within/nav:pointer-events-auto group-focus-within/nav:opacity-100 group-hover/nav:pointer-events-auto group-hover/nav:opacity-100",
              current && "pointer-events-auto opacity-100",
            )}
          >
            {actions}
          </span>
        </span>
      )}
    </div>
  );
});
