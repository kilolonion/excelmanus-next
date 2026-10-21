import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import type { BackupInfo, FileIntentMeta, ToolResult } from "@excelmanus/protocol";
import type { Migration } from "./db.ts";
import { isInternalName, listProtectedRoots, resolveWorkspacePath } from "./paths.ts";
import {
  assertFiniteFileParent,
  canonicalWorkspaceRoot,
  currentToolAccess,
  runWithBufferedAccessFacts,
  withFileAccessSync,
} from "./tool-access.ts";

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
  return versionOf(abs, false);
}

/** Internal copies are host-selected storage, never paths accepted from a tool argument. */
function versionOf(abs: string, storage: boolean): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = storage
      ? lstatSync(abs)
      : withFileAccessSync({ kind: "file-metadata", path: abs, purpose: "hash" }, () =>
          lstatSync(abs),
        );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (st.isSymbolicLink())
    throw new FileOperationError("OUT_OF_WORKSPACE", "批量文件操作不跟随符号链接");
  if (st.isFile())
    return sha256(
      storage
        ? readFileSync(abs)
        : withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "hash" }, () =>
            readFileSync(abs),
          ),
    );
  if (!st.isDirectory()) throw new FileOperationError("UNSUPPORTED_FEATURE", "不支持特殊文件");
  const hash = createHash("sha256");
  const names = storage
    ? readdirSync(abs)
    : withFileAccessSync({ kind: "directory-enumeration", path: abs, purpose: "hash" }, () =>
        readdirSync(abs),
      );
  for (const name of names.sort()) {
    if (isInternalName(name) || listProtectedRoots().includes(join(abs, name)))
      throw new FileOperationError("OUT_OF_WORKSPACE", "内部目录不可访问");
    hash.update(JSON.stringify([name, versionOf(join(abs, name), storage)]));
  }
  return hash.digest("hex");
}

function copyPath(
  source: string,
  destination: string,
  sourceStorage = false,
  destinationStorage = false,
): void {
  if (!currentToolAccess() || currentToolAccess()?.binding().decision.kind === "unbounded") {
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    return;
  }
  const st = sourceStorage
    ? lstatSync(source)
    : withFileAccessSync({ kind: "file-metadata", path: source, purpose: "copy" }, () =>
        lstatSync(source),
      );
  if (st.isSymbolicLink())
    throw new FileOperationError("OUT_OF_WORKSPACE", "批量文件操作不跟随符号链接");
  const write = <T>(action: () => T): T =>
    destinationStorage
      ? action()
      : withFileAccessSync({ kind: "file-write", path: destination, purpose: "copy" }, action);
  if (st.isDirectory()) {
    write(() => mkdirSync(destination, { recursive: true }));
    const names = sourceStorage
      ? readdirSync(source)
      : withFileAccessSync({ kind: "directory-enumeration", path: source, purpose: "copy" }, () =>
          readdirSync(source),
        );
    for (const name of names)
      copyPath(join(source, name), join(destination, name), sourceStorage, destinationStorage);
  } else if (st.isFile()) {
    const copy = () => write(() => copyFileSync(source, destination, constants.COPYFILE_EXCL));
    if (sourceStorage) copy();
    else withFileAccessSync({ kind: "file-bytes", path: source, purpose: "copy" }, copy);
  } else throw new FileOperationError("UNSUPPORTED_FEATURE", "不支持特殊文件");
}

/** Both endpoints remain user resources; staging exemptions are deliberately private. */
export function copyWorkspacePath(
  root: string,
  from: string,
  to: string,
  registerUndo?: (undo: () => void) => void,
):
  | { version: 1; sourceSha256: string; destinationSha256: string; destinationWasAbsent: true }
  | undefined {
  const source = resolveWorkspacePath(root, from).abs;
  const destination = resolveWorkspacePath(root, to).abs;
  const regular =
    registerUndo &&
    withFileAccessSync({ kind: "file-metadata", path: source, purpose: "copy" }, () =>
      lstatSync(source).isFile(),
    );
  if (!regular) {
    registerUndo?.(() =>
      withFileAccessSync({ kind: "file-write", path: destination, purpose: "rollback" }, () =>
        rmSync(destination, { recursive: true, force: true }),
      ),
    );
    copyPath(source, destination);
    return;
  }
  return withFileAccessSync({ kind: "file-bytes", path: source, purpose: "copy" }, () =>
    withFileAccessSync({ kind: "file-write", path: destination, purpose: "copy" }, () => {
      const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let destinationFd: number | undefined;
      let created: ReturnType<typeof fstatSync> | undefined;
      const sameFile = (a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>) =>
        a.dev === b.dev && a.ino === b.ino && b.isFile();
      const stable = (a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>) =>
        sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
      registerUndo!(() =>
        withFileAccessSync({ kind: "file-write", path: destination, purpose: "rollback" }, () => {
          let current: ReturnType<typeof lstatSync>;
          try {
            current = lstatSync(destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          if (!created || !sameFile(created, current))
            throw new FileOperationError(
              "VERSION_CONFLICT",
              "复制目标已被替换，未触碰替换者",
              true,
            );
          rmSync(destination);
        }),
      );
      try {
        const initial = fstatSync(sourceFd);
        if (!initial.isFile())
          throw new FileOperationError("UNSUPPORTED_FEATURE", "不支持特殊文件");
        // Like COPYFILE_EXCL, never replace an existing destination. Keep the fd that we created.
        destinationFd = openSync(destination, "wx+", initial.mode);
        created = fstatSync(destinationFd);
        const sourceHash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (true) {
          const size = readSync(sourceFd, buffer, 0, buffer.length, offset);
          if (size <= 0) break;
          sourceHash.update(buffer.subarray(0, size));
          let written = 0;
          while (written < size) {
            const count = writeSync(
              destinationFd,
              buffer,
              written,
              size - written,
              offset + written,
            );
            if (!count) throw new FileOperationError("INTERNAL", "复制写入未完成");
            written += count;
          }
          offset += size;
        }
        fchmodSync(destinationFd, initial.mode);
        const sourceSha256 = sourceHash.digest("hex");
        const hashFd = (fd: number) => {
          const hash = createHash("sha256");
          let at = 0;
          while (true) {
            const count = readSync(fd, buffer, 0, buffer.length, at);
            if (count <= 0) break;
            hash.update(buffer.subarray(0, count));
            at += count;
          }
          return hash.digest("hex");
        };
        const destinationBefore = fstatSync(destinationFd);
        const destinationSha256 = hashFd(destinationFd);
        if (sourceSha256 !== destinationSha256)
          throw new FileOperationError("INTERNAL", "复制回读校验失败");
        // Uncertain provenance does not undo a successful copy or invent a baseline.
        try {
          const sourceAfter = fstatSync(sourceFd),
            destinationAfter = fstatSync(destinationFd);
          if (
            hashFd(sourceFd) === sourceSha256 &&
            stable(initial, sourceAfter) &&
            stable(initial, lstatSync(source)) &&
            sameFile(created, destinationAfter) &&
            stable(destinationBefore, destinationAfter) &&
            stable(destinationAfter, lstatSync(destination)) &&
            stable(destinationAfter, fstatSync(destinationFd))
          )
            return { version: 1, sourceSha256, destinationSha256, destinationWasAbsent: true };
        } catch {
          // The caller reports unknown provenance without a success baseline.
        }
        return undefined;
      } finally {
        if (destinationFd !== undefined) closeSync(destinationFd);
        closeSync(sourceFd);
      }
    }),
  );
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Internal storage is never resolved through the agent's path API. Every ancestor is checked. */
export function internalPath(root: string, rel: string): string {
  const base = canonicalWorkspaceRoot(root);
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
  assertFiniteFileParent(abs);
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
    const current = withFileAccessSync(
      { kind: "file-metadata", path: abs, purpose: "publish" },
      () => existsSync(abs),
    )
      ? sha256(
          withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "publish-hash" }, () =>
            readFileSync(abs),
          ),
        )
      : null;
    if (current !== expected)
      throw new FileOperationError("VERSION_CONFLICT", "文件已被外部修改，未覆盖原文件");
    withFileAccessSync({ kind: "file-write", path: abs, purpose: "publish-parents" }, () =>
      mkdirSync(dirname(abs), { recursive: true }),
    );
    // Resolve once more after creating parents, so a preexisting symlink cannot bypass checks.
    if (resolveWorkspacePath(root, path).abs !== abs)
      throw new FileOperationError("OUT_OF_WORKSPACE", "文件路径发生变化");
    withFileAccessSync({ kind: "file-write", path: abs, purpose: "publish" }, () => {
      if (expected === null) {
        linkSync(tmp, abs);
        rmSync(tmp);
      } else renameSync(tmp, abs);
    });
    return sha256(
      withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "publish-verify" }, () =>
        readFileSync(abs),
      ),
    );
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
    return runWithBufferedAccessFacts(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        this.db.exec("COMMIT");
        return value;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    });
  }
  /** Stage original bytes before a multi-path write; deletion of this row commits with metadata. */
  beginFileBatch(
    workspaceId: string,
    root: string,
    changes: Array<{ path: string; after: string | null }>,
  ): string | null {
    if (!changes.length) return null;
    const id = newId("batch");
    const folder = internalPath(root, `file-batches/${id}`);
    const parents = new Set<string>();
    try {
      mkdirSync(folder, { recursive: true });
      const items = changes.map((change, index) => {
        const { abs, rel } = resolveWorkspacePath(root, change.path);
        const before = pathVersion(abs);
        const saved = `${index}`;
        if (before !== null) copyPath(abs, join(folder, saved), false, true);
        let parent = dirname(abs);
        while (
          !assertFiniteFileParent(abs) &&
          !withFileAccessSync(
            { kind: "file-metadata", path: parent, purpose: "batch-parents" },
            () => existsSync(parent),
          )
        ) {
          parents.add(relative(root, parent));
          parent = dirname(parent);
        }
        return { path: rel, before, after: change.after, saved };
      });
      this.db
        .prepare("INSERT INTO file_batches VALUES (?,?,?)")
        .run(id, workspaceId, JSON.stringify({ items, parents: [...parents] }));
      return id;
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
  }

  commitFileBatch(id: string | null): void {
    if (id) this.db.prepare("DELETE FROM file_batches WHERE id=?").run(id);
  }

  cleanupFileBatch(root: string, id: string | null): void {
    if (id)
      try {
        rmSync(internalPath(root, `file-batches/${id}`), { recursive: true, force: true });
      } catch {
        /* A committed batch is still committed if temporary cleanup fails. */
      }
  }

  recoverFileBatches(
    workspaceId: string,
    root: string,
    batchId?: string,
    preservePaths: ReadonlySet<string> = new Set(),
  ): void {
    if (preservePaths.size && !batchId) throw new Error("保留替换目标需要明确的当前批次");
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='file_batches'").get()) return;
    const restricted =
      currentToolAccess()?.binding()?.decision.kind !== undefined &&
      currentToolAccess()?.binding()?.decision.kind !== "unbounded";
    if (restricted && batchId === undefined) {
      if (
        this.db.prepare("SELECT 1 FROM file_batches WHERE workspace_id=? LIMIT 1").get(workspaceId)
      )
        throw new FileOperationError(
          "VERSION_CONFLICT",
          "存在待恢复的文件批次，当前目录受限操作不能触发工作区恢复",
        );
      return;
    }
    const rows =
      batchId === undefined
        ? this.db.prepare("SELECT * FROM file_batches WHERE workspace_id=?").all(workspaceId)
        : this.db
            .prepare("SELECT * FROM file_batches WHERE workspace_id=? AND id=?")
            .all(workspaceId, batchId);
    for (const row of rows) {
      const id = String(row.id);
      const folder = internalPath(root, `file-batches/${id}`);
      const manifest = JSON.parse(String(row.manifest)) as {
        items: Array<{ path: string; before: string | null; after: string | null; saved: string }>;
        parents: string[];
      };
      const recoverable = manifest.items.filter((item) => !preservePaths.has(item.path));
      for (const item of recoverable) resolveWorkspacePath(root, item.path);
      for (const parent of manifest.parents) resolveWorkspacePath(root, parent);
      // Inspect the complete set before restoring any path; never overwrite a later external edit.
      const items = recoverable.map((item) => {
        const abs = resolveWorkspacePath(root, item.path).abs;
        const current = pathVersion(abs);
        if (current !== item.before && current !== item.after)
          throw new FileOperationError(
            "VERSION_CONFLICT",
            `批次恢复发现外部修改，请核对：${item.path}`,
            true,
          );
        if (item.before !== null && versionOf(join(folder, item.saved), true) !== item.before)
          throw new FileOperationError("INTERNAL", `批次恢复原始副本不可用：${item.path}`, true);
        return { ...item, abs, current };
      });
      for (const item of items.reverse()) {
        if (item.current === item.before) continue;
        if (item.current !== null)
          withFileAccessSync(
            { kind: "file-write", path: item.abs, purpose: "batch-rollback" },
            () => rmSync(item.abs, { recursive: true, force: true }),
          );
        if (item.before !== null) {
          withFileAccessSync(
            { kind: "file-write", path: item.abs, purpose: "batch-rollback" },
            () => mkdirSync(dirname(item.abs), { recursive: true }),
          );
          copyPath(join(folder, item.saved), item.abs, true, false);
        }
      }
      for (const parent of manifest.parents.sort((a, b) => b.length - a.length)) {
        const abs = resolveWorkspacePath(root, parent).abs;
        if (
          withFileAccessSync(
            { kind: "file-metadata", path: abs, purpose: "batch-rollback" },
            () => existsSync(abs) && statSync(abs).isDirectory(),
          ) &&
          withFileAccessSync(
            { kind: "directory-enumeration", path: abs, purpose: "batch-rollback" },
            () => readdirSync(abs),
          ).length === 0
        )
          withFileAccessSync({ kind: "file-write", path: abs, purpose: "batch-rollback" }, () =>
            rmdirSync(abs),
          );
      }
      this.commitFileBatch(id);
      this.cleanupFileBatch(root, id);
    }
  }

  bind(scope: BackupScope): BoundBackupService {
    return {
      needsBackup: (path) => {
        const { abs, rel } = resolveWorkspacePath(scope.workspaceRoot, path);
        return (
          withFileAccessSync({ kind: "file-metadata", path: abs, purpose: "backup" }, () =>
            existsSync(abs),
          ) &&
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
        return withFileAccessSync({ kind: "file-metadata", path: abs, purpose: "backup" }, () =>
          existsSync(abs),
        )
          ? this.store(scope, rel, "backup")
          : undefined;
      },
      backup: (path) => this.store(scope, path, "backup"),
      markCreated: (path) => {
        const { abs, rel } = resolveWorkspacePath(scope.workspaceRoot, path);
        const record = (absPath: string, relPath: string) => {
          const hash = pathVersion(absPath) as string;
          const st = withFileAccessSync(
            { kind: "file-metadata", path: absPath, purpose: "created-hash" },
            () => statSync(absPath),
          );
          this.insert(scope, relPath, "", "created", hash, st.size);
          if (st.isDirectory())
            for (const name of withFileAccessSync(
              { kind: "directory-enumeration", path: absPath, purpose: "created-hash" },
              () => readdirSync(absPath),
            ))
              record(join(absPath, name), `${relPath}/${name}`);
        };
        record(abs, rel);
      },
      trash: (path) => this.store(scope, path, "trash"),
      list: (path, kind = "backup") => {
        if (
          currentToolAccess()?.binding()?.decision.kind !== undefined &&
          currentToolAccess()?.binding()?.decision.kind !== "unbounded"
        )
          resolveWorkspacePath(scope.workspaceRoot, path ?? ".");
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
    const st = withFileAccessSync({ kind: "file-metadata", path: abs, purpose: kind }, () =>
      statSync(abs),
    );
    const hash = pathVersion(abs) as string;
    const containerRel = `${kind === "trash" ? "trash" : "backups"}/${nowIso().replaceAll(":", "-")}_${newId("b")}`;
    const container = internalPath(scope.workspaceRoot, containerRel);
    const storageRel = `${containerRel}/${rel}`;
    const dest = internalPath(scope.workspaceRoot, storageRel);
    let insertedId: string | undefined;
    try {
      if (kind === "backup") {
        copyPath(abs, dest, false, true);
        if (versionOf(dest, true) !== hash)
          throw new FileOperationError("INTERNAL", "备份回读校验失败");
      }
      const info = this.insert(scope, rel, `.excelmanus/${storageRel}`, kind, hash, st.size);
      insertedId = info.id;
      if (kind === "trash") {
        if (pathVersion(abs) !== hash)
          throw new FileOperationError("VERSION_CONFLICT", "删除前文件发生变化");
        withFileAccessSync({ kind: "file-write", path: abs, purpose: "trash" }, () =>
          renameSync(abs, dest),
        );
      }
      return info;
    } catch (e) {
      if (insertedId) this.db.prepare("DELETE FROM backups WHERE id=?").run(insertedId);
      rmSync(container, { force: true, recursive: true });
      throw e;
    }
  }
  /** 备份面板与回收站（11 §4）：列出工作区内某类记录。 */
  listEntries(
    workspaceId: string,
    kind: "backup" | "trash",
  ): (BackupInfo & { kind: string; sessionId: string; agentId: string })[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM backups WHERE workspace_id=? AND kind=? ORDER BY created_at DESC, id DESC LIMIT 500",
      )
      .all(workspaceId, kind);
    return rows.map((r) => ({
      ...this.info(r),
      kind: String(r.kind),
      sessionId: String(r.session_id),
      agentId: String(r.agent_id),
    }));
  }

  private entry(workspaceId: string, id: string): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT * FROM backups WHERE workspace_id=? AND id=? AND kind IN ('backup','trash')")
      .get(workspaceId, id) as Record<string, unknown> | undefined;
  }

  private storedAbs(root: string, r: Record<string, unknown>): string {
    const stored = String(r.backup_path);
    if (!stored.startsWith(".excelmanus/backups/") && !stored.startsWith(".excelmanus/trash/"))
      throw new FileOperationError("OUT_OF_WORKSPACE", "备份存储路径不合法");
    return internalPath(root, stored.slice(".excelmanus/".length));
  }

  /** 下载用：返回备份内容（只支持文件）。 */
  readEntry(workspaceId: string, root: string, id: string): { name: string; bytes: Buffer } {
    const r = this.entry(workspaceId, id);
    if (!r) throw new FileOperationError("NOT_FOUND", "备份不存在");
    const abs = this.storedAbs(root, r);
    if (!existsSync(abs) || !statSync(abs).isFile())
      throw new FileOperationError("UNSUPPORTED_FEATURE", "只能下载单个文件的备份");
    return { name: String(r.original_path).split("/").pop() ?? "backup", bytes: readFileSync(abs) };
  }

  /** 备份/回收站条目对应的原相对路径（替换前由文档服务编排用）。 */
  entryPath(workspaceId: string, id: string): string | undefined {
    const r = this.entry(workspaceId, id);
    return r ? String(r.original_path) : undefined;
  }

  /** 把不在磁盘上的版本（如活文档中的应用版本）存入备份区（07 §5 外部修改二选一）。 */
  storeBytes(scope: BackupScope, path: string, bytes: Uint8Array): BackupInfo {
    const { rel } = resolveWorkspacePath(scope.workspaceRoot, path);
    const hash = sha256(bytes);
    const containerRel = `backups/${nowIso().replaceAll(":", "-")}_${newId("b")}`;
    const container = internalPath(scope.workspaceRoot, containerRel);
    const storageRel = `${containerRel}/${rel}`;
    try {
      const dest = internalPath(scope.workspaceRoot, storageRel);
      writeFileSync(dest, bytes, { flag: "wx", mode: 0o600 });
      if (sha256(readFileSync(dest)) !== hash)
        throw new FileOperationError("INTERNAL", "备份回读校验失败");
      return this.insert(scope, rel, `.excelmanus/${storageRel}`, "backup", hash, bytes.length);
    } catch (e) {
      rmSync(container, { force: true, recursive: true });
      throw e;
    }
  }

  /**
   * 替换回原文件（14 §5 场景 18）：备份 → 先为当前文件再做一次备份，再原子替换；
   * 回收站 → 原位置不存在时移回。scope 记录执行者（用户操作记为 user）。
   */
  restoreEntry(
    scope: BackupScope,
    id: string,
  ): { path: string; kind: string; backupOfCurrent?: BackupInfo } {
    const r = this.entry(scope.workspaceId, id);
    if (!r) throw new FileOperationError("NOT_FOUND", "备份不存在");
    const src = this.storedAbs(scope.workspaceRoot, r);
    if (!existsSync(src)) throw new FileOperationError("NOT_FOUND", "备份文件已丢失");
    if (pathVersion(src) !== String(r.sha256))
      throw new FileOperationError("VERSION_CONFLICT", "备份内容校验失败，未替换");
    const rel = String(r.original_path);
    const { abs } = resolveWorkspacePath(scope.workspaceRoot, rel);
    if (String(r.kind) === "trash") {
      if (existsSync(abs))
        throw new FileOperationError("VERSION_CONFLICT", `原位置已有同名文件：${rel}`);
      mkdirSync(dirname(abs), { recursive: true });
      renameSync(src, abs);
      this.db.prepare("DELETE FROM backups WHERE id=?").run(id);
      return { path: rel, kind: "trash" };
    }
    let backupOfCurrent: BackupInfo | undefined;
    const current = existsSync(abs) ? pathVersion(abs) : null;
    if (current !== null && current !== String(r.sha256))
      backupOfCurrent = this.store(scope, rel, "backup");
    if (statSync(src).isDirectory()) {
      const tmp = internalPath(scope.workspaceRoot, `tmp/${newId("tmp")}`);
      try {
        cpSync(src, tmp, { recursive: true, errorOnExist: true, force: false });
        if (existsSync(abs)) rmSync(abs, { recursive: true });
        mkdirSync(dirname(abs), { recursive: true });
        renameSync(tmp, abs);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } else {
      atomicWrite(scope.workspaceRoot, rel, readFileSync(src), current);
    }
    return { path: rel, kind: "backup", ...(backupOfCurrent ? { backupOfCurrent } : {}) };
  }

  /** 删除一条备份或永久删除回收站中的条目。 */
  removeEntry(workspaceId: string, root: string, id: string): boolean {
    const r = this.entry(workspaceId, id);
    if (!r) return false;
    const abs = this.storedAbs(root, r);
    rmSync(abs, { recursive: true, force: true });
    this.db.prepare("DELETE FROM backups WHERE id=?").run(id);
    return true;
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
