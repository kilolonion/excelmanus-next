// 具名迁移 + 旧库探测引导（db.ts）：旧式序号库可无损升级；未知迁移 id 拒绝启动。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";
import { BACKUPS_MIGRATION } from "../src/backup.ts";
import { openDb, SchemaVersionError } from "../src/db.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const moduleMigrations = [
  {
    id: "workbook/documents",
    sql: `CREATE TABLE documents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`,
  },
  {
    id: "workbook/doc-ops",
    sql: `ALTER TABLE documents ADD COLUMN head_rev INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE doc_ops (doc_id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (doc_id, rev));
          CREATE INDEX doc_ops_tool_call ON doc_ops(doc_id);`,
  },
];

test("旧式序号库：按对象探测引导，缺的迁移补齐，已有数据保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  dirs.push(dir);
  const path = join(dir, "t.db");
  // 模拟旧程序建库：只执行 kernel 基础迁移 + 2 条模块迁移，写 meta.schema_version=3
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  raw.exec(KERNEL_MIGRATIONS[0]!.sql);
  for (const m of moduleMigrations) raw.exec(m.sql);
  raw.prepare("INSERT INTO meta VALUES ('schema_version', '3')").run();
  raw
    .prepare("INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)")
    .run("w1", "ws", "/tmp/x", "2026-01-01T00:00:00Z");
  raw
    .prepare(
      "INSERT INTO documents (id, workspace_id, path, rev, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("d1", "w1", "f.xlsx", 7, "2026-01-01T00:00:00Z");
  raw.close();

  const db = openDb(path, [...KERNEL_MIGRATIONS, ...moduleMigrations, BACKUPS_MIGRATION]);
  const applied = (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map(
    (r) => r.id,
  );
  // 已有对象按探测记为已应用；M3 追加的 kernel 迁移与 backups 补齐执行
  expect(applied).toContain("kernel/001-base");
  expect(applied).toContain("workbook/documents");
  expect(applied).toContain("workbook/doc-ops");
  expect(applied).toContain("kernel/002-interactions");
  expect(applied).toContain("kernel/003-inbox-pending");
  expect(applied).toContain("kernel/004-leases");
  expect(applied).toContain("kernel/backups");
  for (const t of ["pending_interactions", "todos", "inbox_pending", "leases", "backups"]) {
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t),
      `缺少表 ${t}`,
    ).toBeDefined();
  }
  expect(
    (db.prepare("SELECT id, rev, head_rev FROM documents").all() as { rev: number }[])[0]?.rev,
  ).toBe(7);
  expect(db.prepare("SELECT 1 FROM workspaces WHERE id = 'w1'").get()).toBeDefined();
  // 旧序号已清除
  expect(db.prepare("SELECT * FROM meta").all()).toEqual([]);
  // 再开一次：幂等，不重复执行
  db.close();
  const again = openDb(path, [...KERNEL_MIGRATIONS, ...moduleMigrations, BACKUPS_MIGRATION]);
  again.close();
});

test("库里有程序不认识的迁移 id → SchemaVersionError 列出未知 id", () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  dirs.push(dir);
  const path = join(dir, "u.db");
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run("future/009-x", "t");
  raw.close();
  expect(() => openDb(path, KERNEL_MIGRATIONS)).toThrowError(SchemaVersionError);
  try {
    openDb(path, KERNEL_MIGRATIONS);
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaVersionError);
    expect((e as SchemaVersionError).unknownIds).toEqual(["future/009-x"]);
  }
});
