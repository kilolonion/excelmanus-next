// 界面图标：lucide-react（ISC，随包打包，16 §2.3）。全仓唯一导入 lucide-react 的文件。

import {
  ArrowUp,
  AtSign,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Cpu,
  Download,
  Eye,
  File,
  FileSpreadsheet,
  Folder,
  Hand,
  History,
  Image,
  Info,
  Keyboard,
  ListChecks,
  LoaderCircle,
  LocateFixed,
  type LucideIcon,
  Maximize2,
  MessageSquare,
  Minimize2,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  Quote,
  RotateCcw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Table2,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { S } from "../strings.ts";
import { cn } from "./ui/cn.ts";

const ICONS = {
  plus: Plus,
  settings: Settings,
  chat: MessageSquare,
  sheet: Table2,
  fileSheet: FileSpreadsheet,
  file: File,
  folder: Folder,
  users: Users,
  upload: Upload,
  send: ArrowUp,
  stop: Square,
  x: X,
  pin: Pin,
  pinOff: PinOff,
  check: Check,
  alert: TriangleAlert,
  info: Info,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  chevronsUpDown: ChevronsUpDown,
  sidebar: PanelLeft,
  panelRight: PanelRight,
  expand: Maximize2,
  collapse: Minimize2,
  target: LocateFixed,
  sparkle: Sparkles,
  clock: Clock,
  history: History,
  shield: Shield,
  shieldCheck: ShieldCheck,
  at: AtSign,
  image: Image,
  pencil: Pencil,
  moon: Moon,
  sun: Sun,
  cpu: Cpu,
  user: User,
  sliders: SlidersHorizontal,
  book: BookOpen,
  brain: Brain,
  plug: Plug,
  rules: ListChecks,
  search: Search,
  spinner: LoaderCircle,
  trash: Trash2,
  download: Download,
  restore: RotateCcw,
  eye: Eye,
  monitor: Monitor,
  more: MoreHorizontal,
  keyboard: Keyboard,
  hand: Hand,
  zap: Zap,
  bot: Bot,
  circleCheck: CircleCheck,
  circleX: CircleX,
  circleAlert: CircleAlert,
  copy: Copy,
  quote: Quote,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";

const PX: Record<IconSize, number> = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 };

const PROVIDER_LOGOS: Record<string, string> = {
  openai: "openai",
  chatgpt: "openai",
  anthropic: "anthropic",
  google: "gemini",
  gemini: "gemini",
  deepseek: "deepseek",
  moonshot: "moonshot",
  qwen: "qwen",
  zhipu: "zhipu",
  doubao: "bytedance",
  minimax: "minimax",
  mimo: "xiaomi",
  xai: "xai",
  openrouter: "openrouter",
  ollama: "ollama",
  alibabacloud: "alibabacloud",
  baidu: "baidu",
  bytedance: "bytedance",
  huawei: "huawei",
  huggingface: "huggingface",
  meta: "meta",
  mistral: "mistral",
  nvidia: "nvidia",
  perplexity: "perplexity",
  qq: "qq",
  siliconcloud: "siliconcloud",
  siliconflow: "siliconcloud",
  xiaomi: "xiaomi",
};

const COLOR_LOGOS = new Set(["alibabacloud", "bytedance", "mistral", "nvidia", "perplexity", "qq"]);

export function ProviderLogo({
  provider,
  size = "md",
  className,
  label,
}: {
  provider?: string;
  size?: IconSize;
  className?: string;
  label?: string;
}) {
  const logo = (provider && PROVIDER_LOGOS[provider]) || "default";
  return (
    <img
      src={`/providers/${logo}.svg`}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      width={PX[size]}
      height={PX[size]}
      className={cn("shrink-0 object-contain", !COLOR_LOGOS.has(logo) && "dark:invert", className)}
    />
  );
}

export function ProviderLabel({ provider, children }: { provider?: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 align-middle">
      <ProviderLogo provider={provider} />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function BrandMark({
  className,
  decorative = true,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="32"
      height="32"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : S.appName}
      aria-hidden={decorative || undefined}
      className={cn("brand-mark shrink-0 text-primary", className)}
      fill="currentColor"
    >
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((col) => (
          <rect
            key={`${row}-${col}`}
            x={2 + col * 10}
            y={2 + row * 10}
            width="8"
            height="8"
            rx="1.8"
            opacity={row === 2 && col === 2 ? 0.55 : 1}
          />
        )),
      )}
    </svg>
  );
}

export function Icon({
  name,
  size = "md",
  className,
  label,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
  /** 有 label 时作为可读图片；否则对辅助技术隐藏（旁边已有文字）。 */
  label?: string;
}) {
  const C = ICONS[name];
  return (
    <C
      size={PX[size]}
      strokeWidth={1.75}
      className={cn("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
