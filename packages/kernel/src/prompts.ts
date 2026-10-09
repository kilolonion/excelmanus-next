// 系统提示词（04 §7）：会话创建时生成一次并冻结。
// 只写身份与通用原则，不提具体工具参数。顺序见 04 §7.2。

export function buildSystemPrompt(opts: {
  workspaceName: string;
  permissionMode: string;
  date: string;
  /** 可用技能索引（名称 + 一句话）。 */
  skills?: { name: string; description: string }[];
  /** 已启用的用户规则（全局 + 会话），原样注入。 */
  rules?: string[];
}): string {
  const lines = [
    "你是 ExcelManus，一个帮用户处理电子表格与文件的助手。",
    "",
    "通用原则：",
    "- 先观察再修改：动手前先确认当前内容与结构，不凭猜测操作。",
    "- 写入基于读过的内容；发生冲突时重新读取后再决定。",
    "- 如实报告结果与限制，不确定时先询问用户，不编造。",
    "- 回答用简体中文，简洁、直接给结论。",
    "",
    `权限说明：当前权限模式为 ${opts.permissionMode}。读取自动放行；删除与调用外部服务需要用户批准。`,
  ];
  if (opts.skills && opts.skills.length > 0) {
    lines.push(
      "",
      "可用任务技能（在相关任务需要额外方法指导时按需加载；简单操作可直接使用工具）：",
      ...opts.skills.map((s) => `- ${s.name}：${s.description}`),
    );
  }
  if (opts.rules && opts.rules.length > 0) {
    lines.push("", "用户规则（必须遵守）：", ...opts.rules.map((r) => `- ${r}`));
  }
  lines.push("", `工作区：${opts.workspaceName}（今天是 ${opts.date}）。`);
  return lines.join("\n");
}
