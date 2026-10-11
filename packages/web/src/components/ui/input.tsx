import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { useFieldIds } from "./field.tsx";

const controlBase =
  "w-full min-w-0 rounded-md border border-border-strong bg-card text-foreground placeholder:text-muted-foreground/80 transition-[border-color,box-shadow,background-color] duration-150 hover:border-input focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring/25 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:outline-destructive/25";

const inputVariants = cva(
  cn(
    controlBase,
    "px-3 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-search-cancel-button]:appearance-none",
  ),
  {
    variants: {
      size: { default: "h-9 text-sm", sm: "h-8 text-xs" },
      mono: { true: "font-mono tabular-nums", false: "" },
    },
    defaultVariants: { size: "default", mono: false },
  },
);

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> &
  VariantProps<typeof inputVariants>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size, mono, id, ...props },
  ref,
) {
  const f = useFieldIds({ id });
  return (
    <input
      ref={ref}
      data-slot="input"
      {...f}
      className={cn(inputVariants({ size, mono }), className)}
      {...props}
    />
  );
});

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(function SearchInput(
  { className, ...props },
  ref,
) {
  return (
    <div data-slot="search-input" className={cn("relative", className)}>
      <Icon
        name="search"
        size="sm"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
      />
      <Input ref={ref} type="search" className="pl-9" {...props} />
    </div>
  );
});

const textareaVariants = cva("", {
  variants: {
    variant: {
      default: cn(controlBase, "min-h-20 px-3 py-2.5 text-sm leading-relaxed"),
      bare: "w-full resize-none border-0 bg-transparent px-0 py-0 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80 focus-visible:outline-none [field-sizing:content] max-h-48",
    },
    mono: { true: "font-mono text-xs", false: "" },
  },
  defaultVariants: { variant: "default", mono: false },
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  VariantProps<typeof textareaVariants>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, variant, mono, id, ...props },
  ref,
) {
  const f = useFieldIds({ id });
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      {...f}
      className={cn(textareaVariants({ variant, mono }), className)}
      {...props}
    />
  );
});
