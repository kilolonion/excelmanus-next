import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { Icon, type IconName, type IconSize } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { Spinner } from "./spinner.tsx";
import { Tip } from "./tooltip.tsx";

export const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,box-shadow] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:bg-primary/80",
        outline:
          "border border-border-strong bg-card text-foreground hover:border-input hover:bg-muted active:bg-accent/70 aria-pressed:bg-accent",
        ghost:
          "text-foreground-secondary hover:bg-accent/70 hover:text-foreground active:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground",
        accent:
          "border border-read/20 bg-read-soft text-read-ink hover:border-read/35 hover:bg-read-soft/80",
        destructive: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        "destructive-outline":
          "border border-destructive/40 bg-card text-destructive hover:bg-destructive-soft",
        "destructive-ghost": "text-destructive hover:bg-destructive-soft",
        link: "h-auto px-0 text-read-ink underline-offset-2 hover:underline",
      },
      size: {
        xs: "h-6 px-2 text-xs rounded-sm",
        sm: "h-8 px-3 text-xs",
        default: "h-9 px-3.5 text-sm",
        lg: "h-10 px-4 text-sm",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-6 rounded-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, loading, disabled, children, type, ...props },
  ref,
) {
  const C = asChild ? Slot : "button";
  return (
    <C
      ref={ref}
      data-slot="button"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <Spinner size="xs" />}
          {children}
        </>
      )}
    </C>
  );
});

const ICON_SIZE: Record<string, IconSize> = { icon: "md", "icon-sm": "sm", "icon-xs": "xs" };

export type IconButtonProps = Omit<ButtonProps, "children" | "size"> & {
  label: string;
  icon: IconName;
  size?: "icon" | "icon-sm" | "icon-xs";
  tooltip?: ReactNode | false;
  shortcut?: string;
  pressed?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "icon-sm", variant = "ghost", tooltip, shortcut, pressed, ...props },
  ref,
) {
  const btn = (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      aria-pressed={pressed}
      {...props}
    >
      <Icon name={icon} size={ICON_SIZE[size] ?? "sm"} />
    </Button>
  );
  if (tooltip === false || props.disabled) return btn;
  return (
    <Tip content={tooltip ?? label} shortcut={shortcut}>
      {btn}
    </Tip>
  );
});
