import * as S from "@radix-ui/react-select";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { useFieldIds } from "./field.tsx";

/** Radix 不允许空字符串值：用此常量表示"无/自动/与主对话相同" */
export const NONE = "__none__";

export const Select = S.Root;
export const SelectGroup = S.Group;
export const SelectValue = S.Value;

const triggerVariants = cva(
  "group/select inline-flex min-w-0 items-center justify-between gap-2 rounded-md text-left transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring/25 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate aria-invalid:border-destructive aria-invalid:focus-visible:outline-destructive/25",
  {
    variants: {
      variant: {
        default:
          "w-full border border-border-strong bg-card text-foreground hover:border-input focus-visible:border-ring data-[state=open]:border-ring disabled:bg-muted",
        ghost:
          "text-foreground-secondary hover:bg-accent/70 hover:text-foreground data-[state=open]:bg-accent/70 data-[state=open]:text-foreground",
      },
      size: { default: "h-9 px-3 text-sm", sm: "h-8 px-2.5 text-xs", xs: "h-7 px-2 text-xs" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export const SelectTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof S.Trigger> &
    VariantProps<typeof triggerVariants> & { icon?: IconName }
>(function SelectTrigger({ className, variant, size, icon, id, children, ...props }, ref) {
  const f = useFieldIds({ id });
  return (
    <S.Trigger
      ref={ref}
      data-slot="select-trigger"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      {...f}
      className={cn(triggerVariants({ variant, size }), className)}
      {...props}
    >
      {icon && <Icon name={icon} size="xs" className="text-muted-foreground" />}
      {children ?? <S.Value />}
      <S.Icon asChild>
        <Icon
          name="chevronDown"
          size="xs"
          className="ml-auto text-muted-foreground transition-transform duration-150 group-data-[state=open]/select:rotate-180 motion-reduce:transition-none"
        />
      </S.Icon>
    </S.Trigger>
  );
});

export const SelectContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof S.Content>>(
  function SelectContent({ className, children, position = "popper", ...props }, ref) {
    return (
      <S.Portal>
        <S.Content
          ref={ref}
          data-slot="select-content"
          position={position}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "relative z-[10100] max-h-[min(320px,var(--radix-select-content-available-height,320px))] min-w-[10rem] overflow-hidden rounded-lg border border-border bg-popover text-foreground shadow-popover",
            "origin-[var(--radix-select-content-transform-origin)] animate-in fade-in-0 zoom-in-98 duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
            position === "popper" &&
              "min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-16px)]",
            className,
          )}
          {...props}
        >
          <S.ScrollUpButton className="flex h-6 items-center justify-center bg-popover text-muted-foreground">
            <Icon name="chevronDown" size="xs" className="rotate-180" />
          </S.ScrollUpButton>
          <S.Viewport className="p-1.5">{children}</S.Viewport>
          <S.ScrollDownButton className="flex h-6 items-center justify-center bg-popover text-muted-foreground">
            <Icon name="chevronDown" size="xs" />
          </S.ScrollDownButton>
        </S.Content>
      </S.Portal>
    );
  },
);

export const SelectItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof S.Item> & { description?: ReactNode }
>(function SelectItem({ className, children, description, ...props }, ref) {
  return (
    <S.Item
      ref={ref}
      data-slot="select-item"
      className={cn(
        "relative flex min-h-8 cursor-default select-none flex-col justify-center gap-0.5 rounded-md py-2 pr-3 pl-8 text-sm leading-snug outline-none transition-colors duration-100 data-[state=checked]:font-medium data-[state=checked]:text-foreground data-[highlighted]:bg-accent/70 data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        className,
      )}
      {...props}
    >
      <span className="absolute top-2.5 left-2.5 flex size-3.5 items-center justify-center text-foreground-secondary">
        <S.ItemIndicator>
          <Icon name="check" size="xs" />
        </S.ItemIndicator>
      </span>
      <S.ItemText>{children}</S.ItemText>
      {description && (
        <span className="break-words text-xs font-normal leading-relaxed text-muted-foreground">
          {description}
        </span>
      )}
    </S.Item>
  );
});

export function SelectLabel({ children }: { children: ReactNode }) {
  return (
    <S.Label
      data-slot="select-label"
      className="px-2.5 pt-2 pb-1.5 text-2xs font-medium text-muted-foreground"
    >
      {children}
    </S.Label>
  );
}

export function SelectSeparator() {
  return <S.Separator className="mx-1 my-1.5 h-px bg-border" />;
}

/** 常用简化：选项数组 → Select */
export function SimpleSelect<V extends string>({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  size,
  variant,
  icon,
  disabled,
  required,
  className,
  contentClassName,
  selectedLabel,
  onOpenChange,
}: {
  value: V | "";
  onChange: (v: V) => void;
  options: readonly { value: V; label: ReactNode; description?: ReactNode }[];
  placeholder?: string;
  ariaLabel?: string;
  size?: "default" | "sm" | "xs";
  variant?: "default" | "ghost";
  icon?: IconName;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  contentClassName?: string;
  selectedLabel?: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Select
      value={value === "" ? undefined : value}
      onValueChange={(v) => {
        if (options.some((o) => o.value === v)) onChange(v as V);
      }}
      disabled={disabled}
      onOpenChange={onOpenChange}
      required={required}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        size={size}
        variant={variant}
        icon={icon}
        className={className}
      >
        <SelectValue placeholder={placeholder}>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} description={o.description}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
