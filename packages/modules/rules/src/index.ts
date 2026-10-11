// modules/rules：全局与会话规则（12 §3）。规则按启用状态原样注入系统提示词；
// 会话中途修改由装配层追加 context.notice 告知代理（04 §7.3）。

import { newId, nowIso } from "@excelmanus/core";
import type { CapabilityModule, DatabaseSync, Migration } from "@excelmanus/kernel";
import { RULE_MAX_CHARS, RULES_TOTAL_MAX_CHARS, type Rule } from "@excelmanus/protocol";

export const RULES_MIGRATION: Migration = {
  id: "rules/001-rules",
  sql: `
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','session')),
  session_id TEXT,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX rules_session ON rules(scope, session_id);
`,
};

interface RuleRow {
  id: string;
  scope: "global" | "session";
  session_id: string | null;
  content: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const dto = (r: RuleRow): Rule => ({
  id: r.id,
  scope: r.scope,
  sessionId: r.session_id,
  content: r.content,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class RuleLimitError extends Error {}

export class RuleService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 全局规则 + 指定会话的会话规则（未指定则只全局 + 全部会话规则都不返回）。 */
  list(sessionId?: string): Rule[] {
    const rows = (sessionId === undefined
      ? this.db.prepare("SELECT * FROM rules WHERE scope = 'global' ORDER BY created_at").all()
      : this.db
          .prepare(
            "SELECT * FROM rules WHERE scope = 'global' OR (scope = 'session' AND session_id = ?) ORDER BY scope, created_at",
          )
          .all(sessionId)) as unknown as RuleRow[];
    return rows.map(dto);
  }

  get(id: string): Rule | undefined {
    const row = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | undefined;
    return row ? dto(row) : undefined;
  }

  /** 启用规则的正文（注入系统提示词用），全局在前。 */
  enabledTexts(sessionId?: string): string[] {
    return this.list(sessionId)
      .filter((r) => r.enabled)
      .map((r) => r.content);
  }

  totalChars(sessionId?: string): number {
    return this.enabledTexts(sessionId).reduce((n, t) => n + t.length, 0);
  }

  create(input: {
    scope: "global" | "session";
    sessionId?: string;
    content: string;
    enabled?: boolean;
  }): Rule {
    const content = input.content.trim();
    if (content.length > RULE_MAX_CHARS)
      throw new RuleLimitError(`单条规则不能超过 ${RULE_MAX_CHARS} 字`);
    if (input.scope === "session" && !input.sessionId)
      throw new RuleLimitError("会话规则需要指定会话");
    const enabled = input.enabled ?? true;
    if (enabled) this.assertTotal(input.sessionId, content.length);
    const id = newId("rule");
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO rules (id, scope, session_id, content, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.scope,
        input.scope === "session" ? (input.sessionId ?? null) : null,
        content,
        enabled ? 1 : 0,
        now,
        now,
      );
    return this.get(id) as Rule;
  }

  update(id: string, patch: { content?: string; enabled?: boolean }): Rule | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const content = patch.content?.trim() ?? cur.content;
    const enabled = patch.enabled ?? cur.enabled;
    if (content.length > RULE_MAX_CHARS)
      throw new RuleLimitError(`单条规则不能超过 ${RULE_MAX_CHARS} 字`);
    if (enabled) {
      const others =
        this.totalChars(cur.sessionId ?? undefined) - (cur.enabled ? cur.content.length : 0);
      if (others + content.length > RULES_TOTAL_MAX_CHARS) {
        throw new RuleLimitError(`启用规则总量不能超过 ${RULES_TOTAL_MAX_CHARS} 字`);
      }
    }
    this.db
      .prepare("UPDATE rules SET content = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(content, enabled ? 1 : 0, nowIso(), id);
    return this.get(id);
  }

  delete(id: string): Rule | undefined {
    const cur = this.get(id);
    if (cur) this.db.prepare("DELETE FROM rules WHERE id = ?").run(id);
    return cur;
  }

  deleteForSession(sessionId: string): void {
    this.db.prepare("DELETE FROM rules WHERE scope = 'session' AND session_id = ?").run(sessionId);
  }

  private assertTotal(sessionId: string | undefined, add: number): void {
    if (this.totalChars(sessionId) + add > RULES_TOTAL_MAX_CHARS) {
      throw new RuleLimitError(`启用规则总量不能超过 ${RULES_TOTAL_MAX_CHARS} 字`);
    }
  }
}

export interface RulesModule extends CapabilityModule {
  service: RuleService;
}

export function rulesModule(db: DatabaseSync): RulesModule {
  return { id: "rules", migrations: [RULES_MIGRATION], service: new RuleService(db) };
}
