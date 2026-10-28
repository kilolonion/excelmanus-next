// node:sqlite 存储层（10 §2、ADR 0004）：WAL/NORMAL/foreign_keys/busy_timeout=5000。
// 具名迁移（ADR 0004 修订 2026-09-30）：每条迁移有稳定 id，应用记录存 schema_migrations；
// 全局序号在多来源迁移各自追加时会错位（kernel 新增条目使模块迁移序号整体后移），
// 故弃用 meta.schema_version 序号，旧库由对象探测一次性引导。库里有程序不认识的迁移 id 拒绝启动。
// 迁移前备份 .bak-<已应用条数>（保留最近 3 份）。ADR 0006：不引入 Kysely。

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "@excelmanus/core";

// ADR 0004：只过滤 Node 24 的 ExperimentalWarning: SQLite 这一条警告，其他警告照常。
let warningFiltered = false;
function suppressSqliteWarning(): void {
  if (warningFiltered) return;
  warningFiltered = true;
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const name =
      typeof warning === "object" && warning !== null && "name" in warning
        ? String((warning as { name: unknown }).name)
        : undefined;
    const text =
      typeof warning === "string"
        ? warning
        : warning instanceof Error
          ? warning.message
          : String(warning);
    if (text.includes("SQLite") && (name === undefined || name === "ExperimentalWarning")) {
      return;
    }
    return (orig as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

export interface Migration {
  /** 稳定唯一 id（如 `kernel/001-base`、`workbook/documents`）；发布后不得改名。 */
  id: string;
  sql: string;
}

export class SchemaVersionError extends Error {
  readonly unknownIds: readonly string[];

  constructor(unknownIds: readonly string[]) {
    super(
      `数据库包含程序无法识别的迁移记录：${unknownIds.join("、")}；不可降级：当前程序无法保证执行该版本的权限及状态语义，拒绝启动。不得删除版本标记或权限事件；请使用兼容版本并核对一致性恢复点`,
    );
    this.name = "SchemaVersionError";
    this.unknownIds = unknownIds;
  }
}

function legacyVersionRow(db: DatabaseSync): { value: string } | undefined {
  return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
}

function backupDb(dbPath: string, appliedCount: number): void {
  copyFileSync(dbPath, `${dbPath}.bak-${appliedCount}`);
  const dir = dirname(dbPath);
  const base = dbPath.split("/").pop() ?? "";
  const baks = readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.bak-`))
    .map((f) => ({ f, v: Number(f.slice(`${base}.bak-`.length)) }))
    .filter((b) => Number.isInteger(b.v))
    .sort((a, b) => b.v - a.v);
  for (const old of baks.slice(3)) {
    unlinkSync(`${dir}/${old.f}`);
  }
}

type DeclaredObject =
  | { kind: "table" | "index"; name: string }
  | { kind: "column"; table: string; column: string };

/** 从迁移 SQL 自动推导它会建立/依赖的对象（探测规则，不做手写映射）。 */
function declaredObjects(sql: string): DeclaredObject[] {
  const out: DeclaredObject[] = [];
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[\]]?(\w+)/gi)) {
    out.push({ kind: "table", name: m[1]! });
  }
  for (const m of sql.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[\]]?(\w+)/gi,
  )) {
    out.push({ kind: "index", name: m[1]! });
  }
  for (const m of sql.matchAll(
    /ALTER\s+TABLE\s+["'`[\]]?(\w+)["'`\].\s]*?\s+ADD\s+COLUMN\s+["'`[\]]?(\w+)/gi,
  )) {
    out.push({ kind: "column", table: m[1]!, column: m[2]! });
  }
  return out;
}

function objectExists(db: DatabaseSync, o: DeclaredObject): boolean {
  if (o.kind === "column") {
    return (
      db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(o.table, o.column) !==
      undefined
    );
  }
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(o.name) !== undefined;
}

/**
 * 打开（必要时创建并迁移）主库。
 * @param migrations 有序具名迁移，由 kernel 基础迁移 + 各模块迁移拼接而成。
 */
export function openDb(dbPath: string, migrations: readonly Migration[]): DatabaseSync {
  suppressSqliteWarning();
  const parent = dirname(dbPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const known = new Set(migrations.map((m) => m.id));
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
  );
  const unknown = [...applied].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    db.close();
    throw new SchemaVersionError(unknown);
  }

  // 旧库引导：有 meta.schema_version 序号、无 schema_migrations 记录 → 按对象探测逐条判定。
  const legacy = legacyVersionRow(db);
  const bootstrapMarks: string[] = [];
  const pending: Migration[] = [];
  if (legacy !== undefined && applied.size === 0) {
    for (const m of migrations) {
      const objs = declaredObjects(m.sql);
      const flags = objs.map((o) => ({ o, exists: objectExists(db, o) }));
      const nExist = flags.filter((f) => f.exists).length;
      if (objs.length > 0 && nExist === objs.length) {
        bootstrapMarks.push(m.id);
      } else if (nExist === 0) {
        pending.push(m);
      } else {
        const have = flags
          .filter((f) => f.exists)
          .map((f) => (f.o.kind === "column" ? `${f.o.table}.${f.o.column}` : f.o.name));
        const missing = flags
          .filter((f) => !f.exists)
          .map((f) => (f.o.kind === "column" ? `${f.o.table}.${f.o.column}` : f.o.name));
        db.close();
        throw new Error(
          `迁移 ${m.id} 处于部分应用状态（已存在：${have.join("、")}；缺失：${missing.join("、")}），数据库不一致，拒绝自动修复`,
        );
      }
    }
  } else {
    for (const m of migrations) if (!applied.has(m.id)) pending.push(m);
  }

  const marked = new Set([...applied, ...bootstrapMarks]);
  const toRun = pending.filter((m) => !marked.has(m.id));
  if (legacy === undefined && toRun.length === 0 && bootstrapMarks.length === 0) return db;
  if (legacy !== undefined && toRun.length === 0 && bootstrapMarks.length === 0) {
    // 仅需要清掉旧序号
    db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    return db;
  }
  if (marked.size > 0) backupDb(dbPath, marked.size);
  db.exec("BEGIN");
  try {
    const ins = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    for (const id of bootstrapMarks) ins.run(id, nowIso());
    for (const m of toRun) {
      db.exec(m.sql);
      ins.run(m.id, nowIso());
    }
    db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.close();
    throw err;
  }
  return db;
}
