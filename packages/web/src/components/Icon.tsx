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
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
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
  keyboard: Keyboard,
  hand: Hand,
  zap: Zap,
  bot: Bot,
  circleCheck: CircleCheck,
  circleX: CircleX,
  circleAlert: CircleAlert,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";

const PX: Record<IconSize, number> = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 };

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
