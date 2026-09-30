import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import type { BackupInfo, FileIntentMeta, ToolResult } from "@excelmanus/protocol";
import type { Migration } from "./db.ts";
import { resolveWorkspacePath } from "./paths.ts";

export const BACKUPS_MIGRATION: Migration = {
  id: "kernel/backups",
  sql: `
CREATE TABLE backups (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, original_path TEXT NOT NULL,
  backup_path TEXT NOT NULL, sha256 TEXT NOT NULL, session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('backup','created','trash'))
);
CREATE INDEX backups_session_path ON backups(workspace_id, session_id, original_path, kind);
`,
};

export class FileOperationError extends Error {
  readonly code: string;
  readonly uncertain: boolean;
  constructor(code: string, message: string, uncertain = false) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}
export function pathVersion(abs: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (st.isSymbolicLink())
    throw new FileOperationError("OUT_OF_WORKSPACE", "批量文件操作不跟随符号链接");
  if (st.isFile()) return sha256(readFileSync(abs));
  if (!st.isDirectory()) throw new FileOperationError("UNSUPPORTED_FEATURE", "不支持特殊文件");
  const hash = createHash("sha256");
  for (const name of readdirSync(abs).sort()) {
    if (name.toLowerCase() === ".excelmanus")
      throw new FileOperationError("OUT_OF_WORKSPACE", "内部目录不可访问");
    hash.update(JSON.stringify([name, pathVersion(join(abs, name))]));
  }
  return hash.digest("hex");
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Internal storage is never resolved through the agent's path API. Every ancestor is checked. */
export function internalPath(root: string, rel: string): string {
  const base = resolveWorkspacePath(root, ".").abs;
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) {
    throw new FileOperationError("OUT_OF_WORKSPACE", "内部存储路径不合法");
  }
  let p = base;
  for (const part of [".excelmanus", ...parts]) {
    p = join(p, part);
    if (
      existsSync(p) ||
      (() => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    ) {
      if (lstatSync(p).isSymbolicLink())
        throw new FileOperationError("OUT_OF_WORKSPACE", "内部存储不允许符号链接");
    }
  }
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

/** Validate temporary bytes, recheck the destination version, then publish on the same filesystem. */
export function atomicWrite(
  root: string,
  path: string,
  bytes: Uint8Array,
  expected: string | null,
  validate: (bytes: Uint8Array) => void = () => {},
): string {
  const { abs } = resolveWorkspacePath(root, path);
  const tmp = internalPath(root, `tmp/${newId("tmp")}`);
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const back = readFileSync(tmp);
    validate(back);
    if (sha256(back) !== sha256(bytes))
      throw new FileOperationError("INTERNAL", "临时文件回读校验失败");
    const current = existsSync(abs) ? sha256(readFileSync(abs)) : null;
    if (current !== expected)
      throw new FileOperationError("VERSION_CONFLICT", "文件已被外部修改，未覆盖原文件");
    mkdirSync(dirname(abs), { recursive: true });
    // Resolve once more after creating parents, so a preexisting symlink cannot bypass checks.
    if (resolveWorkspacePath(root, path).abs !== abs)
      throw new FileOperationError("OUT_OF_WORKSPACE", "文件路径发生变化");
    if (expected === null) {
      linkSync(tmp, abs);
      rmSync(tmp);
    } else renameSync(tmp, abs);
    return sha256(readFileSync(abs));
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface BackupScope {
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  agentId: string;
}
export interface BoundBackupService {
  needsBackup(path: string): boolean;
  ensureBackup(path: string): BackupInfo | undefined;
  backup(path: string): BackupInfo;
  markCreated(path: string): void;
  trash(path: string): BackupInfo;
  list(path?: string, kind?: "backup" | "trash"): BackupInfo[];
}

export class BackupService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  atomicBatch<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  bind(scope: BackupScope): BoundBackupService {
    return {
      needsBackup: (path) => {
        const { abs, rel } = resolveWorkspacePath(scope.workspaceRoot, path);
        return (
          existsSync(abs) &&
          !this.db
            .prepare(
              "SELECT 1 FROM backups WHERE workspace_id=? AND session_id=? AND original_path=? AND kind IN ('backup','created')",
            )
            .get(scope.workspaceId, scope.sessionId, rel)
        );
      },
      ensureBackup: (path) => {
        const rel = resolveWorkspacePath(scope.workspaceRoot, path).rel;
        const row = this.db
          .prepare(
            "SELECT kind FROM backups WHERE workspace_id=? AND session_id=? AND original_path=? AND kind IN ('backup','created') LIMIT 1",
          )
          .get(scope.workspaceId, scope.sessionId, rel);
        if (row) return undefined;
        const abs = resolveWorkspacePath(scope.workspaceRoot, path).abs;
        return existsSync(abs) ? this.store(scope, rel, "backup") : undefined;
      },
      backup: (path) => this.store(scope, path, "backup"),
      markCreated: (path) => {
        const { abs, rel } = resolveWorkspacePath(scope.workspaceRoot, path);
        const record = (absPath: string, relPath: string) => {
          const hash = pathVersion(absPath) as string;
          const st = statSync(absPath);
          this.insert(scope, relPath, "", "created", hash, st.size);
          if (st.isDirectory())
            for (const name of readdirSync(absPath))
              record(join(absPath, name), `${relPath}/${name}`);
        };
        record(abs, rel);
      },
      trash: (path) => this.store(scope, path, "trash"),
      list: (path, kind = "backup") => {
        const rows = this.db
          .prepare(
            `SELECT * FROM backups WHERE workspace_id=? AND kind=? ${path === undefined ? "" : "AND original_path=?"} ORDER BY created_at DESC, id DESC`,
          )
          .all(
            scope.workspaceId,
            kind,
            ...(path === undefined ? [] : [resolveWorkspacePath(scope.workspaceRoot, path).rel]),
          );
        return rows.map((r) => this.info(r));
      },
    };
  }
  private info(r: Record<string, unknown>): BackupInfo {
    return {
      id: String(r.id),
      originalPath: String(r.original_path),
      backupPath: String(r.backup_path),
      sha256: String(r.sha256),
      size: Number(r.size),
      createdAt: String(r.created_at),
    };
  }
  private insert(
    scope: BackupScope,
    path: string,
    backupPath: string,
    kind: string,
    hash: string,
    size: number,
  ): BackupInfo {
    const id = newId("bak");
    const at = nowIso();
    this.db
      .prepare("INSERT INTO backups VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        scope.workspaceId,
        path,
        backupPath,
        hash,
        scope.sessionId,
        scope.agentId,
        size,
        at,
        kind,
      );
    return { id, originalPath: path, backupPath, sha256: hash, size, createdAt: at };
  }
  private store(scope: BackupScope, path: string, kind: "backup" | "trash"): BackupInfo {
    const { abs, rel } = resolveWorkspacePath(scope.workspaceRoot, path);
    const st = statSync(abs);
    const hash = pathVersion(abs) as string;
    const containerRel = `${kind === "trash" ? "trash" : "backups"}/${nowIso().replaceAll(":", "-")}_${newId("b")}`;
    const container = internalPath(scope.workspaceRoot, containerRel);
    const storageRel = `${containerRel}/${rel}`;
    const dest = internalPath(scope.workspaceRoot, storageRel);
    let insertedId: string | undefined;
    try {
      if (kind === "backup") {
        if (st.isDirectory())
          cpSync(abs, dest, { recursive: true, errorOnExist: true, force: false });
        else copyFileSync(abs, dest);
        if (pathVersion(dest) !== hash)
          throw new FileOperationError("INTERNAL", "备份回读校验失败");
      }
      const info = this.insert(scope, rel, `.excelmanus/${storageRel}`, kind, hash, st.size);
      insertedId = info.id;
      if (kind === "trash") {
        if (pathVersion(abs) !== hash)
          throw new FileOperationError("VERSION_CONFLICT", "删除前文件发生变化");
        renameSync(abs, dest);
      }
      return info;
    } catch (e) {
      if (insertedId) this.db.prepare("DELETE FROM backups WHERE id=?").run(insertedId);
      rmSync(container, { force: true, recursive: true });
      throw e;
    }
  }
  pruneBackups(workspaceId: string, root: string): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM backups WHERE workspace_id=? AND kind='backup' ORDER BY created_at DESC, id DESC",
      )
      .all(workspaceId);
    const counts = new Map<string, number>();
    const cutoff = Date.now() - 30 * 86400_000;
    for (const r of rows) {
      const path = String(r.original_path);
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      if (count <= 20 && Date.parse(String(r.created_at)) >= cutoff) continue;
      const stored = String(r.backup_path);
      if (!stored.startsWith(".excelmanus/backups/")) continue;
      const dest = internalPath(root, stored.slice(".excelmanus/".length));
      const rel = relative(resolveWorkspacePath(root, ".").abs, dest);
      if (rel.startsWith(`.excelmanus${sep}backups${sep}`))
        rmSync(dest, { force: true, recursive: true });
      this.db.prepare("DELETE FROM backups WHERE id=?").run(String(r.id));
    }
  }
  recover(meta: FileIntentMeta | undefined): ToolResult {
    if (!meta)
      return {
        status: "uncertain",
        error: { code: "CANCELLED", message: "缺少执行前文件哈希，结果不确定", retryable: false },
      };
    const row = this.db.prepare("SELECT path FROM workspaces WHERE id=?").get(meta.workspaceId) as
      | { path: string }
      | undefined;
    try {
      const unchanged =
        row &&
        Object.entries(meta.paths).every(([p, h]) => {
          const abs = resolveWorkspacePath(row.path, p).abs;
          return pathVersion(abs) === h;
        });
      return {
        status: unchanged ? "not_executed" : "uncertain",
        error: {
          code: "CANCELLED",
          message: unchanged
            ? "进程中断，目标文件未变化；未自动重放"
            : "进程中断，目标文件已变化，结果不确定；未自动重放",
          retryable: false,
        },
      };
    } catch {
      return {
        status: "uncertain",
        error: {
          code: "CANCELLED",
          message: "目标文件无法核实，结果不确定；未自动重放",
          retryable: false,
        },
      };
    }
  }
}
