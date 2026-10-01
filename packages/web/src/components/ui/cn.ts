import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 登记自定义字号与阴影刻度，避免 text-md 与文字颜色、shadow-card 与阴影颜色被误判为同组冲突
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "xs", "sm", "base", "md", "lg", "xl", "2xl"],
      shadow: ["xs", "card", "popover", "dialog"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
