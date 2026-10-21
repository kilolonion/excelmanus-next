// modules/memory：记忆（12 §2）。memories 表 + FTS5 trigram 索引（ADR 0004：中文检索
// 用 trigram，短于 3 字的查询回退 LIKE）。代理用 memory 工具 save/search/delete；
// 每轮相关记忆由装配层在受理消息时选出写入 user.message（投影可重建）。

import { newId, nowIso } from "@excelmanus/core";
import type {
  CapabilityModule,
  DatabaseSync,
  Migration,
  SessionLog,
  ToolDefinition,
} from "@excelmanus/kernel";
import { type Memory, MemoryCategory, type ToolResult } from "@excelmanus/protocol";
import { z } from "zod";

export const MEMORIES_MIGRATION: Migration = {
  id: "memory/001-memories",
  sql: `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  workspace_id TEXT,
  source_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`,
};

interface MemoryRow {
  id: string;
  content: string;
  category: string;
  workspace_id: string | null;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

const dto = (r: MemoryRow): Memory => ({
  id: r.id,
  content: r.content,
  category: MemoryCategory.catch("lesson").parse(r.category),
  workspaceId: r.workspace_id,
  sourceSessionId: r.source_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
});

/** 注入预算：约 1,500 token（12 §2.3），按字符数/2 粗估中文 token。 */
const INJECT_CHAR_BUDGET = 3000;
const INJECT_MAX_ITEMS = 8;

/** 从自然语言中取检索词：连续中文按 2–4 字滑窗，英文/数字按词。 */
export function queryTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []) terms.add(w);
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
    if (run.length <= 4) terms.add(run);
    for (let n = 2; n <= 3; n++)
      for (let i = 0; i + n <= run.length; i++) terms.add(run.slice(i, i + n));
  }
  return [...terms].slice(0, 40);
}

export class MemoryService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(opts: { workspaceId?: string; query?: string; limit?: number } = {}): Memory[] {
    const limit = Math.min(opts.limit ?? 200, 500);
    if (opts.query && opts.query.trim() !== "")
      return this.search(opts.query, opts.workspaceId, limit);
    const rows = (opts.workspaceId === undefined
      ? this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(limit)
      : this.db
          .prepare(
            "SELECT * FROM memories WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY updated_at DESC LIMIT ?",
          )
          .all(opts.workspaceId, limit)) as unknown as MemoryRow[];
    return rows.map(dto);
  }

  get(id: string): Memory | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? dto(row) : undefined;
  }

  create(input: {
    content: string;
    category: string;
    workspaceId?: string | null;
    sourceSessionId?: string | null;
  }): Memory {
    const id = newId("mem");
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO memories (id, content, category, workspace_id, source_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.content.trim(),
        input.category,
        input.workspaceId ?? null,
        input.sourceSessionId ?? null,
        now,
        now,
      );
    return this.get(id) as Memory;
  }

  update(
    id: string,
    patch: { content?: string; category?: string; workspaceId?: string | null },
  ): Memory | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    this.db
      .prepare(
        "UPDATE memories SET content = ?, category = ?, workspace_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.content?.trim() ?? cur.content,
        patch.category ?? cur.category,
        patch.workspaceId !== undefined ? patch.workspaceId : cur.workspaceId,
        nowIso(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
  }

  /** 关键词检索：FTS5 trigram（≥3 字）+ 短词 LIKE 回退，按命中词数与最近使用排序。 */
  search(text: string, workspaceId?: string, limit = 20): Memory[] {
    const terms = queryTerms(text);
    const whole = text.trim();
    if (whole !== "" && !terms.includes(whole) && whole.length <= 64) terms.unshift(whole);
    if (terms.length === 0) return [];
    const scores = new Map<string, number>();
    const scope =
      workspaceId === undefined ? "" : " AND (m.workspace_id IS NULL OR m.workspace_id = ?)";
    const scopeArgs = workspaceId === undefined ? [] : [workspaceId];
    for (const term of terms) {
      const ids =
        term.length >= 3
          ? (this.db
              .prepare(
                `SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?${scope}`,
              )
              .all(`"${term.replaceAll('"', '""')}"`, ...scopeArgs) as { id: string }[])
          : (this.db
              .prepare(`SELECT m.id FROM memories m WHERE m.content LIKE ? ESCAPE '\\'${scope}`)
              .all(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, ...scopeArgs) as {
              id: string;
            }[]);
      for (const { id } of ids) scores.set(id, (scores.get(id) ?? 0) + term.length);
    }
    if (scores.size === 0) return [];
    const rows = [...scores.keys()]
      .map(
        (id) =>
          this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined,
      )
      .filter((r): r is MemoryRow => r !== undefined);
    rows.sort(
      (a, b) =>
        (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
        (b.last_used_at ?? b.updated_at).localeCompare(a.last_used_at ?? a.updated_at),
    );
    return rows.slice(0, limit).map(dto);
  }

  /**
   * 每轮注入（12 §2.3）：与消息相关的记忆 + 偏好类最近使用的记忆，排除本会话已注入的，
   * 总量不超过预算。选中即更新 last_used_at。
   */
  selectForTurn(text: string, workspaceId: string, exclude: ReadonlySet<string>): Memory[] {
    const related = this.search(text, workspaceId, 20);
    const prefs = (
      this.db
        .prepare(
          "SELECT * FROM memories WHERE category = 'preference' AND (workspace_id IS NULL OR workspace_id = ?) ORDER BY COALESCE(last_used_at, updated_at) DESC LIMIT 5",
        )
        .all(workspaceId) as unknown as MemoryRow[]
    ).map(dto);
    const out: Memory[] = [];
    let chars = 0;
    for (const m of [...related, ...prefs]) {
      if (exclude.has(m.id) || out.some((o) => o.id === m.id)) continue;
      if (chars + m.content.length > INJECT_CHAR_BUDGET || out.length >= INJECT_MAX_ITEMS) break;
      out.push(m);
      chars += m.content.length;
    }
    if (out.length > 0) {
      const now = nowIso();
      const touch = this.db.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
      for (const m of out) touch.run(now, m.id);
    }
    return out;
  }
}

const MemoryInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"),
    content: z.string().trim().min(1).max(2000).describe("要记住的一句话，写清适用条件"),
    category: MemoryCategory.describe(
      "preference 偏好 / domain 业务知识 / file 文件说明 / lesson 经验",
    ),
    scope: z
      .enum(["global", "workspace"])
      .optional()
      .describe("默认 global；只对当前工作区有效时用 workspace"),
  }),
  z.strictObject({
    action: z.literal("search"),
    query: z.string().trim().min(1).describe("关键词"),
    limit: z.int().min(1).max(50).optional(),
  }),
  z.strictObject({ action: z.literal("delete"), id: z.string().min(1) }),
]);
// Some compatible model adapters inspect only root properties. Keep the advertised
// shape flat; the discriminated union above remains the strict execution validator.
const MemoryModelInput = z.strictObject({
  action: z
    .enum(["save", "search", "delete"])
    .describe("必填：save 保存、search 检索、delete 删除"),
  content: MemoryInput.options[0].shape.content
    .optional()
    .describe("action=save 时必填：要长期记住的一句话"),
  category: MemoryInput.options[0].shape.category
    .optional()
    .describe("action=save 时必填：preference/domain/file/lesson"),
  scope: MemoryInput.options[0].shape.scope,
  query: MemoryInput.options[1].shape.query.optional().describe("action=search 时必填：检索关键词"),
  limit: MemoryInput.options[1].shape.limit,
  id: MemoryInput.options[2].shape.id.optional().describe("action=delete 时必填：已存在记忆的 id"),
});
const MemoryJsonSchema = z.toJSONSchema(MemoryModelInput);

type MemoryArgs = z.infer<typeof MemoryInput>;

const err = (code: string, message: string): ToolResult => ({
  status: "error",
  error: { code, message, retryable: false },
});

export function memoryTool(service: MemoryService, log: SessionLog): ToolDefinition<MemoryArgs> {
  return {
    name: "memory",
    title: "记忆",
    description:
      "跨会话的长期记忆。action 必填；save 需要 content 与 category，search 需要 query，delete 需要 id。save 保存一条用户偏好、业务口径、文件说明或经验（用户会看到“已记住”并可撤销）；search 按关键词检索已有记忆；delete 删除一条（按 id）。只保存以后仍有用的稳定信息，不保存一次性任务细节。",
    input: MemoryInput,
    inputJsonSchema: MemoryJsonSchema,
    output: z.record(z.string(), z.unknown()),
    effect: "state",
    targets: () => [],
    replay: (args: MemoryArgs | null) => (args?.action === "search" ? "safe" : "unsafe"),
    timeoutMs: 10_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      // 06 §8 / 12 §2.3：worker 以下只能 search
      if (args.action !== "search" && (ctx.role === "worker" || ctx.role === "reader")) {
        return err("INVALID_ARGUMENT", "当前角色只能检索记忆，不能保存或删除");
      }
      if (args.action === "search") {
        const items = service.search(args.query, ctx.workspaceId, args.limit ?? 10);
        return {
          status: "ok",
          data: {
            items: items.map((m) => ({ id: m.id, category: m.category, content: m.content })),
          },
        };
      }
      if (args.action === "save") {
        const dup = service
          .search(args.content, ctx.workspaceId, 5)
          .find((m) => m.content === args.content.trim());
        if (dup) return { status: "ok", data: { id: dup.id, duplicate: true } };
        const m = service.create({
          content: args.content,
          category: args.category,
          workspaceId: args.scope === "workspace" ? ctx.workspaceId : null,
          sourceSessionId: ctx.sessionId,
        });
        log.append(ctx.sessionId, ctx.agentId, [
          {
            type: "memory.saved",
            data: { memoryId: m.id, content: m.content, category: m.category },
          },
        ]);
        return { status: "ok", data: { id: m.id } };
      }
      if (!service.get(args.id)) return err("NOT_FOUND", `记忆不存在：${args.id}`);
      service.delete(args.id);
      log.append(ctx.sessionId, ctx.agentId, [
        { type: "memory.deleted", data: { memoryId: args.id } },
      ]);
      return { status: "ok", data: { deleted: args.id } };
    },
  };
}

export interface MemoryModule extends CapabilityModule {
  service: MemoryService;
}

export function memoryModule(db: DatabaseSync, log?: SessionLog): MemoryModule {
  const service = new MemoryService(db);
  return {
    id: "memory",
    migrations: [MEMORIES_MIGRATION],
    tools: log ? [memoryTool(service, log) as unknown as ToolDefinition] : [],
    service,
  };
}
