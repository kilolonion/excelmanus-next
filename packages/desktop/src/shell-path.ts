// 登录 shell 的 PATH（12 §4.1）：macOS 从 Finder/Dock 启动的 GUI 应用只继承
// /usr/bin:/bin:/usr/sbin:/sbin，stdio MCP 常用的 npx/uvx（以及 shebang 里的 node/python）
// 都找不到。启动时用登录交互 shell 解析一次 PATH，合并后注入后端进程。

import { execFileSync } from "node:child_process";

const MARK = "__EXCELMANUS_PATH__";

type Exec = (file: string, args: string[], timeoutMs: number) => string;

const defaultExec: Exec = (file, args, timeoutMs) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
  });

/** 从登录 shell 输出中取 PATH（rc 文件可能打印其他内容，用标记包围）。 */
export function parseShellPath(output: string): string | undefined {
  const start = output.indexOf(MARK);
  const end = output.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return undefined;
  const v = output.slice(start + MARK.length, end).trim();
  return v === "" ? undefined : v;
}

/** 合并 PATH：先保留当前顺序，再追加 extra 中未出现的目录。 */
export function mergePath(current: string | undefined, extra: string | undefined): string {
  const parts = (current ?? "").split(":").filter(Boolean);
  for (const d of (extra ?? "").split(":").filter(Boolean)) if (!parts.includes(d)) parts.push(d);
  return parts.join(":");
}

/** 解析登录 shell 的 PATH；Windows 不需要；失败或超时返回 undefined（保持原 PATH）。 */
export function loginShellPath(
  platform: NodeJS.Platform = process.platform,
  shell: string | undefined = process.env.SHELL,
  exec: Exec = defaultExec,
  timeoutMs = 3000,
): string | undefined {
  if (platform === "win32") return undefined;
  const sh = shell && shell.startsWith("/") ? shell : "/bin/sh";
  try {
    return parseShellPath(exec(sh, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], timeoutMs));
  } catch {
    return undefined;
  }
}

/** 登录 shell PATH 在前（与终端中一致），原 PATH 中独有的目录追加在后。 */
export function resolvedPath(current: string | undefined, login: string | undefined): string {
  return login ? mergePath(login, current) : (current ?? "");
}
