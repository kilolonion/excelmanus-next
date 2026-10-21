// 路径安全（06 §3、03 §13、ADR 0001 要点）：
// 拒绝绝对路径/盘符/scheme/UNC/NUL/编码穿越；相对工作区规范化；
// realpath 必须在工作区内；不跟随外指符号链接；悬空符号链接一律拒绝；
// 每一层的 .excelmanus/（含大小写/Unicode 折叠别名）与数据目录对代理不可见。

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import {
  assertPhysicalToolAccess,
  assertToolAccess,
  currentToolAccess,
  markUnscopedAccess,
} from "./tool-access.ts";

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

/** p 等于 parent 或位于其下（两者都应是规范绝对路径）。 */
export function isInsidePath(parent: string, p: string): boolean {
  return p === parent || p.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
const isInside = isInsidePath;

/**
 * 文件名是否指向内部目录 .excelmanus：按 Unicode 兼容折叠 + 大小写折叠比较
 * （APFS/NTFS 不区分大小写，`ſ` 折叠为 `s`），并忽略 Windows 会丢弃的尾部点/空格与流名。
 */
export function isInternalName(name: string): boolean {
  const folded = name
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .replace(/:.*$/s, "")
    .replace(/[. ]+$/, "");
  return folded === ".excelmanus";
}

/**
 * 数据目录等受保护目录（规范路径 → 豁免子树）：其下任何路径对代理不可见，
 * 只有豁免子树（默认工作区 dataDir/workspace）内的路径例外。
 */
const protectedRoots = new Map<string, string | undefined>();

export function registerProtectedRoot(dir: string, opts: { exempt?: string } = {}): void {
  protectedRoots.set(
    realpathSync.native(dir),
    opts.exempt === undefined ? undefined : realpathSync.native(opts.exempt),
  );
}

export function listProtectedRoots(): string[] {
  return [...protectedRoots.keys()];
}

function rejectInternal(rootReal: string, p: string): void {
  if (relative(rootReal, p).split(sep).some(isInternalName)) {
    throw new PathSafetyError("NOT_FOUND", "路径不存在");
  }
  for (const [prot, exempt] of protectedRoots) {
    if (isInside(prot, p) && !(exempt !== undefined && isInside(exempt, p))) {
      throw new PathSafetyError("NOT_FOUND", "路径不存在");
    }
  }
}

/**
 * 把工作区内相对路径解析为绝对路径并做安全检查。
 * @returns { abs, rel } abs=规范绝对路径（符号链接已解析、存在部分取磁盘拼写），
 *   rel=由 abs 反推的规范工作区相对路径（所有以路径为键处只存它）
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  input: string,
): { abs: string; rel: string } {
  assertToolAccess(input, workspaceRoot);
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
  if (relParts.some(isInternalName)) {
    // 内部目录对代理不可见：表现为不存在
    throw new PathSafetyError("NOT_FOUND", "路径不存在");
  }

  // 规范路径：realpathSync.native 返回磁盘上的真实拼写（大小写、Unicode 别名都归一），
  // 使同一物理文件只有一个 rel（文档 actor、备份、租约以此为键）。
  markUnscopedAccess();
  assertPhysicalToolAccess(input, workspaceRoot);
  const rootReal = realpathSync.native(workspaceRoot);
  let resolved = rootReal;
  let consumed = 0;
  // 逐段走：存在的段取规范路径并检查符号链接；悬空符号链接一律拒绝（ADR 0001）
  for (let i = 0; i < relParts.length; i++) {
    const candidate = join(resolved, relParts[i] ?? "");
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(candidate);
    } catch {
      break; // 不存在：更深的段必然也不存在
    }
    if (
      st.isSymbolicLink() &&
      currentToolAccess() &&
      currentToolAccess()?.binding().decision.kind !== "unbounded"
    )
      throw new PathSafetyError("OUT_OF_WORKSPACE", "受限任务不跟随符号链接");
    let real: string;
    try {
      real = realpathSync.native(candidate);
    } catch {
      if (st.isSymbolicLink()) throw new PathSafetyError("OUT_OF_WORKSPACE", "拒绝悬空符号链接");
      throw new PathSafetyError("NOT_FOUND", "路径不存在");
    }
    if (!isInside(rootReal, real)) {
      throw new PathSafetyError(
        "OUT_OF_WORKSPACE",
        st.isSymbolicLink() ? "符号链接指向工作区外" : "路径越出工作区",
      );
    }
    rejectInternal(rootReal, real);
    resolved = real;
    consumed = i + 1;
  }
  const abs = join(resolved, ...relParts.slice(consumed));
  if (!isInside(rootReal, abs)) {
    throw new PathSafetyError("OUT_OF_WORKSPACE", "路径越出工作区");
  }
  rejectInternal(rootReal, abs);
  const rel = relative(rootReal, abs).split(sep).join("/");
  assertToolAccess(rel || ".", workspaceRoot);
  return { abs, rel };
}

/** 工作区相对路径展示（隐藏 .excelmanus 由调用方过滤）。 */
export function relOf(workspaceRoot: string, abs: string): string {
  return relative(workspaceRoot, abs).split(sep).join("/");
}
