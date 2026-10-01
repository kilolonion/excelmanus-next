// 输入框候选的触发词解析（02 §3.3）。

/** 光标前的触发词：`@xxx` 任意位置，`/xxx` 只在开头。 */
export function triggerAt(
  text: string,
  caret: number,
): { kind: "@" | "/"; start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (at) {
    const q = at[1] ?? "";
    return { kind: "@", start: caret - q.length - 1, query: q };
  }
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash) return { kind: "/", start: 0, query: slash[1] ?? "" };
  return null;
}
