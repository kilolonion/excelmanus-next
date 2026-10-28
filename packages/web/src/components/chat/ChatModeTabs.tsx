// 聊天模式（一代 ChatModeTabs）：编辑 = 正常执行；问答 = 只读回答；计划 = 先出计划不动文件。
// 后两种模式下服务端拒绝一切写入类工具，选择随消息发送（SendMessageBody.chatMode）。

import { motion, useReducedMotion } from "framer-motion";
import { ClipboardList, Eye, type LucideIcon, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type ChatMode, effectiveChatMode, setChatMode, useChatStore } from "@/stores/chat-store";

const MODES: { key: ChatMode; label: string; desc: string; icon: LucideIcon }[] = [
  { key: "write", label: "编辑", desc: "按需读写表格和文件", icon: Pencil },
  { key: "ask", label: "问答", desc: "只读：回答问题，不改任何文件", icon: Eye },
  { key: "plan", label: "计划", desc: "先给出步骤计划，确认后再切回编辑执行", icon: ClipboardList },
];

export function ChatModeTabs({ compact = false }: { compact?: boolean } = {}) {
  const active = useChatStore((s) => effectiveChatMode(s, s.viewAgentId));
  const reader = useChatStore((s) => s.session.roster[s.viewAgentId]?.role === "reader");
  const reduceMotion = useReducedMotion();
  if (compact)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 shrink-0 px-3"
            aria-label={`聊天模式：${MODES.find((mode) => mode.key === active)?.label ?? "编辑"}`}
          >
            {MODES.find((mode) => mode.key === active)?.label ?? "编辑"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-64 max-w-[calc(100vw-24px)]">
          {MODES.map(({ key, label, desc, icon: Icon }) => (
            <DropdownMenuItem
              key={key}
              disabled={reader && key === "write"}
              className="min-h-14 gap-3"
              onSelect={() => setChatMode(key)}
            >
              <Icon className="size-4" />
              <span>
                <span className="block">
                  {label}
                  {active === key ? " · 当前" : ""}
                </span>
                <span className="block text-xs text-muted-foreground">{desc}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <TooltipProvider delayDuration={400}>
      <div className="em-chat-modes" role="radiogroup" aria-label="聊天模式">
        {MODES.map(({ key, label, desc, icon: Icon }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={active === key}
                disabled={reader && key === "write"}
                onClick={() => setChatMode(key)}
                className="em-chat-mode disabled:cursor-not-allowed disabled:opacity-40"
                data-active={active === key || undefined}
              >
                {active === key && (
                  <motion.span
                    layoutId="em-chat-mode-indicator"
                    className="em-chat-mode-indicator"
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 420, damping: 32 }
                    }
                  />
                )}
                <Icon className="relative z-[1] h-3 w-3" aria-hidden="true" />
                <span className="relative z-[1] hidden sm:inline">{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {reader && key === "write"
                ? "此子代理只有只读权限，不能切换到编辑"
                : `${label}：${desc}`}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
