// 技能导入（12 §1.5【硬性：安全检查】）：本地目录或 github.com 仓库地址（压缩包 ≤ 20MB、
// 条目 ≤ 2000）。拒绝符号链接、路径穿越、单文件 > 5MB 的二进制文件。先整体校验到
// 内存，preview 只返回正文；确认后写入 <数据目录>/skills/<名称>/（已存在则拒绝覆盖）。

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { unzipSync } from "fflate";
import { type ParsedSkill, parseSkillMd, SkillFormatError } from "./parse.ts";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 单个条目解压后上限（文本文件可超过 5MB，但不超过压缩包上限）。 */
const MAX_ENTRY_BYTES = MAX_ARCHIVE_BYTES;
/** 解压后总量上限（防 zip 炸弹）。 */
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;

export class SkillImportError extends Error {}

export interface ImportedSkill extends ParsedSkill {
  files: Map<string, Uint8Array>;
}

function isTextLike(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 8192).includes(0);
}

function checkRel(rel: string): string {
  const norm = rel.replaceAll("\\", "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").some((p) => p === ".."))
    throw new SkillImportError(`拒绝路径穿越：${rel}`);
  return norm;
}

/** 从一组 (相对路径 → 字节) 中找出所有含 SKILL.md 的目录，逐个校验。 */
function collect(files: Map<string, Uint8Array>): ImportedSkill[] {
  if (files.size > MAX_ENTRIES) throw new SkillImportError(`条目数超过 ${MAX_ENTRIES}`);
  const roots = [...files.keys()]
    .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
    .map((p) => (p === "SKILL.md" ? "" : p.slice(0, -"/SKILL.md".length)));
  if (roots.length === 0) throw new SkillImportError("未找到 SKILL.md");
  // 嵌套的 SKILL.md 属于其最近的根
  const out: ImportedSkill[] = [];
  for (const root of roots) {
    const prefix = root === "" ? "" : `${root}/`;
    const own = new Map<string, Uint8Array>();
    for (const [p, bytes] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const nested = roots.some((r) => r !== root && r.startsWith(prefix) && p.startsWith(`${r}/`));
      if (nested) continue;
      if (bytes.length > MAX_FILE_BYTES && !isTextLike(bytes))
        throw new SkillImportError(`二进制文件超过 5MB：${p}`);
      own.set(rest, bytes);
    }
    const md = own.get("SKILL.md");
    if (!md) continue;
    let parsed: ParsedSkill;
    try {
      parsed = parseSkillMd(new TextDecoder().decode(md));
    } catch (e) {
      throw new SkillImportError(
        `${root || "SKILL.md"}：${e instanceof SkillFormatError ? e.message : String(e)}`,
      );
    }
    out.push({ ...parsed, files: own });
  }
  const names = new Set<string>();
  for (const s of out) {
    if (names.has(s.name)) throw new SkillImportError(`重复的技能名：${s.name}`);
    names.add(s.name);
  }
  return out;
}

function readLocal(dir: string): Map<string, Uint8Array> {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new SkillImportError("目录不存在");
  const files = new Map<string, Uint8Array>();
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isSymbolicLink()) throw new SkillImportError(`拒绝符号链接：${relative(dir, p)}`);
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        if (files.size >= MAX_ENTRIES) throw new SkillImportError(`条目数超过 ${MAX_ENTRIES}`);
        files.set(relative(dir, p).split(sep).join("/"), readFileSync(p));
      }
    }
  };
  walk(dir);
  return files;
}

/** github.com/<owner>/<repo>[/tree/<ref>[/<path>]] → codeload 压缩包。 */
function parseGithub(url: string): { owner: string; repo: string; ref: string; sub: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SkillImportError("不是合法的地址");
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com")
    throw new SkillImportError("只支持 https://github.com 仓库地址");
  const parts = u.pathname.split("/").filter(Boolean);
  const [owner, repoRaw, kind, ref, ...rest] = parts;
  if (!owner || !repoRaw) throw new SkillImportError("地址应为 https://github.com/<owner>/<repo>");
  const repo = repoRaw.replace(/\.git$/, "");
  const safe = /^[A-Za-z0-9_.-]+$/;
  if (!safe.test(owner) || !safe.test(repo)) throw new SkillImportError("仓库名不合法");
  if (kind !== undefined && kind !== "tree") throw new SkillImportError("只支持仓库或 tree 地址");
  return { owner, repo, ref: ref ?? "HEAD", sub: rest.join("/") };
}

async function readGithub(url: string, fetchImpl: typeof fetch): Promise<Map<string, Uint8Array>> {
  const g = parseGithub(url);
  const res = await fetchImpl(
    `https://codeload.github.com/${g.owner}/${g.repo}/zip/${encodeURIComponent(g.ref)}`,
    { redirect: "follow", signal: AbortSignal.timeout(60_000) },
  );
  if (!res.ok) throw new SkillImportError(`下载失败：HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new SkillImportError("压缩包超过 20MB");
  const buf = await readCapped(res, MAX_ARCHIVE_BYTES);
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(unzipCapped(buf, g.sub))) {
    const rel = archiveRel(name);
    files.set(g.sub === "" ? rel : rel.slice(g.sub.length + 1), bytes);
  }
  return files;
}

/** 压缩包顶层为 <repo>-<ref>/，去掉后的相对路径。 */
function archiveRel(name: string): string {
  return checkRel(name).split("/").slice(1).join("/");
}

/** 边读边计数，超过上限立即中止（无 content-length 的分块响应也不会整体读入内存）。 */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new SkillImportError("压缩包超过 20MB");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}

/**
 * 解压前按中央目录声明的大小把关（导出供测试）：条目数、单条目、解压总量；
 * 子路径之外的条目只做路径检查、不解压。fflate 按声明大小分配输出，实际数据不会超出声明。
 */
export function unzipCapped(buf: Uint8Array, sub = ""): Record<string, Uint8Array> {
  let count = 0;
  let total = 0;
  return unzipSync(buf, {
    filter: (f) => {
      count += 1;
      if (count > MAX_ENTRIES) throw new SkillImportError(`条目数超过 ${MAX_ENTRIES}`);
      if (f.name.endsWith("/")) return false;
      const rel = archiveRel(f.name);
      if (rel === "" || (sub !== "" && !rel.startsWith(`${sub}/`))) return false;
      if (f.originalSize > MAX_ENTRY_BYTES) throw new SkillImportError(`文件过大：${f.name}`);
      total += f.originalSize;
      if (total > MAX_EXTRACTED_BYTES)
        throw new SkillImportError(`解压后总大小超过 ${MAX_EXTRACTED_BYTES / 1024 / 1024}MB`);
      return true;
    },
  });
}

export async function importSkills(opts: {
  source: string;
  userDir: string;
  preview: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ImportedSkill[]> {
  const src = opts.source.trim();
  const files = /^https?:\/\//.test(src)
    ? await readGithub(src, opts.fetchImpl ?? fetch)
    : readLocal(src);
  const skills = collect(files);
  if (opts.preview) return skills;
  for (const s of skills) {
    if (existsSync(join(opts.userDir, s.name)))
      throw new SkillImportError(`用户技能 ${s.name} 已存在，请先删除`);
  }
  mkdirSync(opts.userDir, { recursive: true });
  for (const s of skills) {
    const staging = join(opts.userDir, `.import-${s.name}-${Date.now()}`);
    try {
      for (const [rel, bytes] of s.files) {
        const dest = join(staging, ...checkRel(rel).split("/"));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes, { flag: "wx" });
      }
      renameSync(staging, join(opts.userDir, s.name));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return skills;
}
