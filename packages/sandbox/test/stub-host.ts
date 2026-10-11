// 逃逸测试的宿主替身：files.* 用真实 fs + 与 kernel resolveWorkspacePath 同语义
// 的路径校验（packages/kernel/src/paths.ts 的等价副本——sandbox 测试受依赖方向
// 约束不能直接 import kernel）；wb.* 是桩（固定小表 / 50k 行大表 / slow.xlsx
// 30s 可中止延迟），路径参数同样走真实校验。

import * as fs from "node:fs";
import * as path from "node:path";
import { type SandboxHost, SdkCallError } from "../src/index.ts";

const MAX_SDK_BYTES = 32 * 1024 * 1024;

export interface StubHost extends SandboxHost {
  evidence: string[];
}

// ---------- 路径校验（kernel paths.ts 等价替身） ----------

function hasEncodedTraversal(input: string): boolean {
  try {
    const decoded = decodeURIComponent(input);
    return decoded !== input && /(^|[/\\])\.\.([/\\]|$)/.test(decoded);
  } catch {
    return true;
  }
}

function isInside(rootReal: string, p: string): boolean {
  return p === rootReal || p.startsWith(rootReal + path.sep);
}

function rejectInternal(rootReal: string, p: string): void {
  if (path.relative(rootReal, p).split(path.sep)[0]?.toLowerCase() === ".excelmanus") {
    throw new SdkCallError("NOT_FOUND", "路径不存在");
  }
}

function resolveWorkspacePath(rootReal: string, input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new SdkCallError("INVALID_ARGUMENT", "path must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw new SdkCallError("OUT_OF_WORKSPACE", "NUL byte in path");
  }
  if (
    path.isAbsolute(input) ||
    /^[a-zA-Z]:[/\\]/.test(input) ||
    input.startsWith("\\\\") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)
  ) {
    throw new SdkCallError("OUT_OF_WORKSPACE", "absolute path / scheme not allowed");
  }
  if (hasEncodedTraversal(input)) {
    throw new SdkCallError("OUT_OF_WORKSPACE", "encoded traversal");
  }
  const normalized = path.normalize(input).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new SdkCallError("OUT_OF_WORKSPACE", "path escapes workspace");
  }
  const relParts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  if (relParts[0]?.toLowerCase() === ".excelmanus") {
    throw new SdkCallError("NOT_FOUND", "path not found");
  }
  let resolved = rootReal;
  let consumed = 0;
  for (let i = 0; i < relParts.length; i++) {
    const candidate = path.join(resolved, relParts[i] ?? "");
    let st: fs.Stats;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      break;
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(candidate);
      } catch {
        throw new SdkCallError("OUT_OF_WORKSPACE", "dangling symlink rejected");
      }
      if (!isInside(rootReal, target)) {
        throw new SdkCallError("OUT_OF_WORKSPACE", "symlink points outside workspace");
      }
      rejectInternal(rootReal, target);
      resolved = target;
    } else {
      resolved = candidate;
    }
    consumed = i + 1;
  }
  const abs = path.join(resolved, ...relParts.slice(consumed));
  if (!isInside(rootReal, abs)) {
    throw new SdkCallError("OUT_OF_WORKSPACE", "path escapes workspace");
  }
  rejectInternal(rootReal, abs);
  return abs;
}

function requirePath(rootReal: string, args: unknown): string {
  // 夹具脚本既传 "path" 字符串也传 {path} 对象，两种都接受
  const p = typeof args === "string" ? args : (args as { path?: unknown } | null)?.path;
  return resolveWorkspacePath(rootReal, p);
}

// ---------- files.* ----------

function filesReadText(rootReal: string, args: unknown): unknown {
  const p = requirePath(rootReal, args);
  let content: string;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw new SdkCallError("NOT_FOUND", "path not found");
    }
    throw e;
  }
  return { status: "ok", data: { content } };
}

function filesWriteText(rootReal: string, args: unknown): unknown {
  // 桥把多参数调用打成数组：writeText("p", "c") → ["p","c"]；单对象 {path,content} 直通
  const a = Array.isArray(args)
    ? ({ path: args[0], content: args[1] } as { path?: unknown; content?: unknown })
    : (args as { path?: unknown; content?: unknown } | null);
  const p = resolveWorkspacePath(rootReal, a?.path);
  const content = a?.content;
  if (typeof content !== "string") {
    throw new SdkCallError("INVALID_ARGUMENT", "content must be a string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SDK_BYTES) {
    throw new SdkCallError("LIMIT_EXCEEDED", "content exceeds 32MB");
  }
  const parent = path.dirname(p);
  if (!fs.existsSync(parent)) {
    throw new SdkCallError("NOT_FOUND", "parent directory not found");
  }
  try {
    fs.writeFileSync(p, content, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw new SdkCallError("NOT_FOUND", "path not found");
    }
    throw e;
  }
  return { status: "ok" };
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function filesFind(rootReal: string, args: unknown): unknown {
  const glob =
    args !== null &&
    typeof args === "object" &&
    typeof (args as { glob?: unknown }).glob === "string"
      ? (args as { glob: string }).glob
      : "**/*";
  if (glob.includes("\0") || glob.includes("..") || glob.startsWith("/")) {
    throw new SdkCallError("INVALID_ARGUMENT", "invalid glob");
  }
  const re = globToRegExp(glob);
  const entries: Array<{ path: string; type: "file" | "dir" }> = [];
  const walk = (dir: string, rel: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const itemRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.name === ".excelmanus" || itemRel.split("/")[0] === ".excelmanus") continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (re.test(itemRel)) entries.push({ path: itemRel, type: "dir" });
        walk(full, itemRel);
      } else if (item.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(full);
          if (real === rootReal || real.startsWith(rootReal + path.sep)) {
            if (re.test(itemRel)) entries.push({ path: itemRel, type: "file" });
          }
        } catch {
          // 断链不可见
        }
      } else if (re.test(itemRel)) {
        entries.push({ path: itemRel, type: "file" });
      }
      if (entries.length > 10_000) return;
    }
  };
  walk(rootReal, "");
  return { status: "ok", data: { entries } };
}

function filesManage(rootReal: string, args: unknown): unknown {
  const ops = (args as { ops?: Array<{ op?: unknown; path?: unknown; to?: unknown }> } | null)?.ops;
  if (!Array.isArray(ops)) {
    throw new SdkCallError("INVALID_ARGUMENT", "expected {ops: [...]}");
  }
  let applied = 0;
  for (const op of ops) {
    const p = resolveWorkspacePath(rootReal, op.path);
    switch (op.op) {
      case "delete":
        throw new SdkCallError("UNSUPPORTED_FEATURE", "delete is not available in sandbox SDK");
      case "mkdir":
        fs.mkdirSync(p, { recursive: true });
        applied++;
        break;
      case "copy": {
        const to = resolveWorkspacePath(rootReal, op.to);
        fs.copyFileSync(p, to);
        applied++;
        break;
      }
      case "move": {
        const to = resolveWorkspacePath(rootReal, op.to);
        fs.renameSync(p, to);
        applied++;
        break;
      }
      default:
        throw new SdkCallError("INVALID_ARGUMENT", `unknown op ${String(op.op)}`);
    }
  }
  return { status: "ok", data: { applied } };
}

// ---------- wb.*（桩） ----------

// 宿主侧每次返回同一份缓存对象（靠"每次调用重新序列化"保证脚本不可回写）
const FIXED_TABLE = {
  status: "ok",
  data: {
    sheets: ["Sheet1"],
    rows: [
      [1, "alpha", "2024-01"],
      [2, "beta", "2024-02"],
    ],
  },
};

const ROWS_50K = (() => {
  const rows: number[][] = new Array(50_000);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = [i, i * 2, i * 3, (i * 7) % 997, i + 1, i % 13];
  }
  return { status: "ok", data: { sheets: ["Data"], rows } };
})();

function wbRead(
  rootReal: string,
  args: unknown,
  signal: AbortSignal,
  evidence: string[],
): Promise<unknown> | unknown {
  const p = requirePath(rootReal, args);
  if (!fs.existsSync(p)) {
    throw new SdkCallError("NOT_FOUND", "workbook not found");
  }
  const name = path.basename(p);
  if (name === "slow.xlsx") {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(FIXED_TABLE), 30_000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          evidence.push("slow.xlsx read aborted");
          reject(new SdkCallError("INTERNAL", "operation aborted"));
        },
        { once: true },
      );
    });
  }
  if (name === "rows50k.xlsx") {
    return ROWS_50K;
  }
  return FIXED_TABLE;
}

function wbAnalyze(rootReal: string, args: unknown): unknown {
  const sources = (args as { sources?: Array<{ path?: unknown }> } | null)?.sources;
  if (Array.isArray(sources)) {
    for (const s of sources) {
      resolveWorkspacePath(rootReal, s?.path);
    }
  }
  return { status: "ok", data: { rows: [["合计", 42]] } };
}

function wbEdit(rootReal: string, args: unknown): unknown {
  const p = requirePath(rootReal, args);
  const parent = path.dirname(p);
  if (!fs.existsSync(p) && !fs.existsSync(parent)) {
    throw new SdkCallError("NOT_FOUND", "workbook/parent not found");
  }
  const ops = (args as { ops?: unknown })?.ops;
  return { status: "ok", data: { applied: Array.isArray(ops) ? ops.length : 0 } };
}

function wbExport(rootReal: string, args: unknown): unknown {
  const p = requirePath(rootReal, args);
  if (!fs.existsSync(p)) {
    throw new SdkCallError("NOT_FOUND", "workbook not found");
  }
  return { status: "ok", data: { path: path.basename(p), bytes: 0 } };
}

// ---------- 宿主 ----------

export function createStubHost(workspaceDir: string): StubHost {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const rootReal = fs.realpathSync(workspaceDir);
  const evidence: string[] = [];
  return {
    evidence,
    async call(ns, method, args, signal) {
      if (ns === "files") {
        switch (method) {
          case "readText":
            return filesReadText(rootReal, args);
          case "writeText":
            return filesWriteText(rootReal, args);
          case "find":
            return filesFind(rootReal, args);
          case "manage":
            return filesManage(rootReal, args);
          default:
            throw new SdkCallError("INVALID_ARGUMENT", `unknown files.${method}`);
        }
      }
      if (ns === "wb") {
        switch (method) {
          case "read":
            return await wbRead(rootReal, args, signal, evidence);
          case "analyze":
            return wbAnalyze(rootReal, args);
          case "edit":
            return wbEdit(rootReal, args);
          case "export":
            return wbExport(rootReal, args);
          default:
            throw new SdkCallError("INVALID_ARGUMENT", `unknown wb.${method}`);
        }
      }
      throw new SdkCallError("INVALID_ARGUMENT", `unknown namespace ${ns}`);
    },
  };
}

/** 夹具注入的完整 SDK 面（S13 断言与之严格一致） */
export const STUB_NAMESPACES: Record<string, readonly string[]> = {
  files: ["find", "manage", "readText", "writeText"],
  wb: ["analyze", "edit", "export", "read"],
};
