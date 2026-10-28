import { Layers, RotateCcw, Sparkles, StopCircle, Undo2 } from "lucide-react";
import React from "react";

export { isVisionImageFile } from "@/lib/file-kind";

/**
 * 斜杠命令（chat-store sendMessage 识别 /model /compact /resume /stop /undo；
 * `/<技能名> 要求` 作为普通消息发送，由服务端注入技能正文）。
 */
export const SLASH_COMMANDS: {
  command: string;
  description: string;
  icon: React.ReactNode;
  args?: string[];
}[] = [
  {
    command: "/skills",
    description: "选择技能",
    icon: React.createElement(Sparkles, { className: "h-3.5 w-3.5" }),
  },
  {
    command: "/model",
    description: "切换当前代理的模型",
    icon: React.createElement(Sparkles, { className: "h-3.5 w-3.5" }),
  },
  {
    command: "/compact",
    description: "压缩上下文",
    icon: React.createElement(Layers, { className: "h-3.5 w-3.5" }),
  },
  {
    command: "/resume",
    description: "继续中断的任务",
    icon: React.createElement(RotateCcw, { className: "h-3.5 w-3.5" }),
  },
  {
    command: "/undo",
    description: "撤销当前表格的最近一次修改",
    icon: React.createElement(Undo2, { className: "h-3.5 w-3.5" }),
  },
  {
    command: "/stop",
    description: "停止当前生成",
    icon: React.createElement(StopCircle, { className: "h-3.5 w-3.5" }),
  },
];

/** 选中后立即执行、不需要再按回车的命令。 */
export const IMMEDIATE_COMMANDS = new Set(["/compact", "/resume", "/stop", "/undo"]);

export interface MentionData {
  skills: { name: string; description: string }[];
  files: string[];
  filesError?: boolean;
  skillsError?: boolean;
}

export type PopoverMode =
  | null
  | "slash"
  | "slash-args"
  | "slash-skills"
  | "slash-model"
  | "at"
  | "at-sub";
