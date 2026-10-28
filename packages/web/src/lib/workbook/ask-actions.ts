// 表格里「交给代理」的快捷提问：先把区域钉成本条消息的上下文（ContextRef），再把提问放进输入框。
// 提问文本只写文件与区域的可读形式；代理以结构化上下文定位文档与修订。

import { fileMention } from "@/components/chat/mention-tokens";

export type AskKind =
  | "save-as-xlsx"
  | "analyze"
  | "explain"
  | "quality"
  | "clean"
  | "trace-formula"
  | "generate-formula"
  | "filter"
  | "chart"
  | "pivot"
  | "dedupe"
  | "sort";

export interface AskAction {
  kind: AskKind;
  label: string;
  title: string;
}

/** 右键菜单与「问 AI」页签共用的动作。 */
export const SELECTION_ASKS: AskAction[] = [
  { kind: "analyze", label: "分析此选区", title: "概括数据结构、关键模式与异常，不改表" },
  { kind: "explain", label: "解释公式/内容", title: "解释字段含义、公式逻辑和可疑内容，不改表" },
  { kind: "quality", label: "检查数据质量", title: "检查空值、重复、类型异常和离群值，先报告" },
  { kind: "clean", label: "提出清洗方案", title: "先提出清洗规则与影响，确认后再改表" },
  { kind: "trace-formula", label: "追踪公式引用", title: "说明先例、依赖以及修改会影响的单元格" },
];

export const FORMULA_ASKS: AskAction[] = [
  { kind: "explain", label: "解释公式", title: "把当前公式的含义和引用讲清楚，不改表" },
  { kind: "trace-formula", label: "追踪引用", title: "查看先例和依赖，说明改这个格子会影响谁" },
  {
    kind: "generate-formula",
    label: "生成公式",
    title: "按表头和邻近数据生成公式，写入前会先说明",
  },
];

export const DATA_ASKS: AskAction[] = [
  { kind: "quality", label: "数据质量", title: "检查空值、重复、类型异常；先报告，不改表" },
  { kind: "filter", label: "筛选方案", title: "列出关键维度和建议条件；需要改表时再确认" },
  { kind: "chart", label: "创建图表", title: "确认图表类型、数据系列和位置后再执行" },
  { kind: "pivot", label: "透视汇总", title: "确认行列字段、汇总方式和输出位置后再执行" },
  { kind: "dedupe", label: "去重", title: "先报告重复行和判定键，再问是否删除" },
  { kind: "sort", label: "排序", title: "先确认排序列和升降序，再写入" },
];

export function askPrompt(kind: AskKind, ctx: { path: string; range?: string | null }): string {
  const target = ctx.range ? `${fileMention(ctx.path)} 的 ${ctx.range}` : fileMention(ctx.path);
  switch (kind) {
    case "save-as-xlsx":
      return `请把 ${fileMention(ctx.path)} 另存为新的 XLSX 文件，保留全部数据，不修改源文件，不覆盖已有文件。完成后提供新文件的打开和下载入口。`;
    case "analyze":
      return `请分析 ${target}：概括数据结构、关键模式、异常和可以继续追问的问题。先分析，不要修改表格。`;
    case "explain":
      return `请解释 ${target} 的字段含义、公式逻辑和可疑内容。对公式说明引用关系；只说明，不要修改表格。`;
    case "quality":
      return `请检查 ${target} 的数据质量：空值、重复、类型不一致、格式异常和可疑离群。给出具体位置和数量，先报告，不要修改表格。`;
    case "clean":
      return `请为 ${target} 制定清洗方案，明确每类问题、拟采用的规则和预计影响。先提出方案，等我确认后再修改表格。`;
    case "trace-formula":
      return `请追踪 ${target} 的公式先例和依赖，并说明修改它会影响哪些单元格。只分析，不要改表。`;
    case "generate-formula":
      return `请根据 ${target} 的表头和邻近数据生成合适的公式。先写出公式并说明，得到确认后再写入。`;
    case "filter":
      return `请分析 ${target} 可以怎么筛选，列出关键维度和建议条件。需要改表时再问我。`;
    case "chart":
      return `请为 ${target} 制定图表方案，确认类型、数据系列和放置位置后再执行。`;
    case "pivot":
      return `请为 ${target} 制定透视汇总方案，确认行列字段、汇总方式和输出位置后再执行。`;
    case "dedupe":
      return `请检查 ${target} 是否有重复行，说明判定键和重复数量。先不要删除。`;
    case "sort":
      return `请把 ${target} 按选区所在列排序。先确认排序列和升降序，再写入。`;
  }
}
