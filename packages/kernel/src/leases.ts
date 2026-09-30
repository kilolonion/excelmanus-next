import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import type { Migration } from "./db.ts";

/** M3 文件租约表。租约是协调提示，默认没有租约的写入仍然允许。 */
export const LEASES_MIGRATION: Migration = {
  id: "kernel/004-leases",
  sql: `
  CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'file',
    created_at TEXT NOT NULL,
    UNIQUE (session_id, path, agent_id, scope)
  );
  CREATE INDEX IF NOT EXISTS leases_target ON leases(session_id, path);
  CREATE INDEX IF NOT EXISTS leases_agent ON leases(session_id, agent_id);
`,
};

export interface LeaseRequest {
  sessionId: string;
  agentId: string;
  targets: string[];
}

export interface LeaseRow {
  id: string;
  session_id: string;
  path: string;
  agent_id: string;
  scope: string;
  created_at: string;
}

export class FileLeaseError extends Error {
  readonly code = "FILE_LEASED" as const;
  readonly holder: LeaseRow;
  readonly target: string;
  constructor(holder: LeaseRow, target: string) {
    super(`文件 ${target} 已由代理 ${holder.agent_id} 负责写入`);
    this.holder = holder;
    this.target = target;
    this.name = "FileLeaseError";
  }
}

function normalizeTarget(target: string): string {
  return target.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

/** 区域租约使用常见的 path!Sheet!A1:B2 形状；解析失败时按整路径保守处理。 */
function targetParts(target: string): {
  path: string;
  sheet?: string;
  range?: { r0: number; c0: number; r1: number; c1: number };
} {
  const normalized = normalizeTarget(target);
  const bang = normalized.indexOf("!");
  if (bang < 0) return { path: normalized };
  const path = normalized.slice(0, bang);
  const rest = normalized.slice(bang + 1);
  const second = rest.lastIndexOf("!");
  if (second < 0) return { path, sheet: rest };
  const sheet = rest.slice(0, second);
  const range = parseA1(rest.slice(second + 1));
  return range ? { path, sheet, range } : { path, sheet };
}

function parseCell(s: string): { r: number; c: number } | undefined {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  let c = 0;
  for (const ch of m[1]?.toUpperCase() ?? "") c = c * 26 + ch.charCodeAt(0) - 64;
  const r = Number(m[2]);
  return Number.isInteger(r) && r > 0 ? { r, c } : undefined;
}

function parseA1(value: string): { r0: number; c0: number; r1: number; c1: number } | undefined {
  const [left, right = left] = value.split(":");
  const a = parseCell(left ?? "");
  const b = parseCell(right ?? "");
  if (!a || !b) return undefined;
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c),
  };
}

function overlaps(a: string, b: string): boolean {
  const left = targetParts(a);
  const right = targetParts(b);
  if (left.path !== right.path) {
    // A directory lease covers descendants. This also makes a lease on a newly
    // created output directory useful before the file exists.
    if (left.path === "." || right.path === ".") return true;
    return left.path.startsWith(`${right.path}/`) || right.path.startsWith(`${left.path}/`);
  }
  if (left.sheet !== undefined && right.sheet !== undefined && left.sheet !== right.sheet)
    return false;
  if (left.range && right.range) {
    return !(
      left.range.r1 < right.range.r0 ||
      right.range.r1 < left.range.r0 ||
      left.range.c1 < right.range.c0 ||
      right.range.c1 < left.range.c0
    );
  }
  return true;
}

export class LeaseService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(sessionId: string, agentId?: string): LeaseRow[] {
    const rows =
      agentId === undefined
        ? this.db
            .prepare("SELECT * FROM leases WHERE session_id = ? ORDER BY created_at")
            .all(sessionId)
        : this.db
            .prepare(
              "SELECT * FROM leases WHERE session_id = ? AND agent_id = ? ORDER BY created_at",
            )
            .all(sessionId, agentId);
    return rows as unknown as LeaseRow[];
  }

  /** 先检查整批目标，再一次性登记，避免部分租约留下。 */
  acquire(req: LeaseRequest): LeaseRow[] {
    const targets = [...new Set(req.targets.map(normalizeTarget).filter(Boolean))];
    const existing = this.list(req.sessionId);
    for (const target of targets) {
      const conflict = existing.find(
        (row) => row.agent_id !== req.agentId && overlaps(target, row.path),
      );
      if (conflict) throw new FileLeaseError(conflict, target);
    }
    const now = nowIso();
    const out: LeaseRow[] = [];
    for (const target of targets) {
      const scope = target.includes("!") ? "range" : "file";
      this.db
        .prepare(
          `INSERT INTO leases (id, session_id, path, agent_id, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, path, agent_id, scope) DO NOTHING`,
        )
        .run(newId("lease"), req.sessionId, target, req.agentId, scope, now);
      const row = this.db
        .prepare(
          "SELECT * FROM leases WHERE session_id = ? AND path = ? AND agent_id = ? AND scope = ?",
        )
        .get(req.sessionId, target, req.agentId, scope) as LeaseRow | undefined;
      if (row) out.push(row);
    }
    return out;
  }

  /** 写工具执行前调用；主代理可选择跳过（主代理不受租约限制）。 */
  assertAvailable(req: LeaseRequest, opts: { mainBypass?: boolean } = {}): void {
    if (opts.mainBypass && req.agentId === "main") return;
    for (const target of req.targets.map(normalizeTarget)) {
      if (!target) continue;
      const conflict = this.list(req.sessionId).find(
        (row) => row.agent_id !== req.agentId && overlaps(target, row.path),
      );
      if (conflict) throw new FileLeaseError(conflict, target);
    }
  }

  releaseForAgent(sessionId: string, agentId: string): number {
    return Number(
      this.db
        .prepare("DELETE FROM leases WHERE session_id = ? AND agent_id = ?")
        .run(sessionId, agentId).changes,
    );
  }

  release(sessionId: string, id: string): boolean {
    return (
      this.db.prepare("DELETE FROM leases WHERE session_id = ? AND id = ?").run(sessionId, id)
        .changes > 0
    );
  }
}
