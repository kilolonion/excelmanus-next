// 路径安全（06 §3、03 §13、ADR 0001 要点）：
// 拒绝绝对路径/盘符/scheme/UNC/NUL/编码穿越；相对工作区规范化；
// realpath 必须在工作区内；不跟随外指符号链接；悬空符号链接一律拒绝；
// .excelmanus/ 对代理不可见。

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export class PathSafetyError extends Error {
  readonly code: "OUT_OF_WORKSPACE" | "NOT_FOUND";

  constructor(code: "OUT_OF_WORKSPACE" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "PathSafetyError";
    this.code = code;
  }
}

function hasEncodedTraversal(input: string): boolean {
  try {
    const decoded = decodeURIComponent(input);
    return decoded !== input && /(^|[/\\])\.\.([/\\]|$)/.test(decoded);
  } catch {
    return true;
  }
}

function isInside(rootReal: string, p: string): boolean {
  return p === rootReal || p.startsWith(rootReal + sep);
}

/**
 * 把工作区内相对路径解析为绝对路径并做安全检查。
 * @returns { abs, rel } abs=实际路径（符号链接已解析），rel=工作区相对路径（展示用）
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  input: string,
): { abs: string; rel: string } {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathSafetyError("NOT_FOUND", "路径为空");
  }
  if (input.includes("\0")) {
    throw new PathSafetyError("OUT_OF_WORKSPACE", "路径包含 NUL");
  }
  if (
    isAbsolute(input) ||
    /^[a-zA-Z]:[/\\]/.test(input) ||
    input.startsWith("\\\\") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)
  ) {
    throw new PathSafetyError("OUT_OF_WORKSPACE", "不允许工作区外的绝对路径或 scheme");
  }
  if (hasEncodedTraversal(input)) {
    throw new PathSafetyError("OUT_OF_WORKSPACE", "路径包含编码穿越");
  }
  const normalized = normalize(input).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new PathSafetyError("OUT_OF_WORKSPACE", "路径越出工作区");
  }
  const relParts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  if (relParts[0] === ".excelmanus") {
    // 内部目录对代理不可见：表现为不存在
    throw new PathSafetyError("NOT_FOUND", "路径不存在");
  }

  const rootReal = realpathSync(workspaceRoot);
  let resolved = rootReal;
  let consumed = 0;
  // 逐段走：存在的段检查符号链接；悬空符号链接一律拒绝（ADR 0001）
  for (let i = 0; i < relParts.length; i++) {
    const candidate = join(resolved, relParts[i] ?? "");
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(candidate);
    } catch {
      break; // 不存在：更深的段必然也不存在
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(candidate);
      } catch {
        throw new PathSafetyError("OUT_OF_WORKSPACE", "拒绝悬空符号链接");
      }
      if (!isInside(rootReal, target)) {
        throw new PathSafetyError("OUT_OF_WORKSPACE", "符号链接指向工作区外");
      }
      resolved = target;
    } else {
      resolved = candidate;
    }
    consumed = i + 1;
  }
  const abs = join(resolved, ...relParts.slice(consumed));
  if (!isInside(rootReal, abs)) {
    throw new PathSafetyError("OUT_OF_WORKSPACE", "路径越出工作区");
  }
  return { abs, rel: relParts.join("/") };
}

/** 工作区相对路径展示（隐藏 .excelmanus 由调用方过滤）。 */
export function relOf(workspaceRoot: string, abs: string): string {
  return relative(workspaceRoot, abs).split(sep).join("/");
}
