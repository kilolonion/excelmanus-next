// 文本改动的展示数据：write / edit 工具的参数里已经有全部内容，前端直接组成增删行，不依赖服务端 diff。

export interface TextDiff {
  path: string;
  /** 可重复遍历的统一 diff 行；预览只读取需要显示的前几行。 */
  hunks: Iterable<string>;
  additions: number;
  deletions: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function lineCount(text: string): number {
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
  return count;
}

function* prefixedLines(text: string, prefix: string): Generator<string> {
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    yield prefix + text.slice(start, end < 0 ? undefined : end);
    if (end < 0) return;
    start = end + 1;
  }
}

/** edit：每处替换一段（旧行全部删除、新行全部新增）。 */
export function editDiff(args: unknown): TextDiff | null {
  const a = (args ?? {}) as { path?: unknown; edits?: unknown };
  const path = str(a.path);
  if (!path || !Array.isArray(a.edits)) return null;
  let additions = 0;
  let deletions = 0;
  const edits = a.edits.map((raw) => {
    const e = (raw ?? {}) as { oldText?: unknown; newText?: unknown; all?: unknown };
    const oldText = str(e.oldText) ?? "";
    const newText = str(e.newText) ?? "";
    deletions += lineCount(oldText);
    additions += lineCount(newText);
    return { oldText, newText, all: e.all === true };
  });
  return {
    path,
    additions,
    deletions,
    hunks: {
      *[Symbol.iterator]() {
        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i];
          yield `@@ 第 ${i + 1} 处替换${edit.all ? "（全部匹配）" : ""} @@`;
          yield* prefixedLines(edit.oldText, "-");
          yield* prefixedLines(edit.newText, "+");
        }
      },
    },
  };
}

/** write：整文件内容视为新增。 */
export function writeDiff(args: unknown): TextDiff | null {
  const a = (args ?? {}) as { path?: unknown; content?: unknown };
  const path = str(a.path);
  const content = str(a.content);
  if (!path || content === undefined) return null;
  const additions = lineCount(content);
  return {
    path,
    additions,
    deletions: 0,
    hunks: {
      *[Symbol.iterator]() {
        yield `@@ -0,0 +1,${additions} @@`;
        yield* prefixedLines(content, "+");
      },
    },
  };
}
