// 把工具名和参数转成用户能读懂的动作标题与上下文（二代工具集，06 工具表）。不编造缺失数字。

import type { LucideIcon } from "lucide-react";
import {
  Bookmark,
  Camera,
  ChartColumn,
  FileOutput,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderCog,
  ListChecks,
  MessageCircleQuestionMark,
  Presentation,
  Search,
  Send,
  Shapes,
  Sparkles,
  SquareCode,
  Table2,
  Timer,
  UserPlus,
  Users,
  Wrench,
} from "lucide-react";
import { fileName } from "@/lib/paths";

type Args = Record<string, unknown> | undefined;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const WRITE_TOOLS = new Set([
  "workbook_edit",
  "workbook_export",
  "write",
  "edit",
  "files",
  "run_script",
]);
const READ_TOOLS = new Set([
  "workbook_read",
  "workbook_analyze",
  "workbook_render",
  "read",
  "find",
]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

/** 不在对话流里单独成卡的内部工具：todo 以任务清单展示，present 以呈现卡展示，ask_user 以提问卡展示。 */
export function isChromeTool(name: string): boolean {
  return name === "todo" || name === "present";
}

export function isAgentTool(name: string): boolean {
  return name.startsWith("agent_");
}

export function mcpToolParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m?.[1] && m[2] ? { server: m[1], tool: m[2] } : null;
}

const ICONS: Record<string, LucideIcon> = {
  workbook_read: Table2,
  workbook_edit: Shapes,
  workbook_analyze: ChartColumn,
  workbook_export: FileOutput,
  workbook_render: Camera,
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  find: FileSearch,
  files: FolderCog,
  run_script: SquareCode,
  ask_user: MessageCircleQuestionMark,
  present: Presentation,
  todo: ListChecks,
  memory: Bookmark,
  skill: Sparkles,
  agent_spawn: UserPlus,
  agent_send: Send,
  agent_wait: Timer,
  agent_status: Users,
  agent_control: Users,
};

export function toolIcon(name: string): LucideIcon {
  return (
    ICONS[name] ?? (name.startsWith("mcp__") ? Wrench : name.includes("search") ? Search : Wrench)
  );
}

export function toolStatusIconClass(status: string): string {
  if (status === "error") return "text-red-500";
  if (status === "pending" || status === "approval" || status === "question")
    return "text-amber-500";
  if (status === "running" || status === "streaming")
    return "text-muted-foreground animate-tool-running-pulse";
  return "text-[var(--em-primary)]";
}

const EDIT_OP_TITLES: Record<string, string> = {
  "cells.set": "写入单元格",
  "cells.fill": "填充单元格",
  "cells.clear": "清除内容",
  "style.set": "设置格式",
  "rows.insert": "插入行",
  "rows.delete": "删除行",
  "cols.insert": "插入列",
  "cols.delete": "删除列",
  "rows.height": "调整行高",
  "cols.width": "调整列宽",
  "axis.hide": "隐藏行列",
  "axis.group": "分组行列",
  "axis.size": "调整行列尺寸",
  "sheet.add": "新建工作表",
  "sheet.copy": "复制工作表",
  "sheet.delete": "删除工作表",
  "sheet.rename": "重命名工作表",
  "sheet.move": "移动工作表",
  "sheet.hide": "隐藏工作表",
  merge: "合并单元格",
  unmerge: "取消合并",
  freeze: "冻结窗格",
  sort: "排序",
  "filter.set": "设置筛选",
  "cf.add": "添加条件格式",
  "cf.remove": "移除条件格式",
  "dv.add": "添加数据验证",
  "dv.remove": "移除数据验证",
  "chart.add": "插入图表",
  "chart.update": "更新图表",
  "chart.delete": "删除图表",
  "image.add": "插入图片",
  "hyperlink.set": "设置超链接",
  find_replace: "查找替换",
  recalculate: "重新计算",
};

function editOps(args: Args): string[] {
  const ops = args?.ops;
  if (!Array.isArray(ops)) return [];
  return ops.flatMap((op) =>
    op && typeof op === "object" && typeof (op as { op?: unknown }).op === "string"
      ? [(op as { op: string }).op]
      : [],
  );
}

export function toolActionTitle(name: string, args?: Args): string {
  switch (name) {
    case "workbook_read": {
      const mode = str(args?.mode);
      if (mode === "overview") return "读取工作簿结构";
      if (mode === "search") return "搜索单元格";
      if (mode === "objects") return "查看图表与图片";
      if (mode === "table") return "读取数据表";
      if (mode === "formula_graph") return "追踪公式依赖";
      return "读取单元格";
    }
    case "workbook_edit": {
      const ops = [...new Set(editOps(args))];
      const dry = args?.dryRun === true ? "（预演）" : "";
      if (args?.create === true || args?.template) return `新建工作簿${dry}`;
      if (ops.length === 1) return `${EDIT_OP_TITLES[ops[0] ?? ""] ?? "修改工作簿"}${dry}`;
      return `修改工作簿${dry}`;
    }
    case "workbook_analyze": {
      const mode = str(args?.mode);
      if (mode === "sql") return "查询数据";
      if (mode === "profile") return "统计数据概况";
      if (mode === "diff") return "对比表格";
      if (mode === "check") return "检查数据";
      return "分析工作簿";
    }
    case "workbook_export":
      return args?.mode === "split" ? "拆分工作簿" : "另存工作簿";
    case "workbook_render":
      return "截图核对";
    case "read":
      return "读取文件";
    case "write":
      return "写入文件";
    case "edit":
      return "编辑文件";
    case "find":
      return "查找文件";
    case "files": {
      const ops = Array.isArray(args?.ops) ? (args.ops as { op?: unknown }[]) : [];
      const kinds = new Set(ops.map((o) => o.op));
      if (kinds.size === 1 && kinds.has("delete")) return "删除文件";
      if (kinds.size === 1 && kinds.has("mkdir")) return "新建文件夹";
      if (kinds.size === 1 && kinds.has("backup")) return "备份文件";
      return "管理文件";
    }
    case "run_script":
      return "运行脚本";
    case "ask_user":
      return "询问用户";
    case "present":
      return "呈现结果";
    case "todo":
      return "更新任务清单";
    case "memory":
      return args?.op === "search" || args?.action === "search" ? "查找记忆" : "记住信息";
    case "skill":
      return str(args?.name) ? `加载技能「${str(args?.name)}」` : "加载技能";
    case "agent_spawn":
      return str(args?.name) ? `派生子代理「${str(args?.name)}」` : "派生子代理";
    case "agent_send":
      return "发送代理消息";
    case "agent_wait":
      return "等待子代理";
    case "agent_status":
      return "查看代理状态";
    case "agent_control":
      return "管理子代理";
    default: {
      const mcp = mcpToolParts(name);
      if (mcp) return `${mcp.server} · ${mcp.tool.replace(/_/g, " ")}`;
      return name.replace(/_/g, " ");
    }
  }
}

export interface ToolContext {
  filename?: string;
  sheet?: string;
  range?: string;
  detail?: string;
}

/** 参数里的定位信息：文件、工作表、区域（不读结果，不编造）。 */
export function extractToolContext(name: string, args?: Args): ToolContext {
  if (!args) return {};
  const path = str(args.path) ?? str(args.to);
  const sheet = str(args.sheet);
  const ops = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [];
  const firstRange = str(args.range) ?? ops.map((o) => str(o?.range)).find(Boolean);
  const ctx: ToolContext = {
    ...(path ? { filename: fileName(path) } : {}),
    ...(sheet ? { sheet } : {}),
    ...(firstRange ? { range: firstRange } : {}),
  };
  if (name === "workbook_edit" && ops.length > 1) ctx.detail = `${ops.length} 项操作`;
  if (name === "workbook_analyze" && args.mode === "sql" && str(args.sql)) ctx.detail = "SQL";
  if (name === "find") ctx.detail = str(args.pattern) ?? str(args.query) ?? str(args.glob);
  if (name === "workbook_read" && args.mode === "search") ctx.detail = str(args.query);
  if (name === "files") ctx.detail = ops.length > 1 ? `${ops.length} 项操作` : str(ops[0]?.path);
  return ctx;
}

export function formatToolContextLine(ctx: ToolContext): string | null {
  const parts = [ctx.filename, ctx.sheet, ctx.range, ctx.detail].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function activityGroupTitle(
  tools: { name: string; status: string; args?: unknown }[],
): string {
  if (tools.some((t) => t.status === "approval")) return "等待授权";
  if (tools.length === 0) return "执行步骤";
  if (tools.every((t) => isReadTool(t.name))) return "读取数据";
  if (tools.some((t) => t.name === "workbook_edit")) return "更新工作表";
  if (tools.some((t) => isWriteTool(t.name))) return "处理文件";
  if (tools.every((t) => isAgentTool(t.name))) return "协调子代理";
  return "执行步骤";
}

/** 审批卡标题与说明（按二代审批 effect 区分）。 */
export function approvalCopy(
  toolName: string,
  effect: string,
  ctx: ToolContext,
): { title: string; description: string } {
  if (effect === "destructive")
    return {
      title: "允许执行可能删除或覆盖内容的操作？",
      description: ctx.filename
        ? `将影响 ${ctx.filename}。修改前会自动备份。`
        : "修改前会自动备份。",
    };
  if (effect === "external")
    return {
      title: "允许访问外部服务？",
      description: toolName.startsWith("mcp__")
        ? "将调用已连接的 MCP 工具。"
        : "该操作会联网或调用外部程序。",
    };
  if (toolName === "run_script")
    return { title: "允许运行脚本？", description: "将在隔离沙箱中执行代码，可能会修改工作簿。" };
  if (effect === "write" || isWriteTool(toolName))
    return {
      title: "允许修改文件？",
      description: ctx.filename
        ? `将修改 ${ctx.filename}${ctx.sheet ? `（${ctx.sheet}）` : ""}。会话内首次修改前会自动备份。`
        : "会话内首次修改已有文件前会自动备份。",
    };
  return { title: "允许执行此操作？", description: "该操作需要你的授权后才能继续。" };
}

export const ARGS_VERBATIM_TOOLS = new Set(["run_script", "write", "edit"]);
