// M1 只读文件工具：read（文本按行分页，默认 2000 行/16000 字符截断带 cursor；
// xlsx/csv 返回概况提示）与 find（path/glob/contains/depth/limit）。

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ToolDefinition } from "@excelmanus/kernel";
import { PathSafetyError, resolveWorkspacePath } from "@excelmanus/kernel";
import type { ToolResult } from "@excelmanus/protocol";
import { z } from "zod";

const MAX_READ_CHARS = 16_000;
const DEFAULT_READ_LINES = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FIND_RESULTS = 500;
const SPREADSHEET_EXTS = new Set([".xlsx", ".xlsm", ".xls"]);
const CSV_EXTS = new Set([".csv", ".tsv"]);
const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".zip",
  ".gz",
  ".7z",
  ".rar",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

function err(code: string, message: string, extra?: Partial<ToolResult["error"]>): ToolResult {
  return { status: "error", error: { code, message, retryable: false, ...extra } };
}

function fail(p: PathSafetyError): ToolResult {
  return err(
    p.code,
    p.code === "OUT_OF_WORKSPACE" ? `路径越界：${p.message}` : `路径不存在：${p.message}`,
  );
}

// ---------- read ----------

const ReadInput = z.object({
  path: z.string().describe("工作区内相对路径"),
  offset: z.int().min(1).optional().describe("起始行号（1 起算），用于分页续读"),
  limit: z.int().min(1).max(10_000).optional().describe(`最多返回行数，默认 ${DEFAULT_READ_LINES}`),
});
type ReadArgs = z.infer<typeof ReadInput>;

const ReadOutput = z.object({
  kind: z.string(),
  content: z.string().optional(),
  offset: z.number().optional(),
  shownLines: z.number().optional(),
  totalLines: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
  truncated: z.boolean().optional(),
  message: z.string().optional(),
  sizeBytes: z.number().optional(),
  approxRows: z.number().optional(),
  preview: z.string().optional(),
});

function isProbablyText(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

function readText(args: ReadArgs, abs: string, rel: string, size: number): ToolResult {
  if (size > MAX_FILE_BYTES) {
    return err("LIMIT_EXCEEDED", `文件 ${size} 字节，超过 ${MAX_FILE_BYTES} 上限`, {
      hint: "请缩小读取范围",
    });
  }
  const buf = readFileSync(abs);
  if (!isProbablyText(buf)) {
    return err("UNSUPPORTED_FEATURE", `${rel} 是二进制文件，暂不支持读取`);
  }
  const all = buf.toString("utf8").split("\n");
  const totalLines = all.length;
  const offset = args.offset ?? 1;
  const limit = args.limit ?? DEFAULT_READ_LINES;
  if (offset > totalLines && totalLines > 0) {
    return err("INVALID_ARGUMENT", `offset ${offset} 超出文件总行数 ${totalLines}`, {
      field: "offset",
    });
  }
  const shown: string[] = [];
  let chars = 0;
  let end = offset - 1;
  while (end < totalLines && shown.length < limit) {
    const line = all[end] ?? "";
    if (chars + line.length + 1 > MAX_READ_CHARS) break;
    shown.push(line);
    chars += line.length + 1;
    end += 1;
  }
  const hasMore = end < totalLines;
  const cursor = String(end + 1);
  return {
    status: "ok",
    data: {
      kind: "text",
      content: shown.join("\n"),
      offset,
      shownLines: shown.length,
      totalLines,
      nextOffset: hasMore ? end + 1 : null,
      truncated: hasMore,
      sizeBytes: size,
    },
    versions: { [rel]: createHash("sha256").update(buf).digest("hex") },
    ...(hasMore ? { truncated: { shown: shown.length, total: totalLines, cursor } } : {}),
  };
}

const readTool: ToolDefinition<ReadArgs> = {
  name: "read",
  title: "读取文件",
  description: `读取工作区内文件的内容。
何时使用：查看文本文件内容；大文件按行分页读取。
不要用于：列出目录或按名字/内容找文件（改用 find）；xlsx/xlsm 工作簿请先看本工具返回的概况提示，再决定后续方式。
参数要点：path 为工作区内相对路径；offset 从 1 开始；结果超限时响应带 cursor，把它的值作为下一次 offset 继续读。
常见错误：NOT_FOUND → 先用 find 确认路径；OUT_OF_WORKSPACE → 只用工作区内路径。
示例：{"path": "notes/a.txt", "limit": 200}`,
  input: ReadInput,
  output: ReadOutput,
  effect: "read",
  targets: (args) => [args.path],
  replay: "safe",
  timeoutMs: 30_000,
  roles: ["main", "lead", "worker", "reader"],
  execute(args, ctx) {
    try {
      const { abs, rel } = resolveWorkspacePath(ctx.workspaceRoot, args.path);
      const st = statSync(abs);
      if (st.isDirectory()) {
        return err("INVALID_ARGUMENT", `${rel || "."} 是目录，请改用 find 列出内容`, {
          field: "path",
        });
      }
      const ext = extname(abs).toLowerCase();
      if (SPREADSHEET_EXTS.has(ext)) {
        return {
          status: "ok",
          data: {
            kind: "workbook",
            message:
              "这是工作簿文件。当前版本不提供文本内容；表格读取能力（workbook_read）将在后续版本提供。",
            sizeBytes: st.size,
          },
        };
      }
      if (CSV_EXTS.has(ext)) {
        const buf = readFileSync(abs);
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        const preview = lines.slice(0, 5).join("\n");
        return {
          status: "ok",
          data: {
            kind: "csv",
            message: "这是 CSV/TSV 数据文件，下方为开头几行预览。",
            approxRows: Math.max(0, lines.filter((l) => l !== "").length),
            preview,
            sizeBytes: st.size,
          },
        };
      }
      return readText(args, abs, rel, st.size);
    } catch (e) {
      if (e instanceof PathSafetyError) return fail(e);
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return err("NOT_FOUND", `路径不存在：${args.path}`);
      }
      throw e;
    }
  },
};

// ---------- find ----------

const FindInput = z.object({
  path: z.string().optional().describe("起始目录，默认工作区根"),
  glob: z.string().optional().describe("文件名匹配，支持 * ** ?（如 **/*.xlsx）"),
  contains: z.string().optional().describe("在文本文件中搜索包含的字符串"),
  depth: z.int().min(0).max(10).optional().describe("向下递归层数，默认 4"),
  limit: z.int().min(1).max(MAX_FIND_RESULTS).optional(),
  offset: z.int().min(0).optional().describe("分页偏移"),
});
type FindArgs = z.infer<typeof FindInput>;

const FindOutput = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      sizeBytes: z.number().optional(),
      mtime: z.string().optional(),
      matches: z.number().optional(),
    }),
  ),
  total: z.number(),
  truncated: z.boolean(),
});

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1; // "**/" 可匹配零层目录
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set([".excelmanus"]);

interface WalkEntry {
  path: string;
  kind: "file" | "dir";
  sizeBytes?: number;
  mtime?: string;
  matches?: number;
}

const findTool: ToolDefinition<FindArgs> = {
  name: "find",
  title: "查找文件",
  description: `在工作区内列目录、按文件名或内容查找。
何时使用：看目录结构、找某类文件、搜索文本内容。
不要用于：读取已知文件的具体内容（改用 read）。
参数要点：path 为起始目录（默认工作区根）；glob 匹配相对路径（"*.xlsx" 只匹配根层文件名，"**/*.xlsx" 匹配任意层）；contains 只搜文本文件且不超过 2MB；结果按路径排序，limit/offset 分页。
示例：{"path": ".", "glob": "**/*.xlsx"}`,
  input: FindInput,
  output: FindOutput,
  effect: "read",
  targets: (args) => [args.path ?? "."],
  replay: "safe",
  timeoutMs: 30_000,
  roles: ["main", "lead", "worker", "reader"],
  execute(args, ctx) {
    try {
      const { abs: rootAbs } = resolveWorkspacePath(ctx.workspaceRoot, args.path ?? ".");
      const rootStat = statSync(rootAbs);
      if (!rootStat.isDirectory()) {
        return err("INVALID_ARGUMENT", `${args.path ?? "."} 不是目录`, { field: "path" });
      }
      const depthMax = args.depth ?? 4;
      const limit = args.limit ?? 200;
      const offset = args.offset ?? 0;
      const re = args.glob !== undefined ? globToRegExp(args.glob) : null;
      const globHasSlash = (args.glob ?? "").includes("/");
      const needle = args.contains;
      const out: WalkEntry[] = [];

      const matchesName = (rel: string, name: string): boolean => {
        if (!re) return true;
        return globHasSlash ? re.test(rel) : re.test(name);
      };

      const walk = (dir: string, relDir: string, depth: number): void => {
        let ents: Dirent[];
        try {
          ents = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        ents.sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of ents) {
          if (out.length >= offset + limit + 1) return;
          const rel = relDir === "" ? ent.name : `${relDir}/${ent.name}`;
          const p = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
            if (matchesName(rel, ent.name) && needle === undefined) {
              out.push({ path: rel, kind: "dir" });
            }
            if (depth < depthMax) walk(p, rel, depth + 1);
          } else if (ent.isFile() || ent.isSymbolicLink()) {
            let st: ReturnType<typeof statSync>;
            try {
              st = statSync(p);
            } catch {
              continue; // 悬空链接等，跳过
            }
            if (!st.isFile()) continue;
            let matches: number | undefined;
            if (needle !== undefined) {
              if (st.size > 2 * 1024 * 1024 || BINARY_EXTS.has(extname(ent.name).toLowerCase())) {
                continue;
              }
              let text: string;
              try {
                const buf = readFileSync(p);
                if (!isProbablyText(buf)) continue;
                text = buf.toString("utf8");
              } catch {
                continue;
              }
              const cnt = text.split(needle).length - 1;
              if (cnt === 0) continue;
              matches = cnt;
            } else if (!matchesName(rel, ent.name)) {
              continue;
            }
            out.push({
              path: rel,
              kind: "file",
              sizeBytes: st.size,
              mtime: st.mtime.toISOString(),
              ...(matches !== undefined ? { matches } : {}),
            });
          }
        }
      };
      walk(rootAbs, "", 0);

      const total = out.length;
      const shown = out.slice(offset, offset + limit);
      const hasMore = offset + shown.length < total;
      return {
        status: "ok",
        data: { entries: shown, total, truncated: hasMore },
        ...(hasMore
          ? { truncated: { shown: shown.length, total, cursor: String(offset + shown.length) } }
          : {}),
      };
    } catch (e) {
      if (e instanceof PathSafetyError) return fail(e);
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return err("NOT_FOUND", `路径不存在：${args.path ?? "."}`);
      }
      throw e;
    }
  },
};

export const FILES_TOOLS: ToolDefinition[] = [readTool, findTool];
