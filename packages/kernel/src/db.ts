// node:sqlite 存储层（10 §2、ADR 0004）：WAL/NORMAL/foreign_keys/busy_timeout=5000，
// 手写有序迁移，库版本高于程序版本拒绝启动，迁移前备份 .bak-<ver>（保留最近 3 份）。
// ADR 0006 决定：不引入 Kysely，直接用 DatabaseSync + 预编译语句。

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

export class SchemaVersionError extends Error {
  readonly dbVersion: number;
  readonly codeVersion: number;

  constructor(dbVersion: number, codeVersion: number) {
    super(`数据库 schema 版本 ${dbVersion} 高于程序支持的 ${codeVersion}，拒绝启动`);
    this.name = "SchemaVersionError";
    this.dbVersion = dbVersion;
    this.codeVersion = codeVersion;
  }
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function backupDb(dbPath: string, version: number): void {
  copyFileSync(dbPath, `${dbPath}.bak-${version}`);
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

/**
 * 打开（必要时创建并迁移）主库。
 * @param migrations 有序 SQL 字符串数组，由 kernel 基础迁移 + 各模块迁移拼接而成。
 */
export function openDb(dbPath: string, migrations: readonly string[]): DatabaseSync {
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
  `);
  const current = readVersion(db);
  if (current > migrations.length) {
    db.close();
    throw new SchemaVersionError(current, migrations.length);
  }
  if (current < migrations.length) {
    if (current > 0) backupDb(dbPath, current);
    db.exec("BEGIN");
    try {
      for (let i = current; i < migrations.length; i++) {
        db.exec(migrations[i] ?? "");
        db.prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(String(i + 1));
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      db.close();
      throw err;
    }
  }
  return db;
}
