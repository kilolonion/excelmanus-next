// modules/skills：技能（12 §1）。三个来源按优先级整体覆盖：内置 assets/skills < 用户
// <数据目录>/skills < 工作区 <工作区>/.excelmanus/skills。启用状态存 skills_state。
// 模型用 skill 工具加载正文；资源经 read skill://<名称>/<路径> 读取（装配层注入 resolveResource）。

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { nowIso } from "@excelmanus/core";
import type { CapabilityModule, DatabaseSync, Migration, ToolDefinition } from "@excelmanus/kernel";
import type { Skill, SkillDetail, ToolResult } from "@excelmanus/protocol";
import { z } from "zod";
import {
  globMatch,
  missingSkillTools,
  type ParsedSkill,
  parseSkillMd,
  SkillFormatError,
} from "./parse.ts";

export { importSkills, SkillImportError } from "./import.ts";
export {
  globMatch,
  missingSkillTools,
  parseSkillMd,
  referencedToolNames,
  SkillFormatError,
} from "./parse.ts";

export const SKILLS_MIGRATION: Migration = {
  id: "skills/001-state",
  sql: `
CREATE TABLE skills_state (
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name, source)
);
`,
};

type Source = "builtin" | "user" | "workspace";
const PRIORITY: Record<Source, number> = { builtin: 0, user: 1, workspace: 2 };

interface LoadedSkill extends ParsedSkill {
  source: Source;
  dir: string;
  references: string[];
}

const MAX_RESOURCE_BYTES = 1024 * 1024;

function listResources(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, depth: number) => {
    if (depth > 4 || out.length >= 200) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && !(depth === 0 && e.name === "SKILL.md"))
        out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir, 0);
  return out.sort();
}

export interface SkillServiceOptions {
  builtinDir: string;
  userDir: string;
  /** 当前可用工具名（requires-tools 判定）。 */
  toolNames(): ReadonlySet<string>;
}

export class SkillService {
  private readonly db: DatabaseSync;
  private readonly opts: SkillServiceOptions;
  constructor(db: DatabaseSync, opts: SkillServiceOptions) {
    this.db = db;
    this.opts = opts;
  }

  get userDir(): string {
    return this.opts.userDir;
  }

  private scan(dir: string, source: Source): { skills: LoadedSkill[]; errors: string[] } {
    const skills: LoadedSkill[] = [];
    const errors: string[] = [];
    if (!existsSync(dir)) return { skills, errors };
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const skillDir = join(dir, e.name);
      const md = join(skillDir, "SKILL.md");
      if (!existsSync(md) || lstatSync(md).isSymbolicLink()) continue;
      try {
        const parsed = parseSkillMd(readFileSync(md, "utf8"));
        if (parsed.name !== e.name) throw new SkillFormatError("name 必须与目录名一致");
        const references = listResources(skillDir)
          .filter((p) => p.endsWith(".md"))
          .filter((p) => lstatSync(join(skillDir, p)).size <= MAX_RESOURCE_BYTES)
          .map((p) => readFileSync(join(skillDir, p), "utf8"));
        skills.push({ ...parsed, source, dir: skillDir, references });
      } catch (err) {
        errors.push(`${e.name}: ${err instanceof SkillFormatError ? err.message : String(err)}`);
      }
    }
    return { skills, errors };
  }

  /** 按优先级合并三来源；同名高优先级整体覆盖（12 §1.3）。 */
  private all(workspaceRoot?: string): { winners: LoadedSkill[]; shadowed: Map<string, Source[]> } {
    const loaded = [
      ...this.scan(this.opts.builtinDir, "builtin").skills,
      ...this.scan(this.opts.userDir, "user").skills,
      ...(workspaceRoot
        ? this.scan(join(workspaceRoot, ".excelmanus", "skills"), "workspace").skills
        : []),
    ];
    const byName = new Map<string, LoadedSkill>();
    const shadowed = new Map<string, Source[]>();
    for (const s of loaded) {
      const cur = byName.get(s.name);
      if (!cur || PRIORITY[s.source] > PRIORITY[cur.source]) {
        if (cur) shadowed.set(s.name, [...(shadowed.get(s.name) ?? []), cur.source]);
        byName.set(s.name, s);
      } else {
        shadowed.set(s.name, [...(shadowed.get(s.name) ?? []), s.source]);
      }
    }
    return {
      winners: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      shadowed,
    };
  }

  private enabled(name: string, source: Source): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM skills_state WHERE name = ? AND source = ?")
      .get(name, source) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  private toDto(s: LoadedSkill, shadowed: Map<string, Source[]>): Skill {
    const missing = this.missingTools(s, s.references);
    return {
      name: s.name,
      description: s.description,
      source: s.source,
      enabled: this.enabled(s.name, s.source),
      available: missing.length === 0,
      missingTools: missing,
      userInvocable: s.userInvocable,
      modelInvocable: s.modelInvocable,
      version: s.version,
      overrides: shadowed.get(s.name) ?? [],
    };
  }

  list(workspaceRoot?: string): Skill[] {
    const { winners, shadowed } = this.all(workspaceRoot);
    return winners.map((s) => this.toDto(s, shadowed));
  }

  missingTools(
    skill: Pick<ParsedSkill, "requiresTools" | "optionalTools" | "body">,
    references: string[] = [],
  ): string[] {
    return missingSkillTools(skill, this.opts.toolNames(), references);
  }

  private find(name: string, workspaceRoot?: string): LoadedSkill | undefined {
    return this.all(workspaceRoot).winners.find((s) => s.name === name);
  }

  detail(name: string, workspaceRoot?: string): SkillDetail | undefined {
    const { winners, shadowed } = this.all(workspaceRoot);
    const s = winners.find((x) => x.name === name);
    if (!s) return undefined;
    return { ...this.toDto(s, shadowed), body: s.body, resources: listResources(s.dir) };
  }

  setEnabled(name: string, enabled: boolean, workspaceRoot?: string): Skill | undefined {
    const s = this.find(name, workspaceRoot);
    if (!s) return undefined;
    this.db
      .prepare(
        `INSERT INTO skills_state (name, source, enabled, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name, source) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(name, s.source, enabled ? 1 : 0, nowIso());
    return this.list(workspaceRoot).find((x) => x.name === name);
  }

  /** 进入系统提示词的索引：启用、可用、模型可调用；file-patterns 命中的排前面。 */
  index(workspaceRoot?: string, files: string[] = []): { name: string; description: string }[] {
    const { winners } = this.all(workspaceRoot);
    const tools = this.opts.toolNames();
    const usable = winners.filter(
      (s) =>
        s.modelInvocable &&
        this.enabled(s.name, s.source) &&
        missingSkillTools(s, tools, s.references).length === 0,
    );
    const score = (s: LoadedSkill) =>
      s.filePatterns.some((p) => files.some((f) => globMatch(p, f))) ? 1 : 0;
    return usable
      .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, description: s.description.slice(0, 200) }));
  }

  /** 用户 /<name> 调用：返回正文；不存在/未启用/不可调用返回原因。 */
  invoke(name: string, workspaceRoot?: string): { body: string } | { error: string } {
    const s = this.find(name, workspaceRoot);
    if (!s) return { error: `技能不存在：${name}` };
    if (!s.userInvocable) return { error: `技能 ${name} 不允许用户直接调用` };
    if (!this.enabled(s.name, s.source)) return { error: `技能 ${name} 已禁用` };
    const missing = this.missingTools(s, s.references);
    if (missing.length > 0) return { error: `技能 ${name} 缺少工具：${missing.join("、")}` };
    return { body: s.body };
  }

  /** skill://<名称>/<路径> 资源读取；拒绝穿越与符号链接。 */
  readResource(uri: string, workspaceRoot?: string): { text: string } | { error: ToolResult } {
    const m = /^skill:\/\/([a-z0-9-]+)\/(.+)$/.exec(uri);
    const fail = (code: string, message: string) => ({
      error: { status: "error" as const, error: { code, message, retryable: false } },
    });
    if (!m) return fail("INVALID_ARGUMENT", "技能资源地址格式为 skill://<技能名>/<路径>");
    const s = this.find(m[1] ?? "", workspaceRoot);
    if (!s) return fail("NOT_FOUND", `技能不存在：${m[1]}`);
    const rel = m[2] ?? "";
    if (rel.split("/").some((p) => p === ".." || p === "" || p.startsWith(".")))
      return fail("OUT_OF_WORKSPACE", "资源路径不合法");
    const abs = join(s.dir, ...rel.split("/"));
    if (!existsSync(abs)) return fail("NOT_FOUND", `资源不存在：${rel}`);
    const real = realpathSync(abs);
    const base = realpathSync(s.dir);
    if (!real.startsWith(`${base}${sep}`) || lstatSync(abs).isSymbolicLink())
      return fail("OUT_OF_WORKSPACE", "资源路径不合法");
    if (lstatSync(abs).size > MAX_RESOURCE_BYTES) return fail("LIMIT_EXCEEDED", "资源超过 1MB");
    return { text: readFileSync(abs, "utf8") };
  }

  deleteUserSkill(name: string): boolean {
    const s = this.scan(this.opts.userDir, "user").skills.find((x) => x.name === name);
    if (!s) return false;
    return removeDir(s.dir, this.opts.userDir);
  }
}

function removeDir(dir: string, root: string): boolean {
  const real = realpathSync(dir);
  if (!real.startsWith(`${realpathSync(root)}${sep}`)) return false;
  rmSync(real, { recursive: true, force: true });
  return true;
}

const SkillInput = z.strictObject({
  name: z.string().min(1).describe("技能名称（见系统提示词中的技能列表）"),
});

export function skillTool(service: SkillService): ToolDefinition<z.infer<typeof SkillInput>> {
  return {
    name: "skill",
    title: "加载技能",
    description:
      "加载一个技能的正文（某类任务的工作方法）与其资源清单。资源用 read 以 skill://<技能名>/<路径> 读取。加载技能不改变权限、不增加工具。",
    input: SkillInput,
    output: z.record(z.string(), z.unknown()),
    effect: "read",
    targets: () => [],
    replay: "safe",
    timeoutMs: 10_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      const d = service.detail(args.name, ctx.workspaceRoot);
      const fail = (code: string, message: string): ToolResult => ({
        status: "error",
        error: { code, message, retryable: false },
      });
      if (!d) return fail("NOT_FOUND", `技能不存在：${args.name}`);
      if (!d.enabled) return fail("NOT_FOUND", `技能 ${args.name} 已禁用`);
      if (!d.modelInvocable) return fail("INVALID_ARGUMENT", `技能 ${args.name} 只能由用户调用`);
      if (!d.available)
        return fail(
          "UNSUPPORTED_FEATURE",
          `技能 ${args.name} 缺少工具：${d.missingTools.join("、")}`,
        );
      return {
        status: "ok",
        data: {
          name: d.name,
          body: d.body,
          resources: d.resources.map((r) => `skill://${d.name}/${r}`),
        },
      };
    },
  };
}

export interface SkillsModule extends CapabilityModule {
  service: SkillService;
}

export function skillsModule(db: DatabaseSync, opts: SkillServiceOptions): SkillsModule {
  const service = new SkillService(db, opts);
  return {
    id: "skills",
    migrations: [SKILLS_MIGRATION],
    tools: [skillTool(service) as unknown as ToolDefinition],
    service,
  };
}
