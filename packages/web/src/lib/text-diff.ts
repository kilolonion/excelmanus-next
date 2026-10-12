// 文本改动的展示数据：write / edit 工具的参数里已经有全部内容，前端直接组成增删行，不依赖服务端 diff。

export interface TextDiff {
  path: string;
  /** 统一 diff 风格的行：`@@` 段头、`+` 新增、`-` 删除、` ` 上下文。 */
  hunks: string[];
  additions: number;
  deletions: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** edit：每处替换一段（旧行全部删除、新行全部新增）。 */
export function editDiff(args: unknown): TextDiff | null {
  const a = (args ?? {}) as { path?: unknown; edits?: unknown };
  const path = str(a.path);
  if (!path || !Array.isArray(a.edits)) return null;
  const hunks: string[] = [];
  let additions = 0;
  let deletions = 0;
  a.edits.forEach((raw, i) => {
    const e = (raw ?? {}) as { oldText?: unknown; newText?: unknown; all?: unknown };
    const oldLines = (str(e.oldText) ?? "").split("\n");
    const newLines = (str(e.newText) ?? "").split("\n");
    hunks.push(`@@ 第 ${i + 1} 处替换${e.all === true ? "（全部匹配）" : ""} @@`);
    for (const line of oldLines) hunks.push(`-${line}`);
    for (const line of newLines) hunks.push(`+${line}`);
    deletions += oldLines.length;
    additions += newLines.length;
  });
  return { path, hunks, additions, deletions };
}

/** write：整文件内容视为新增。 */
export function writeDiff(args: unknown): TextDiff | null {
  const a = (args ?? {}) as { path?: unknown; content?: unknown };
  const path = str(a.path);
  const content = str(a.content);
  if (!path || content === undefined) return null;
  const lines = content.split("\n");
  return {
    path,
    hunks: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)],
    additions: lines.length,
    deletions: 0,
  };
}
