// 宿主侧 SDK 实现：files.* 用真实 fs（受路径校验约束），wb.* 是桩
// （固定小表 / 50k 行大表 / slow.xlsx 30s 可中止延迟），但所有路径参数
// 都走同一套真实校验：拒绝绝对路径/盘符/UNC/file:/NUL/反斜杠穿越/URL 编码穿越，
// 且 fs.realpath 必须落在工作区 realpath 之内（不跟随外指符号链接）。

import * as fs from "node:fs";
import * as path from "node:path";

export type ErrorCode =
  | "OUT_OF_WORKSPACE"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "LIMIT_EXCEEDED"
  | "UNSUPPORTED_FEATURE"
  | "INTERNAL";

export class SdkError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type EvidenceLog = Array<{ event: string; at: string }>;

export interface SdkCallContext {
  signal: AbortSignal;
  evidence: EvidenceLog;
  runId: number;
}

const MAX_SDK_BYTES = 32 * 1024 * 1024;

function ok(value: unknown): string {
  return JSON.stringify({ ok: true, value });
}

function err(code: ErrorCode, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

/**
 * 校验并把脚本传来的相对路径解析为工作区内绝对路径。
 * 任何逃逸形态（绝对路径、盘符、URI scheme、UNC、.. 穿越、编码穿越、
 * 外指符号链接、.excelmanus 前缀）都在这里被拒绝。
 */
export function resolveWorkspacePath(rootReal: string, input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new SdkError("INVALID_ARGUMENT", "path must be a non-empty string");
  }
  let p = input;
  if (p.includes("\0")) {
    throw new SdkError("INVALID_ARGUMENT", "NUL byte in path");
  }
  // URL 编码穿越：至多解码两轮（%252e → %2e → .）
  for (let i = 0; i < 2 && p.includes("%"); i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      break;
    }
    if (decoded === p) break;
    p = decoded;
  }
  if (p.includes("\0")) {
    throw new SdkError("INVALID_ARGUMENT", "NUL byte in path");
  }
  if (/^file:/i.test(p)) {
    throw new SdkError("OUT_OF_WORKSPACE", "file: URL not allowed");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) {
    // 盘符（C:）与任意 URI scheme（https: 等）
    throw new SdkError("OUT_OF_WORKSPACE", "URI scheme / drive letter not allowed");
  }
  // 反斜杠视为分隔符（覆盖 Windows 风格穿越与 UNC \\server\share）
  const norm = p.replaceAll("\\", "/");
  if (norm.startsWith("/")) {
    throw new SdkError("OUT_OF_WORKSPACE", "absolute path not allowed");
  }
  const resolved = path.resolve(rootReal, norm);
  const rel = path.relative(rootReal, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new SdkError("OUT_OF_WORKSPACE", "path escapes workspace");
  }
  if (rel.split(path.sep)[0] === ".excelmanus") {
    throw new SdkError("NOT_FOUND", "path not found");
  }
  assertInsideRealpath(rootReal, resolved);
  return resolved;
}

// 对路径中最近的已存在祖先做 realpath 校验：解析结果必须仍在工作区 realpath 内。
// 叶子不存在（写入新文件场景）时逐级向上走；某级 realpath 报 ENOENT 时先用 lstat
// 区分"真不存在"与"悬空符号链接"——后者直接拒绝（writeFileSync 会跟随链接写出界）。
function assertInsideRealpath(rootReal: string, resolved: string): void {
  let cur = resolved;
  for (let depth = 0; depth < 128; depth++) {
    try {
      const real = fs.realpathSync(cur);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new SdkError("OUT_OF_WORKSPACE", "path resolves outside workspace");
      }
      return;
    } catch (e) {
      if (e instanceof SdkError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        try {
          if (fs.lstatSync(cur).isSymbolicLink()) {
            throw new SdkError("OUT_OF_WORKSPACE", "dangling symlink resolves outside workspace");
          }
        } catch (e2) {
          if (e2 instanceof SdkError) throw e2;
          // lstat 同样 ENOENT/ENOTDIR：该段真不存在，继续向上
        }
        const parent = path.dirname(cur);
        if (parent === cur) {
          throw new SdkError("NOT_FOUND", "path not found");
        }
        cur = parent;
        continue;
      }
      throw e;
    }
  }
  throw new SdkError("NOT_FOUND", "path resolution failed");
}

function requirePath(rootReal: string, args: unknown): string {
  if (args === null || typeof args !== "object") {
    throw new SdkError("INVALID_ARGUMENT", "expected {path: string}");
  }
  return resolveWorkspacePath(rootReal, (args as { path?: unknown }).path);
}

// ---------------- files.*（真实实现） ----------------

function filesReadText(rootReal: string, args: unknown): unknown {
  const p = requirePath(rootReal, args);
  let content: string;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw new SdkError("NOT_FOUND", "path not found");
    }
    throw e;
  }
  return { status: "ok", data: { content } };
}

function filesWriteText(rootReal: string, args: unknown): unknown {
  if (args === null || typeof args !== "object") {
    throw new SdkError("INVALID_ARGUMENT", "expected {path, content}");
  }
  const a = args as { path?: unknown; content?: unknown };
  const p = resolveWorkspacePath(rootReal, a.path);
  if (typeof a.content !== "string") {
    throw new SdkError("INVALID_ARGUMENT", "content must be a string");
  }
  if (Buffer.byteLength(a.content, "utf8") > MAX_SDK_BYTES) {
    throw new SdkError("LIMIT_EXCEEDED", "content exceeds 32MB");
  }
  const parent = path.dirname(p);
  if (!fs.existsSync(parent)) {
    throw new SdkError("NOT_FOUND", "parent directory not found");
  }
  try {
    fs.writeFileSync(p, a.content, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw new SdkError("NOT_FOUND", "path not found");
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
  return new RegExp(out + "$");
}

function filesFind(rootReal: string, args: unknown): unknown {
  const glob =
    args !== null &&
    typeof args === "object" &&
    typeof (args as { glob?: unknown }).glob === "string"
      ? (args as { glob: string }).glob
      : "**/*";
  if (glob.includes("\0") || glob.includes("..") || glob.startsWith("/")) {
    throw new SdkError("INVALID_ARGUMENT", "invalid glob");
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
        // 不跟随外指符号链接
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
  if (
    args === null ||
    typeof args !== "object" ||
    !Array.isArray((args as { ops?: unknown }).ops)
  ) {
    throw new SdkError("INVALID_ARGUMENT", "expected {ops: [...]}");
  }
  const ops = (args as { ops: Array<{ op?: unknown; path?: unknown; to?: unknown }> }).ops;
  let applied = 0;
  for (const op of ops) {
    const p = resolveWorkspacePath(rootReal, op.path);
    switch (op.op) {
      case "delete":
        throw new SdkError("UNSUPPORTED_FEATURE", "delete is not available in sandbox SDK");
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
        throw new SdkError("INVALID_ARGUMENT", `unknown op ${String(op.op)}`);
    }
  }
  return { status: "ok", data: { applied } };
}

// ---------------- wb.*（桩，但路径校验是真的） ----------------

// 宿主侧每次返回同一份缓存对象（P03 靠"每次调用重新序列化"保证脚本不可回写）
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

function wbRead(rootReal: string, args: unknown, ctx: SdkCallContext): Promise<unknown> | unknown {
  const p = requirePath(rootReal, args);
  if (!fs.existsSync(p)) {
    throw new SdkError("NOT_FOUND", "workbook not found");
  }
  const name = path.basename(p);
  if (name === "slow.xlsx") {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(FIXED_TABLE), 30_000);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          ctx.evidence.push({
            event: `slow.xlsx read aborted for run ${ctx.runId}`,
            at: new Date().toISOString(),
          });
          reject(new SdkError("INTERNAL", "operation aborted"));
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
    throw new SdkError("NOT_FOUND", "workbook/parent not found");
  }
  const ops = (args as { ops?: unknown })?.ops;
  return { status: "ok", data: { applied: Array.isArray(ops) ? ops.length : 0 } };
}

function wbExport(rootReal: string, args: unknown): unknown {
  const p = requirePath(rootReal, args);
  if (!fs.existsSync(p)) {
    throw new SdkError("NOT_FOUND", "workbook not found");
  }
  return { status: "ok", data: { path: path.basename(p), bytes: 0 } };
}

// ---------------- 分发 ----------------

export interface SdkHost {
  handle(ns: string, method: string, argsJson: string, ctx: SdkCallContext): Promise<string>;
}

export function createSdkHost(workspaceDir: string): SdkHost {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const rootReal = fs.realpathSync(workspaceDir);
  return {
    async handle(ns, method, argsJson, ctx) {
      if (argsJson.length > MAX_SDK_BYTES) {
        return err("LIMIT_EXCEEDED", "SDK call payload exceeds 32MB");
      }
      let args: unknown;
      try {
        args = JSON.parse(argsJson);
      } catch {
        return err("INVALID_ARGUMENT", "malformed args JSON");
      }
      try {
        let value: unknown;
        if (ns === "files") {
          switch (method) {
            case "readText":
              value = filesReadText(rootReal, args);
              break;
            case "writeText":
              value = filesWriteText(rootReal, args);
              break;
            case "find":
              value = filesFind(rootReal, args);
              break;
            case "manage":
              value = filesManage(rootReal, args);
              break;
            default:
              return err("INVALID_ARGUMENT", `unknown files.${method}`);
          }
        } else if (ns === "wb") {
          switch (method) {
            case "read":
              value = await wbRead(rootReal, args, ctx);
              break;
            case "analyze":
              value = wbAnalyze(rootReal, args);
              break;
            case "edit":
              value = wbEdit(rootReal, args);
              break;
            case "export":
              value = wbExport(rootReal, args);
              break;
            default:
              return err("INVALID_ARGUMENT", `unknown wb.${method}`);
          }
        } else {
          return err("INVALID_ARGUMENT", `unknown namespace ${ns}`);
        }
        const out = ok(value);
        if (out.length > MAX_SDK_BYTES) {
          return err("LIMIT_EXCEEDED", "SDK response exceeds 32MB");
        }
        return out;
      } catch (e) {
        if (e instanceof SdkError) {
          return err(e.code, e.message);
        }
        return err("INTERNAL", e instanceof Error ? e.message : String(e));
      }
    },
  };
}
