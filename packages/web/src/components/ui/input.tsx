import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { useFieldIds } from "./field.tsx";

const controlBase =
  "w-full min-w-0 rounded-md border border-input bg-card text-foreground placeholder:text-muted-foreground transition-colors focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

const inputVariants = cva(
  cn(
    controlBase,
    "px-2.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-search-cancel-button]:appearance-none",
  ),
  {
    variants: {
      size: { default: "h-8 text-sm", sm: "h-7 text-xs" },
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
    <div className={cn("relative", className)}>
      <Icon
        name="search"
        size="sm"
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input ref={ref} type="search" className="pl-8" {...props} />
    </div>
  );
});

const textareaVariants = cva("", {
  variants: {
    variant: {
      default: cn(controlBase, "min-h-16 px-2.5 py-2 text-sm leading-relaxed"),
      bare: "w-full resize-none border-0 bg-transparent px-0 py-0 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none [field-sizing:content] max-h-48",
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
