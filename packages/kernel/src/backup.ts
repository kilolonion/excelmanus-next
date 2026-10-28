import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
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
import {
  appendVerifiedContractIdentity,
  ContractIdentityRecoveryRecord,
  ContractPreparedIdentityRecord,
  clearRecordedContractIdentity,
  hasCommittedContractIdentityBatch,
  type PendingContractIdentityRecovery,
  type PendingContractIdentityWrite,
  pendingContractIdentityWrites,
  promotePreparedContractIdentity,
  stageContractIdentityRecovery,
  stagePreparedContractIdentity,
} from "./contract-identity-recovery.ts";
import { type PublishedCreatedDocument, publishExclusiveCreatedOutput } from "./created-output.ts";
import type { Migration } from "./db.ts";
import {
  assertEffectCompensationOwner,
  assertPlannedEffect,
  captureEffectPlanForCompensation,
  consumeEffectPublication,
  currentHostNativeAccess,
  currentHostNativeCheckpoint,
  type EffectPermit,
  type EffectPublication,
  type HostNativeAuthority,
  inspectEffectPlanForIdentityCommit,
  prepareEffectPlan,
  recheckEffectPlan,
  runWithEffectPlan,
  withEffectPublicationStorage,
} from "./effect-gate.ts";
import { isInternalName, listProtectedRoots, resolveWorkspacePath } from "./paths.ts";
import { lookupApprovedContractIdentity, lookupHostUserMutationAuthority, taskContractState } from "./task-contract.ts";
import {
  assertFiniteFileParent,
  canonicalWorkspaceRoot,
  currentToolAccess,
  readVerifiedResourceSync,
  runWithBufferedAccessFacts,
  statVerifiedResourceSync,
  withFileAccessSync,
} from "./tool-access.ts";

interface HostBackupEntryAccess {
  db: DatabaseSync;
  workspaceRoot: string;
  workspaceId: string;
  entryId: string;
  operation: "restore" | "remove";
}
interface ActiveBackupEntryAccess extends HostBackupEntryAccess {
  authority: HostNativeAuthority;
  active: boolean;
}
const backupEntryAccess = new AsyncLocalStorage<ActiveBackupEntryAccess>();
/** Called only by an authenticated native HTTP handler with its exact DB-selected artifact. */
export function runWithHostBackupEntryAccess<T>(input: HostBackupEntryAccess, action: () => T): T {
  const authority = currentHostNativeAccess();
  if (
    !authority ||
    currentToolAccess() ||
    currentHostNativeCheckpoint() ||
    !input.workspaceId ||
    !input.entryId ||
    !["restore", "remove"].includes(input.operation) ||
    authority.db !== input.db ||
    authority.workspaceId !== input.workspaceId ||
    canonicalWorkspaceRoot(authority.workspaceRoot) !== canonicalWorkspaceRoot(input.workspaceRoot)
  )
    throw new FileOperationError("APPROVAL_DENIED", "历史条目操作缺少当前已认证的原生请求");
  const parent = backupEntryAccess.getStore();
  if (
    parent &&
    (!parent.active ||
      parent.authority !== authority ||
      parent.db !== input.db ||
      parent.workspaceId !== input.workspaceId ||
      parent.entryId !== input.entryId ||
      parent.operation !== input.operation ||
      parent.workspaceRoot !== canonicalWorkspaceRoot(input.workspaceRoot))
  )
    throw new FileOperationError("APPROVAL_DENIED", "历史条目子操作不能扩大原请求范围");
  const state: ActiveBackupEntryAccess = {
    ...input,
    workspaceRoot: canonicalWorkspaceRoot(input.workspaceRoot),
    authority,
    active: true,
  };
  try {
    const result = backupEntryAccess.run(state, action);
    if (result && typeof (result as { then?: unknown }).then === "function")
      return Promise.resolve(result).finally(() => {
        state.active = false;
      }) as T;
    state.active = false;
    return result;
  } catch (error) {
    state.active = false;
    throw error;
  }
}
function assertHostBackupEntry(
  db: DatabaseSync,
  workspaceId: string,
  root: string,
  entryId: string,
  operation: "restore" | "remove",
): void {
  const state = backupEntryAccess.getStore(),
    authority = currentHostNativeAccess();
  if (
    !state?.active ||
    currentToolAccess() ||
    !authority ||
    currentHostNativeCheckpoint() ||
    state.authority !== authority ||
    state.db !== db ||
    state.workspaceId !== workspaceId ||
    state.workspaceRoot !== canonicalWorkspaceRoot(root) ||
    state.entryId !== entryId ||
    state.operation !== operation
  )
    throw new FileOperationError("APPROVAL_DENIED", "历史条目操作未绑定当前请求选择的精确资源");
  const workspace = db.prepare("SELECT path FROM workspaces WHERE id=?").get(workspaceId);
  if (!workspace || canonicalWorkspaceRoot(String(workspace.path)) !== state.workspaceRoot)
    throw new FileOperationError("OUT_OF_WORKSPACE", "历史条目工作区与已认证请求不一致");
}

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
      : currentToolAccess()?.binding().contractRef
        ? statVerifiedResourceSync(currentToolAccess()!.workspaceRoot, abs, { purpose: "hash" })
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
        : currentToolAccess()?.binding().contractRef
          ? readVerifiedResourceSync(currentToolAccess()!.workspaceRoot, abs, { purpose: "hash" })
              .bytes
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
  if (
    !currentToolAccess() ||
    (currentToolAccess()?.binding().decision.kind === "unbounded" &&
      !currentToolAccess()?.binding().contractRef)
  ) {
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    return;
  }
  const st = sourceStorage
    ? lstatSync(source)
    : currentToolAccess()?.binding().contractRef
      ? statVerifiedResourceSync(currentToolAccess()!.workspaceRoot, source, { purpose: "copy" })
      : withFileAccessSync({ kind: "file-metadata", path: source, purpose: "copy" }, () =>
          lstatSync(source),
        );
  if (st.isSymbolicLink())
    throw new FileOperationError("OUT_OF_WORKSPACE", "批量文件操作不跟随符号链接");
  const write = <T>(action: () => T): T =>
    destinationStorage
      ? action()
      : withFileAccessSync(
          { kind: "file-write", effect: "create", path: destination, purpose: "copy" },
          action,
        );
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
    else if (currentToolAccess()?.binding().contractRef) {
      const bytes = readVerifiedResourceSync(currentToolAccess()!.workspaceRoot, source, {
        purpose: "copy",
      }).bytes;
      write(() => writeFileSync(destination, bytes, { flag: "wx", mode: st.mode }));
    } else withFileAccessSync({ kind: "file-bytes", path: source, purpose: "copy" }, copy);
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
    (currentToolAccess()?.binding().contractRef
      ? statVerifiedResourceSync(root, from, { purpose: "copy" }).isFile()
      : withFileAccessSync({ kind: "file-metadata", path: source, purpose: "copy" }, () =>
          lstatSync(source).isFile(),
        ));
  if (!regular) {
    registerUndo?.(() =>
      withFileAccessSync({ kind: "file-write", path: destination, purpose: "rollback" }, () =>
        rmSync(destination, { recursive: true, force: true }),
      ),
    );
    copyPath(source, destination);
    return;
  }
  if (currentToolAccess()?.binding().contractRef) {
    const bytes = readVerifiedResourceSync(root, from, { purpose: "copy" }).bytes;
    const sourceSha256 = sha256(bytes);
    return withFileAccessSync(
      { kind: "file-write", effect: "create", path: destination, purpose: "copy" },
      () => {
        const fd = openSync(destination, "wx+", 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
          const created = fstatSync(fd, { bigint: true }),
            atPath = lstatSync(destination, { bigint: true });
          const copied = Buffer.alloc(bytes.length);
          let offset = 0;
          while (offset < copied.length) {
            const n = readSync(fd, copied, offset, copied.length - offset, offset);
            if (!n) throw new FileOperationError("INTERNAL", "复制目标回读不完整");
            offset += n;
          }
          if (
            created.dev !== atPath.dev ||
            created.ino !== atPath.ino ||
            created.nlink !== 1n ||
            sha256(copied) !== sourceSha256
          )
            throw new FileOperationError("VERSION_CONFLICT", "复制目标身份或字节变化", true);
          return {
            version: 1 as const,
            sourceSha256,
            destinationSha256: sourceSha256,
            destinationWasAbsent: true as const,
          };
        } finally {
          closeSync(fd);
        }
      },
    );
  }
  return withFileAccessSync({ kind: "file-bytes", path: source, purpose: "copy" }, () =>
    withFileAccessSync(
      { kind: "file-write", effect: "create", path: destination, purpose: "copy" },
      () => {
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
      },
    ),
  );
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Internal storage is never resolved through the agent's path API. Every ancestor is checked. */
export function internalPath(root: string, rel: string): string {
  const path = checkedInternalPath(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
function checkedInternalPath(root: string, rel: string): string {
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
  return p;
}

/** Validate temporary bytes, recheck the destination version, then publish on the same filesystem. */
export function atomicWrite(
  root: string,
  path: string,
  bytes: Uint8Array,
  expected: string | null,
  validate: (bytes: Uint8Array) => void = () => {},
  publication?: { token: EffectPublication; resourceId: string; revision: number },
): string {
  return atomicWriteImpl(root, path, bytes, expected, validate, publication);
}

/** Fixed create-only entry; the publisher chooses document identity from actual IO. */
export function atomicCreateDocument(
  owner: object,
  root: string,
  path: string,
  bytes: Uint8Array,
  validate: (bytes: Uint8Array) => void = () => {},
): PublishedCreatedDocument & { sha256: string } {
  let published: PublishedCreatedDocument | undefined;
  const hash = atomicWriteImpl(root, path, bytes, null, validate, undefined, {
    owner,
    receive: (value) => {
      published = value;
    },
  });
  if (!published) throw new FileOperationError("INTERNAL", "创建发布未返回宿主文档身份", true);
  return { ...published, sha256: hash };
}

function atomicWriteImpl(
  root: string,
  path: string,
  bytes: Uint8Array,
  expected: string | null,
  validate: (bytes: Uint8Array) => void = () => {},
  publication?: { token: EffectPublication; resourceId: string; revision: number },
  document?: { owner: object; receive(value: PublishedCreatedDocument | undefined): void },
): string {
  const effect = expected === null ? ("create" as const) : ("mutate" as const);
  const publish = (permit: EffectPermit) =>
    runWithEffectPlan(permit, () => {
      const storage = <T>(step: "parents" | "publish", action: () => T): T =>
        publication
          ? withEffectPublicationStorage(
              publication.token,
              {
                root,
                path,
                bytes,
                expected,
                resourceId: publication.resourceId,
                revision: publication.revision,
              },
              step,
              action,
            )
          : action();
      const { abs } = resolveWorkspacePath(root, path);
      assertFiniteFileParent(abs, effect, permit);
      if (expected !== null && currentToolAccess()) {
        const result = publishApprovedAtomicMutation(
          root,
          path,
          bytes,
          expected,
          validate,
          permit,
          storage,
        );
        if (result !== undefined) return result;
      }
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
        const current =
          expected === null
            ? null
            : withFileAccessSync({ kind: "file-metadata", path: abs, purpose: "publish" }, () =>
                  existsSync(abs),
                )
              ? sha256(
                  withFileAccessSync(
                    { kind: "file-bytes", path: abs, purpose: "publish-hash" },
                    () => readFileSync(abs),
                  ),
                )
              : null;
        if (current !== expected)
          throw new FileOperationError("VERSION_CONFLICT", "文件已被外部修改，未覆盖原文件");
        recheckEffectPlan(permit);
        storage("parents", () =>
          withFileAccessSync(
            { kind: "file-write", effect, path: abs, purpose: "publish-parents" },
            () => mkdirSync(dirname(abs), { recursive: true }),
          ),
        );
        // Resolve once more after creating parents, so a preexisting symlink cannot bypass checks.
        if (resolveWorkspacePath(root, path).abs !== abs)
          throw new FileOperationError("OUT_OF_WORKSPACE", "文件路径发生变化");
        recheckEffectPlan(permit);
        storage("publish", () =>
          withFileAccessSync({ kind: "file-write", effect, path: abs, purpose: "publish" }, () => {
            if (expected === null) {
              const created = publishExclusiveCreatedOutput({
                permit,
                root,
                path,
                temporaryPath: tmp,
                sha256: sha256(back),
                ...(document ? { documentOwner: document.owner } : {}),
              });
              document?.receive(created);
            } else renameSync(tmp, abs);
          }),
        );
        // Exclusive hard-link publication uses the already verified host-owned inode.
        // It does not turn create authority into a read grant on the published resource.
        if (expected === null) return sha256(back);
        return sha256(
          withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "publish-verify" }, () =>
            readFileSync(abs),
          ),
        );
      } finally {
        rmSync(tmp, { force: true });
      }
    });
  if (publication)
    return consumeEffectPublication(
      publication.token,
      {
        root,
        path,
        bytes,
        expected,
        resourceId: publication.resourceId,
        revision: publication.revision,
      },
      publish,
    );
  return publish(
    prepareEffectPlan({
      workspaceRoot: root,
      atomicScope: "single-resource",
      effects: [
        { operation: effect, path },
        ...(expected === null
          ? []
          : [
              { operation: "read-metadata" as const, path },
              { operation: "read-content" as const, path },
            ]),
      ],
    }),
  );
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
  markCreated(path: string, created?: { sha256: string; size: number }): void;
  trash(path: string): BackupInfo;
  list(path?: string, kind?: "backup" | "trash"): BackupInfo[];
}

export type FileBatchOperation =
  | { op: "mkdir" | "delete"; path: string }
  | { op: "copy" | "move"; path: string; to: string };
export interface FileBatchCompensation {
  readonly fileBatchCompensation: unique symbol;
}
export interface FileBatchIdentityPreparation {
  readonly fileBatchIdentityPreparation: unique symbol;
}
interface FileBatchIdentityState {
  service: BackupService;
  permit: EffectPermit;
  scope: BackupScope;
  operations: readonly FileBatchOperation[];
  base: Omit<ContractIdentityRecoveryRecord, "resources" | "recovery">;
  before: Map<string, CompensationImage | undefined>;
  attached: boolean;
}
const fileBatchIdentityPreparations = new WeakMap<object, FileBatchIdentityState>();
interface CompensationImage {
  kind: "file" | "directory";
  device: string;
  inode: string;
  links: string;
  size: string;
  mtime: string;
  ctime: string;
  sha256: string;
  children?: Record<string, CompensationImage>;
}
interface CompensationStep {
  op: FileBatchOperation;
  before?: CompensationImage;
  after?: CompensationImage;
  stored?: string;
  complete: boolean;
}
interface CompensationState {
  service: BackupService;
  scope: BackupScope;
  permit: EffectPermit;
  journalId: string;
  steps: CompensationStep[];
  next: number;
  phase: "open" | "failed" | "committed" | "uncertain" | "consumed" | "closed";
  parents: Map<string, { device: string; inode: string }>;
  identity?: FileBatchIdentityState;
  pendingIdentity?: PendingContractIdentityRecovery;
}
const compensations = new WeakMap<object, CompensationState>();

export interface AtomicIdentityTransition {
  readonly atomicIdentityTransition: unique symbol;
}
interface PreparedAtomicTransition {
  db: DatabaseSync;
  root: string;
  permit: EffectPermit;
  record: ContractPreparedIdentityRecord;
  committed?: ContractIdentityRecoveryRecord;
  phase: "prepare" | "published";
  active: boolean;
}
const atomicIdentityTransitions = new WeakMap<object, PreparedAtomicTransition>();
const atomicIdentityContinuation = new AsyncLocalStorage<PreparedAtomicTransition>();
/** Only atomicWrite's fixed publisher owns these states; a metadata row cannot mint one. */
export function assertPreparedAtomicIdentityTransition(
  token: AtomicIdentityTransition,
  db: DatabaseSync,
  record: ContractPreparedIdentityRecord,
  phase: "prepare" | "published",
  committed?: ContractIdentityRecoveryRecord,
): void {
  const state = atomicIdentityTransitions.get(token);
  if (
    !state?.active ||
    state.db !== db ||
    db.isTransaction ||
    state.phase !== phase ||
    JSON.stringify(state.record) !== JSON.stringify(record) ||
    (phase === "published" &&
      (!committed ||
        !state.committed ||
        JSON.stringify(state.committed) !== JSON.stringify(committed)))
  )
    throw new FileOperationError(
      "VERSION_CONFLICT",
      "单文件身份记录缺少本次固定发布的宿主证明",
      true,
    );
  assertCurrentAtomicIdentityAuthorization(state);
  const resource = record.resource;
  const validate = (expected: typeof resource.before, internal: boolean) => {
    if (internal && !expected.path.startsWith(`.excelmanus/tmp/${record.operationId}/`))
      throw new FileOperationError("OUT_OF_WORKSPACE", "身份暂存不是本操作内部资源");
    const absolute = internal
      ? checkedInternalPath(state.root, expected.path.slice(".excelmanus/".length))
      : compensationPath(state.root, expected.path);
    const image = compensationImage(absolute);
    if (
      !expected.exists
        ? image !== undefined
        : !image ||
          image.kind !== "file" ||
          image.links !== "1" ||
          image.device !== expected.device ||
          image.inode !== expected.inode ||
          image.size !== expected.size ||
          image.sha256 !== expected.sha256 ||
          image.mtime !== expected.mtime ||
          image.ctime !== expected.ctime
    )
      throw new FileOperationError(
        "VERSION_CONFLICT",
        "单文件发布身份或字节发生变化，材料保留",
        true,
      );
  };
  if (resource.backup) validate(resource.backup, true);
  if (phase === "prepare") {
    validate(resource.before, false);
    validate(resource.temp, true);
  } else {
    const after = committed!.resources.find((item) => item.path === resource.path)?.after;
    if (
      !after?.exists ||
      !resource.temp.exists ||
      after.device !== resource.temp.device ||
      after.inode !== resource.temp.inode ||
      after.sha256 !== resource.temp.sha256 ||
      after.size !== resource.temp.size
    )
      throw new FileOperationError("VERSION_CONFLICT", "发布后像不是本操作的真实临时文件");
    validate(after, false);
    if (
      existsSync(checkedInternalPath(state.root, resource.temp.path.slice(".excelmanus/".length)))
    )
      throw new FileOperationError("VERSION_CONFLICT", "临时文件尚未完成一次性发布", true);
  }
}

function assertCurrentAtomicIdentityAuthorization(state: PreparedAtomicTransition): void {
  inspectEffectPlanForIdentityCommit(state.permit);
  const access = currentToolAccess(),
    ref = access?.binding().contractRef;
  const contract = access ? taskContractState({ ...access, contractExpected: true }) : undefined;
  if (
    !access ||
    access.db !== state.db ||
    !ref ||
    !contract ||
    contract.revision !== state.record.contractRevision ||
    ref.contractId !== state.record.contractId ||
    ref.originTaskId !== state.record.originTaskId ||
    ref.originAgentId !== state.record.originAgentId ||
    ref.originTurnId !== state.record.originTurnId
  )
    throw new FileOperationError("VERSION_CONFLICT", "单文件发布契约修订或任务归属已经变化", true);
  if (state.record.hostMutation) {
    const effect = state.record.effects.find(item => item.operation === "mutate");
    const host = effect ? lookupHostUserMutationAuthority(access, effect) : undefined;
    if (!host || JSON.stringify(host.provenance) !== JSON.stringify(state.record.hostMutation))
      throw new FileOperationError("VERSION_CONFLICT", "用户原文或上传绑定已变化", true);
  }
}
/** Recheck only the actual active publisher after SQLite acquired its promotion lock. */
export function recheckPublishedAtomicIdentityAuthorization(
  token: AtomicIdentityTransition,
  db: DatabaseSync,
  prepared: ContractPreparedIdentityRecord,
  committed: ContractIdentityRecoveryRecord,
): void {
  const state = atomicIdentityTransitions.get(token);
  if (
    !db.isTransaction ||
    !state?.active ||
    state.db !== db ||
    state.phase !== "published" ||
    JSON.stringify(state.record) !== JSON.stringify(prepared) ||
    !state.committed ||
    JSON.stringify(state.committed) !== JSON.stringify(committed)
  )
    throw new FileOperationError("VERSION_CONFLICT", "事务内身份检查缺少本次发布的宿主证明", true);
  assertCurrentAtomicIdentityAuthorization(state);
}

/** The creation descriptor, not a later path lookup, anchors temporary bytes. */
function readAtomicStagedFile(
  root: string,
  rel: string,
  created: BigIntStats,
  expected: string,
): Buffer {
  const abs = checkedInternalPath(root, rel.slice(".excelmanus/".length));
  const same = (stat: BigIntStats) =>
    stat.isFile() &&
    stat.nlink === 1n &&
    stat.dev === created.dev &&
    stat.ino === created.ino &&
    stat.size === created.size &&
    stat.mtimeNs === created.mtimeNs &&
    stat.ctimeNs === created.ctimeNs;
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(fstatSync(fd, { bigint: true })))
      throw new FileOperationError("VERSION_CONFLICT", "临时文件已被替换，未向校验器披露内容");
    const bytes = readFileSync(fd);
    if (
      !same(fstatSync(fd, { bigint: true })) ||
      !same(lstatSync(abs, { bigint: true })) ||
      checkedInternalPath(root, rel.slice(".excelmanus/".length)) !== abs ||
      sha256(bytes) !== expected
    )
      throw new FileOperationError("VERSION_CONFLICT", "临时文件读取期间变化，未向校验器披露内容");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Fixed synchronous publisher for an approved replacement. Prepared metadata is never authority. */
function publishApprovedAtomicMutation(
  root: string,
  path: string,
  input: Uint8Array,
  expected: string,
  validate: (bytes: Uint8Array) => void,
  permit: EffectPermit,
  storage: <T>(step: "parents" | "publish", action: () => T) => T,
): string | undefined {
  const access = currentToolAccess()!;
  const contract = taskContractState({
    ...access,
    contractExpected: !!access.binding().contractRef,
  });
  if (!contract) return;
  if (access.db.isTransaction)
    throw new FileOperationError("UNSUPPORTED_FEATURE", "单文件身份发布不能加入其他业务事务");
  const ref = access.binding().contractRef;
  if (!ref) throw new FileOperationError("APPROVAL_DENIED", "单文件身份发布缺少持久任务引用");
  const plan = inspectEffectPlanForIdentityCommit(permit);
  const rel = resolveWorkspacePath(root, path).rel;
  const writes = plan.effects.filter((item) =>
    ["create", "mutate", "remove", "relocate"].includes(item.operation),
  );
  if (
    writes.length !== 1 ||
    writes[0]!.operation !== "mutate" ||
    writes[0]!.path !== rel ||
    writes[0]!.to
  )
    throw new FileOperationError("UNSUPPORTED_FEATURE", "单文件发布不能隐含完成其他资源的写入");
  const approved = lookupApprovedContractIdentity(access, writes[0]!);
  const host = approved ? undefined : lookupHostUserMutationAuthority(access, writes[0]!);
  if (!approved?.identity.exists && !host)
    throw new FileOperationError("APPROVAL_DENIED", "needs_confirmation：替换文件缺少精确批准或用户原文绑定身份");
  const approvedIdentity = approved?.identity;
  const workspace = access.db
    .prepare(
      "SELECT w.id,w.path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?",
    )
    .get(access.sessionId) as { id: string; path: string } | undefined;
  if (!workspace || canonicalWorkspaceRoot(workspace.path) !== canonicalWorkspaceRoot(root))
    throw new FileOperationError("OUT_OF_WORKSPACE", "单文件发布工作区与任务不一致");
  const abs = compensationPath(root, rel);
  // Complete read authority and the approved physical anchor are checked before creating staging storage.
  const original = readVerifiedResourceSync(root, rel, {
    purpose: "approved-replacement-preimage",
  }).bytes;
  const before = compensationImage(abs);
  if (
    !before ||
    before.kind !== "file" ||
    before.links !== "1" ||
    before.sha256 !== expected ||
    before.sha256 !== sha256(original) ||
    (approvedIdentity && ["device", "inode", "size", "mtime", "ctime"].some(
      (field) =>
        before[field as keyof CompensationImage] !==
        approvedIdentity[field as keyof typeof approvedIdentity],
    )) ||
    (host && (before.device !== host.identity.device || before.inode !== host.identity.inode ||
      before.size !== String(host.identity.size) || before.sha256 !== host.identity.sha256))
  )
    throw new FileOperationError("VERSION_CONFLICT", "批准后前像身份或内容已变化，未创建临时文件");
  const bytes = Buffer.from(input),
    hash = sha256(bytes),
    operationId = newId("effect");
  const tmpRel = `.excelmanus/tmp/${operationId}/replacement`;
  const backupRel = `.excelmanus/tmp/${operationId}/original`;
  const physical = (resourcePath: string, image: CompensationImage) => {
    if (image.kind !== "file" || image.links !== "1")
      throw new FileOperationError("UNSUPPORTED_FEATURE", "单文件身份发布仅支持独立普通文件");
    return {
      path: resourcePath,
      exists: true as const,
      device: image.device,
      inode: image.inode,
      nlink: "1" as const,
      size: image.size,
      sha256: image.sha256,
      mtime: image.mtime,
      ctime: image.ctime,
    };
  };
  let transition: PreparedAtomicTransition | undefined;
  let staging = false,
    attempted = false,
    recorded = false;
  // Once staging starts, a failure retains the exact files for diagnosis. No automatic undo or recursive cleanup.
  try {
    recheckEffectPlan(permit);
    const tmp = internalPath(root, tmpRel.slice(".excelmanus/".length));
    const backup = checkedInternalPath(root, backupRel.slice(".excelmanus/".length));
    staging = true;
    const created = new Map<string, BigIntStats>();
    for (const [file, content] of [
      [tmp, bytes],
      [backup, original],
    ] as const) {
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, content);
        fsyncSync(fd);
        created.set(file, fstatSync(fd, { bigint: true }));
      } finally {
        closeSync(fd);
      }
    }
    const back = readAtomicStagedFile(root, tmpRel, created.get(tmp)!, hash);
    readAtomicStagedFile(root, backupRel, created.get(backup)!, before.sha256);
    validate(back);
    if (sha256(back) !== hash) throw new FileOperationError("INTERNAL", "临时文件回读校验失败");
    const tempImage = compensationImage(tmp),
      backupImage = compensationImage(backup);
    if (
      !tempImage ||
      !backupImage ||
      tempImage.sha256 !== hash ||
      backupImage.sha256 !== before.sha256
    )
      throw new FileOperationError("VERSION_CONFLICT", "发布材料不匹配，原文件未覆盖");
    const record = ContractPreparedIdentityRecord.parse({
      version: 1,
      state: "prepared",
      sessionId: access.sessionId,
      workspaceId: workspace.id,
      ...ref,
      operationId,
      contractRevision: contract.revision,
      authorizationQuestionIds: approved ? [approved.questionId] : [],
      ...(host ? {hostMutation:host.provenance} : {}),
      effects: plan.effects.map((item) => ({ ...item })),
      resource: {
        path: rel,
        before: physical(rel, before),
        temp: physical(tmpRel, tempImage),
        backup: physical(backupRel, backupImage),
      },
    });
    const token = Object.freeze({}) as AtomicIdentityTransition;
    const currentTransition: PreparedAtomicTransition = {
      db: access.db,
      root,
      permit,
      record,
      phase: "prepare",
      active: true,
    };
    transition = currentTransition;
    atomicIdentityTransitions.set(token, currentTransition);
    return atomicIdentityContinuation.run(currentTransition, () => {
      const pending = stagePreparedContractIdentity(access.db, record, token);
      // Same exact preimage, current authority, and derived artifacts are checked again immediately before rename.
      assertPreparedAtomicIdentityTransition(token, access.db, record, "prepare");
      recheckEffectPlan(permit);
      storage("publish", () =>
        withFileAccessSync(
          {
            kind: "file-write",
            effect: "mutate",
            path: abs,
            purpose: "approved-replacement-publish",
          },
          () => {
            assertPreparedAtomicIdentityTransition(token, access.db, record, "prepare");
            attempted = true;
            renameSync(tmp, abs);
          },
        ),
      );
      const after = compensationImage(compensationPath(root, rel));
      if (
        !after ||
        after.device !== tempImage.device ||
        after.inode !== tempImage.inode ||
        after.sha256 !== hash
      )
        throw new FileOperationError("VERSION_CONFLICT", "发布后像不匹配，保留恢复材料", true);
      const { resource, state: unusedState, ...fields } = record;
      const committed = ContractIdentityRecoveryRecord.parse({
        ...fields,
        state: "committed-awaiting-identity",
        resources: [{ path: rel, before: resource.before, after: physical(rel, after) }],
        atomicRecovery: {
          preparedDigest: pending.digest,
          temp: resource.temp,
          backup: resource.backup,
        },
      });
      currentTransition.phase = "published";
      currentTransition.committed = committed;
      const promoted = promotePreparedContractIdentity(access.db, pending, committed, token);
      appendVerifiedContractIdentity(access.db, access.log, promoted, token);
      recorded = true;
      clearRecordedContractIdentity(access.db, promoted);
      // Only a successful persisted proof makes the captured preimage redundant.
      if (!sameCompensationImage(backupImage, compensationImage(backup)))
        throw new FileOperationError("VERSION_CONFLICT", "成功后备份身份变化，保留材料", true);
      rmSync(backup);
      rmdirSync(dirname(backup));
      return hash;
    });
  } catch (error) {
    if (!staging) throw error;
    throw new FileOperationError(
      error instanceof FileOperationError ? error.code : "INTERNAL",
      `${recorded ? "文件和身份回执已提交，但恢复材料清理失败" : attempted ? "文件发布结果待核验，未授予后继身份" : "发布暂存未完成，原文件未覆盖"}：${error instanceof Error ? error.message : String(error)}`,
      attempted || recorded,
    );
  } finally {
    if (transition) transition.active = false;
  }
}

export interface FileBatchIdentityTransition {
  readonly fileBatchIdentityTransition: unique symbol;
}
interface CommittedIdentityTransition {
  db: DatabaseSync;
  state: CompensationState;
  pending: PendingContractIdentityRecovery;
  active: boolean;
}
const identityTransitions = new WeakMap<object, CommittedIdentityTransition>();
const batchIdentityContinuation = new AsyncLocalStorage<CommittedIdentityTransition>();
/** A pure gate query, never a registration or callback API. Only the fixed synchronous producers set these stores. */
export function isCurrentIdentityPublicationContinuation(
  permit: EffectPermit,
  db: DatabaseSync,
  pending: PendingContractIdentityWrite,
  businessWrite: boolean,
): boolean {
  const atomic = atomicIdentityContinuation.getStore();
  if (atomic?.active && atomic.db === db && atomic.permit === permit) {
    if (
      pending.state === "prepared" &&
      JSON.stringify(pending.record) === JSON.stringify(atomic.record)
    )
      return atomic.phase === "prepare" || (!businessWrite && atomic.phase === "published");
    if (
      !businessWrite &&
      atomic.phase === "published" &&
      atomic.committed &&
      JSON.stringify(pending.record) === JSON.stringify(atomic.committed)
    )
      return true;
  }
  const batch = batchIdentityContinuation.getStore();
  return (
    !businessWrite &&
    !!batch?.active &&
    batch.db === db &&
    batch.state.permit === permit &&
    batch.state.phase === "committed" &&
    pending.digest === batch.pending.digest &&
    JSON.stringify(pending.record) === JSON.stringify(batch.pending.record)
  );
}
/** A persisted pending record is not proof. Only the fixed post-COMMIT publisher can issue this token. */
export function assertCommittedFileBatchIdentityTransition(
  token: FileBatchIdentityTransition,
  db: DatabaseSync,
  pending: PendingContractIdentityRecovery,
): void {
  const transition = identityTransitions.get(token);
  if (
    !transition ||
    !transition.active ||
    transition.db !== db ||
    db.isTransaction ||
    transition.state.phase !== "committed" ||
    transition.pending.digest !== pending.digest ||
    JSON.stringify(transition.pending.record) !== JSON.stringify(pending.record)
  )
    throw new FileOperationError("VERSION_CONFLICT", "身份后继缺少本次真实提交的宿主证明", true);
  assertEffectCompensationOwner(transition.state.permit);
  inspectEffectPlanForIdentityCommit(transition.state.permit);
  for (const resource of pending.record.resources) {
    const image = compensationImage(
      compensationPath(transition.state.scope.workspaceRoot, resource.path),
    );
    const after = resource.after;
    if (
      !after.exists
        ? image !== undefined
        : !image ||
          image.kind !== "file" ||
          image.device !== after.device ||
          image.inode !== after.inode ||
          image.links !== after.nlink ||
          image.size !== after.size ||
          image.sha256 !== after.sha256 ||
          image.mtime !== after.mtime ||
          image.ctime !== after.ctime
    )
      throw new FileOperationError(
        "VERSION_CONFLICT",
        "已提交资源在后继登记前被替换，保留恢复记录",
        true,
      );
  }
}

/** Fixed, non-disclosed identity inspection for a previously authorized inverse. */
function compensationPath(root: string, rel: string): string {
  const abs = join(root, rel),
    parts = relative(root, abs).split(sep);
  if (!rel || parts.some((part) => !part || part === ".." || isInternalName(part)))
    throw new FileOperationError("OUT_OF_WORKSPACE", "补偿路径不属于原操作");
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink() || listProtectedRoots().includes(current))
        throw new FileOperationError("VERSION_CONFLICT", "补偿路径链已被替换", true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return abs;
}
function compensationImage(abs: string): CompensationImage | undefined {
  let stat: BigIntStats;
  try {
    stat = lstatSync(abs, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new FileOperationError("VERSION_CONFLICT", "补偿对象不是原有普通资源", true);
  const identity = {
    device: String(stat.dev),
    inode: String(stat.ino),
    links: String(stat.nlink),
    size: String(stat.size),
    mtime: String(stat.mtimeNs),
    ctime: String(stat.ctimeNs),
  };
  if (stat.isFile()) {
    const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const first = fstatSync(fd, { bigint: true }),
        bytes = readFileSync(fd),
        last = fstatSync(fd, { bigint: true });
      const path = lstatSync(abs, { bigint: true });
      if (
        [first, last, path].some(
          (item) =>
            item.dev !== stat.dev ||
            item.ino !== stat.ino ||
            item.size !== stat.size ||
            item.mtimeNs !== stat.mtimeNs ||
            item.ctimeNs !== stat.ctimeNs ||
            item.nlink !== stat.nlink,
        )
      )
        throw new FileOperationError("VERSION_CONFLICT", "补偿对象读取期间变化", true);
      return { kind: "file", ...identity, sha256: sha256(bytes) };
    } finally {
      closeSync(fd);
    }
  }
  const children: Record<string, CompensationImage> = {};
  for (const name of readdirSync(abs).sort()) {
    if (isInternalName(name) || listProtectedRoots().includes(join(abs, name)))
      throw new FileOperationError("OUT_OF_WORKSPACE", "补偿不访问内部或受保护资源");
    const image = compensationImage(join(abs, name));
    if (!image) throw new FileOperationError("VERSION_CONFLICT", "补偿子树读取期间变化", true);
    children[name] = image;
  }
  const last = lstatSync(abs, { bigint: true });
  if (
    last.dev !== stat.dev ||
    last.ino !== stat.ino ||
    last.mtimeNs !== stat.mtimeNs ||
    last.ctimeNs !== stat.ctimeNs
  )
    throw new FileOperationError("VERSION_CONFLICT", "补偿目录读取期间变化", true);
  return {
    kind: "directory",
    ...identity,
    children,
    sha256: sha256(
      Buffer.from(
        JSON.stringify(Object.entries(children).map(([name, child]) => [name, child.sha256])),
      ),
    ),
  };
}
function pathVersionForImage(image: CompensationImage): string {
  if (image.kind === "file") return image.sha256;
  const hash = createHash("sha256");
  for (const [name, child] of Object.entries(image.children ?? {}))
    hash.update(JSON.stringify([name, pathVersionForImage(child)]));
  return hash.digest("hex");
}
const sameCompensationImage = (
  a: CompensationImage | undefined,
  b: CompensationImage | undefined,
) => JSON.stringify(a) === JSON.stringify(b);
const sameRestoredContent = (
  a: CompensationImage | undefined,
  b: CompensationImage | undefined,
): boolean =>
  !!a &&
  !!b &&
  a.kind === b.kind &&
  a.device === b.device &&
  a.inode === b.inode &&
  a.links === b.links &&
  a.sha256 === b.sha256 &&
  (a.kind !== "directory" ||
    (Object.keys(a.children ?? {}).length === Object.keys(b.children ?? {}).length &&
      Object.entries(a.children ?? {}).every(([name, child]) =>
        sameRestoredContent(child, b.children?.[name]),
      )));

export class BackupService {
  private readonly db: DatabaseSync;
  private readonly maintainedWorkspaces = new Set<string>();
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  atomicBatch<T>(fn: () => T, token?: FileBatchCompensation): T {
    const state = token ? this.compensationState(token) : undefined;
    if (fn.constructor.name === "AsyncFunction") {
      if (state) state.phase = "failed";
      throw new FileOperationError(
        "INVALID_ARGUMENT",
        "文件事务仅支持同步函数，不能接收 async/Promise",
      );
    }
    return runWithBufferedAccessFacts(() => {
      this.db.exec("BEGIN IMMEDIATE");
      let committing = false;
      try {
        const value = fn();
        if (value && typeof (value as { then?: unknown }).then === "function")
          throw new FileOperationError(
            "INVALID_ARGUMENT",
            "文件事务不能提交 Promise/thenable，必须同步完成",
          );
        committing = true;
        this.db.exec("COMMIT");
        if (state) state.phase = "committed";
        return value;
      } catch (e) {
        if (state) state.phase = committing || state.phase === "uncertain" ? "uncertain" : "failed";
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw e;
      }
    });
  }

  private compensationState(token: FileBatchCompensation, rollback = false): CompensationState {
    const state = compensations.get(token);
    if (
      !state ||
      state.service !== this ||
      (state.phase !== "open" && !(rollback && state.phase === "failed"))
    )
      throw new FileOperationError("VERSION_CONFLICT", "本批补偿许可不存在、已消费或已提交", true);
    assertEffectCompensationOwner(state.permit);
    return state;
  }

  /** Before any staging side effect: capture approved, regular-file-only physical transitions. */
  prepareFileBatchIdentity(
    scope: BackupScope,
    operations: readonly FileBatchOperation[],
  ): FileBatchIdentityPreparation | undefined {
    const access = currentToolAccess();
    if (!access) return undefined;
    const contract = taskContractState({
      ...access,
      contractExpected: !!access.binding().contractRef,
    });
    if (!contract) return undefined;
    const permit = captureEffectPlanForCompensation(scope.workspaceRoot);
    const plan = inspectEffectPlanForIdentityCommit(permit);
    const writes = plan.effects.filter((effect) =>
      ["create", "mutate", "remove", "relocate"].includes(effect.operation),
    );
    const approved = writes.map((effect) => ({
      effect,
      receipt: lookupApprovedContractIdentity(access, effect),
    }));
    if (approved.some((item) => !item.receipt && item.effect.operation !== "create"))
      throw new FileOperationError(
        "APPROVAL_DENIED",
        "needs_confirmation：本次文件转移缺少精确批准身份",
      );
    const questions = [
      ...new Set(approved.flatMap((item) => (item.receipt ? [item.receipt.questionId] : []))),
    ];
    if (!questions.length) return undefined;
    const ref = access.binding().contractRef;
    if (!ref) throw new FileOperationError("APPROVAL_DENIED", "文件身份后继缺少持久任务引用");
    if (
      operations.some((op) => op.op === "mkdir") ||
      plan.effects.some((effect) => effect.sheetId || effect.range || effect.objectId)
    )
      throw new FileOperationError(
        "UNSUPPORTED_FEATURE",
        "批准身份后继仅支持可证明的普通文件转移，不支持目录或区域重写",
      );
    const normalized = operations.map(
      (op) =>
        Object.freeze({
          ...op,
          path: resolveWorkspacePath(scope.workspaceRoot, op.path).rel,
          ...("to" in op ? { to: resolveWorkspacePath(scope.workspaceRoot, op.to).rel } : {}),
        }) as FileBatchOperation,
    );
    const touched = new Set<string>();
    for (const op of normalized) {
      const paths = op.op === "copy" ? [op.to] : "to" in op ? [op.path, op.to] : [op.path];
      for (const path of paths) {
        if (
          [...touched].some(
            (other) =>
              other === path || other.startsWith(path + "/") || path.startsWith(other + "/"),
          )
        )
          throw new FileOperationError(
            "UNSUPPORTED_FEATURE",
            "重叠文件转移无法证明后继身份，未执行",
          );
        touched.add(path);
      }
    }
    const before = new Map<string, CompensationImage | undefined>();
    for (const path of touched) {
      const image = compensationImage(compensationPath(scope.workspaceRoot, path));
      if (image && (image.kind !== "file" || image.links !== "1"))
        throw new FileOperationError(
          "UNSUPPORTED_FEATURE",
          "批准身份后继不支持目录、链接或特殊资源",
        );
      before.set(path, image);
    }
    for (const { effect, receipt } of approved) {
      const image = before.get(effect.path);
      if (
        !before.has(effect.path) ||
        (receipt &&
          (receipt.identity.exists !== !!image ||
            (receipt.identity.exists &&
              image &&
              (receipt.identity.device !== image.device ||
                receipt.identity.inode !== image.inode ||
                receipt.identity.size !== image.size ||
                receipt.identity.mtime !== image.mtime ||
                receipt.identity.ctime !== image.ctime))))
      )
        throw new FileOperationError("VERSION_CONFLICT", "批准后资源身份已变化，需要重新确认");
    }
    const token = Object.freeze({}) as FileBatchIdentityPreparation;
    fileBatchIdentityPreparations.set(token, {
      service: this,
      permit,
      scope: Object.freeze({ ...scope }),
      operations: Object.freeze(normalized),
      before,
      attached: false,
      base: {
        version: 1,
        state: "committed-awaiting-identity",
        sessionId: access.sessionId,
        workspaceId: scope.workspaceId,
        ...ref,
        operationId: newId("effect"),
        contractRevision: contract.revision,
        authorizationQuestionIds: questions,
        effects: plan.effects.map((effect) => ({ ...effect })),
      },
    });
    return token;
  }

  /** Before forward I/O: freeze canonical operations against the current full effect plan. */
  prepareFileBatchCompensation(
    id: string,
    scope: BackupScope,
    operations: readonly FileBatchOperation[],
    identityPreparation?: FileBatchIdentityPreparation,
  ): FileBatchCompensation {
    const permit = captureEffectPlanForCompensation(scope.workspaceRoot);
    const row = this.db
      .prepare("SELECT manifest FROM file_batches WHERE id=? AND workspace_id=?")
      .get(id, scope.workspaceId);
    if (!row) throw new FileOperationError("INVALID_ARGUMENT", "文件批次缺少已保存前像");
    const manifest = JSON.parse(String(row.manifest)) as {
      items: Array<{ path: string; before: string | null; after: string | null; saved: string }>;
    };
    const steps: CompensationStep[] = operations.map((input) => {
      const path = resolveWorkspacePath(scope.workspaceRoot, input.path).rel;
      const to =
        "to" in input ? resolveWorkspacePath(scope.workspaceRoot, input.to).rel : undefined;
      const op = Object.freeze({
        ...input,
        path,
        ...(to !== undefined ? { to } : {}),
      }) as FileBatchOperation;
      if (op.op === "mkdir")
        assertPlannedEffect({ operation: "create", path }, scope.workspaceRoot);
      else {
        assertPlannedEffect({ operation: "read-content", path }, scope.workspaceRoot);
        if (op.op === "delete" || op.op === "move")
          assertPlannedEffect({ operation: "remove", path }, scope.workspaceRoot);
        if ("to" in op)
          assertPlannedEffect({ operation: "create", path: op.to }, scope.workspaceRoot);
        if (op.op === "move")
          assertPlannedEffect({ operation: "relocate", path, to: op.to }, scope.workspaceRoot);
      }
      const source = manifest.items.find((item) => item.path === path);
      const destination =
        to === undefined ? undefined : manifest.items.find((item) => item.path === to);
      if (
        op.op === "mkdir"
          ? !source || source.before !== null
          : op.op === "delete"
            ? !source || source.before === null || source.after !== null
            : !destination ||
              destination.before !== null ||
              (op.op === "move" && (!source || source.before === null || source.after !== null))
      )
        throw new FileOperationError("INVALID_ARGUMENT", "补偿动作与冻结批次前像不一致");
      // The original business read guard covers all source bytes, including directory members.
      if (op.op !== "mkdir") pathVersion(compensationPath(scope.workspaceRoot, path));
      const before = compensationImage(compensationPath(scope.workspaceRoot, path));
      if (op.op === "mkdir" ? before !== undefined : before === undefined)
        throw new FileOperationError("VERSION_CONFLICT", "补偿登记前资源已变化");
      if (
        before &&
        ((source?.before !== undefined &&
          source.before !== null &&
          pathVersionForImage(before) !== source.before) ||
          (destination?.after !== undefined &&
            destination.after !== null &&
            pathVersionForImage(before) !== destination.after))
      )
        throw new FileOperationError("VERSION_CONFLICT", "补偿登记前像与已冻结副本不匹配");
      if (to && compensationImage(compensationPath(scope.workspaceRoot, to)))
        throw new FileOperationError("VERSION_CONFLICT", "补偿登记目标已存在");
      return { op, before, complete: false };
    });
    for (const item of manifest.items) {
      if (!steps.some(({ op }) => op.path === item.path || ("to" in op && op.to === item.path)))
        throw new FileOperationError("INVALID_ARGUMENT", "补偿遗漏完整批次资源");
      if (
        item.before !== null &&
        versionOf(internalPath(scope.workspaceRoot, `file-batches/${id}/${item.saved}`), true) !==
          item.before
      )
        throw new FileOperationError("VERSION_CONFLICT", "批次已保存前像不完整", true);
    }
    recheckEffectPlan(permit);
    const identity = identityPreparation
      ? fileBatchIdentityPreparations.get(identityPreparation)
      : undefined;
    if (
      identityPreparation &&
      (!identity ||
        identity.attached ||
        identity.service !== this ||
        identity.permit !== permit ||
        JSON.stringify(identity.operations) !== JSON.stringify(steps.map((step) => step.op)) ||
        identity.scope.workspaceId !== scope.workspaceId ||
        identity.scope.workspaceRoot !== scope.workspaceRoot)
    )
      throw new FileOperationError("VERSION_CONFLICT", "文件身份预检不能跨操作复用");
    if (identity) {
      for (const [path, before] of identity.before)
        if (
          !sameCompensationImage(
            before,
            compensationImage(compensationPath(scope.workspaceRoot, path)),
          )
        )
          throw new FileOperationError("VERSION_CONFLICT", "身份预检后的前像已变化");
      identity.attached = true;
    }
    const token = Object.freeze({}) as FileBatchCompensation;
    compensations.set(token, {
      service: this,
      scope: Object.freeze({ ...scope }),
      permit,
      journalId: id,
      steps,
      next: 0,
      phase: "open",
      parents: new Map(),
      identity,
    });
    return token;
  }

  /** Fixed forward operations collect their own real postidentity; callers supply only an index. */
  executeFileBatchStep(
    token: FileBatchCompensation,
    index: number,
  ): {
    backup?: BackupInfo;
    trash?: BackupInfo;
    size?: number;
    hash?: string;
    copyBaseline?: {
      version: 1;
      sourceSha256: string;
      destinationSha256: string;
      destinationWasAbsent: true;
    };
  } {
    const state = this.compensationState(token);
    if (!Number.isSafeInteger(index) || index !== state.next || !state.steps[index])
      throw new FileOperationError("INVALID_ARGUMENT", "文件批次不能跳步、重复或越界");
    const step = state.steps[index]!,
      { op } = step,
      root = state.scope.workspaceRoot;
    recheckEffectPlan(state.permit);
    const from = compensationPath(root, op.path),
      to = "to" in op ? compensationPath(root, op.to) : undefined;
    if (
      !sameCompensationImage(step.before, compensationImage(from)) ||
      (to && compensationImage(to))
    )
      throw new FileOperationError("VERSION_CONFLICT", "文件批次执行前资源已被替换");
    const parents = (target: string) => {
      const missing: string[] = [];
      if (!assertFiniteFileParent(target, "create")) {
        let parent = dirname(target);
        while (!existsSync(parent)) {
          missing.push(parent);
          parent = dirname(parent);
        }
      }
      if (missing.length) {
        withFileAccessSync(
          { kind: "file-write", effect: "create", path: target, purpose: "batch-parents" },
          () => mkdirSync(dirname(target), { recursive: true }),
        );
        for (const parent of missing) {
          const stat = lstatSync(parent, { bigint: true });
          state.parents.set(relative(root, parent), {
            device: String(stat.dev),
            inode: String(stat.ino),
          });
        }
      }
    };
    let backup: BackupInfo | undefined, trash: BackupInfo | undefined;
    let copyBaseline:
      | { version: 1; sourceSha256: string; destinationSha256: string; destinationWasAbsent: true }
      | undefined;
    try {
      if (op.op === "mkdir") {
        parents(from);
        withFileAccessSync(
          { kind: "file-write", effect: "create", path: from, purpose: "mkdir" },
          () => mkdirSync(from),
        );
        step.after = compensationImage(from);
      } else if (op.op === "delete") {
        trash = this.bind(state.scope).trash(op.path);
        step.stored = internalPath(root, trash.backupPath.slice(".excelmanus/".length));
        step.after = compensationImage(step.stored);
        if (!sameRestoredContent(step.before, step.after) || compensationImage(from))
          throw new FileOperationError("VERSION_CONFLICT", "回收后资源身份不匹配", true);
      } else {
        if (!("to" in op)) throw new FileOperationError("INVALID_ARGUMENT", "文件操作缺少冻结目标");
        if (op.op === "move") backup = this.bind(state.scope).ensureBackup(op.path);
        parents(to!);
        if (op.op === "copy") copyBaseline = copyWorkspacePath(root, op.path, op.to, () => {});
        else
          withFileAccessSync(
            { kind: "file-write", effect: "remove", path: from, purpose: "move" },
            () =>
              withFileAccessSync(
                { kind: "file-write", effect: "create", path: to!, purpose: "move" },
                () => renameSync(from, to!),
              ),
          );
        step.after = compensationImage(to!);
        if (
          !step.after ||
          pathVersionForImage(step.after) !== pathVersionForImage(step.before!) ||
          (op.op === "move" &&
            (!sameRestoredContent(step.before, step.after) || compensationImage(from)))
        )
          throw new FileOperationError("VERSION_CONFLICT", "发布后资源身份不匹配", true);
        step.complete = true;
        state.next++;
        this.bind(state.scope).markCreated(op.to, {
          sha256: pathVersionForImage(step.after),
          size: Number(step.before!.size),
        });
      }
      if (!step.complete) {
        step.complete = true;
        state.next++;
      }
      return {
        backup,
        trash,
        copyBaseline,
        size: step.before ? Number(step.before.size) : 0,
        hash: step.before ? pathVersionForImage(step.before) : undefined,
      };
    } catch (error) {
      // If the failed forward step changed resources without a complete proof, never invent an inverse.
      if (
        !step.complete &&
        (!sameCompensationImage(step.before, compensationImage(from)) ||
          (to && compensationImage(to)))
      )
        state.phase = "uncertain";
      throw error;
    }
  }

  /** Same existing business transaction as file metadata. Nothing here is yet a success receipt. */
  stageFileBatchIdentity(token: FileBatchCompensation): boolean {
    const state = this.compensationState(token),
      identity = state.identity;
    if (!identity) return false;
    if (
      !this.db.isTransaction ||
      state.next !== state.steps.length ||
      state.steps.some((step) => !step.complete)
    )
      throw new FileOperationError("VERSION_CONFLICT", "身份待登记记录必须属于完整同步业务事务");
    inspectEffectPlanForIdentityCommit(state.permit);
    const resources = [...identity.before].map(([path, before]) => {
      const step = state.steps.find(
        (step) => step.op.path === path || ("to" in step.op && step.op.to === path),
      )!;
      const after =
        step.op.op === "delete" || (step.op.op === "move" && step.op.path === path)
          ? undefined
          : step.after;
      if (
        !sameCompensationImage(
          after,
          compensationImage(compensationPath(state.scope.workspaceRoot, path)),
        )
      )
        throw new FileOperationError(
          "VERSION_CONFLICT",
          "提交前实际后像与固定操作结果不一致",
          true,
        );
      if ([before, after].some((image) => image && (image.kind !== "file" || image.links !== "1")))
        throw new FileOperationError("VERSION_CONFLICT", "身份提交前出现非普通文件或硬链接", true);
      const encode = (image: CompensationImage | undefined) =>
        image
          ? {
              path,
              exists: true as const,
              device: image.device,
              inode: image.inode,
              nlink: "1" as const,
              size: image.size,
              sha256: image.sha256,
              mtime: image.mtime,
              ctime: image.ctime,
            }
          : { path, exists: false as const };
      return { path, before: encode(before), after: encode(after) };
    });
    const row = this.db
      .prepare("SELECT manifest FROM file_batches WHERE id=?")
      .get(state.journalId);
    if (!row) throw new FileOperationError("VERSION_CONFLICT", "身份登记前批次恢复清单丢失");
    state.pendingIdentity = stageContractIdentityRecovery(this.db, {
      ...identity.base,
      resources,
      recovery: { fileBatchId: state.journalId, manifest: JSON.parse(String(row.manifest)) },
    });
    return true;
  }

  /** Only this fixed, synchronous post-COMMIT path can mint a transition; no callbacks or caller bytes. */
  finalizeFileBatchIdentity(token: FileBatchCompensation): void {
    const state = compensations.get(token),
      access = currentToolAccess();
    if (
      !state ||
      state.service !== this ||
      state.phase !== "committed" ||
      !state.pendingIdentity ||
      this.db.isTransaction ||
      !access ||
      access.db !== this.db
    )
      throw new FileOperationError("VERSION_CONFLICT", "缺少真实已提交文件身份转移", true);
    const pending = structuredClone(state.pendingIdentity);
    const transition = Object.freeze({}) as FileBatchIdentityTransition;
    const proof: CommittedIdentityTransition = { db: this.db, state, pending, active: true };
    identityTransitions.set(transition, proof);
    let recorded = false;
    try {
      batchIdentityContinuation.run(proof, () => {
        assertCommittedFileBatchIdentityTransition(transition, this.db, pending);
        appendVerifiedContractIdentity(this.db, access.log, pending, transition);
        recorded = true;
        clearRecordedContractIdentity(this.db, pending);
        this.commitFileBatch(state.journalId);
        this.cleanupFileBatch(state.scope.workspaceRoot, state.journalId);
      });
    } catch (error) {
      throw new FileOperationError(
        "INTERNAL",
        recorded
          ? `文件已提交且身份后继已登记，但清理未完成；恢复材料保留：${error instanceof Error ? error.message : String(error)}`
          : `文件已提交但身份后继未登记；恢复材料保留，后续读取需重新核验：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      proof.active = false;
    }
  }

  /** No callback, new bytes, new destinations or postcommit undo can enter this boundary. */
  rollbackFileBatchCompensation(token: FileBatchCompensation): void {
    const state = this.compensationState(token, true),
      root = state.scope.workspaceRoot;
    state.phase = "consumed";
    const complete = state.steps.filter((step) => step.complete);
    const current = (path: string) => compensationImage(compensationPath(root, path));
    const verify = (step: CompensationStep) => {
      const { op } = step;
      if (op.op === "copy") {
        if (
          !sameCompensationImage(current(op.path), step.before) ||
          !sameCompensationImage(current(op.to), step.after)
        )
          throw new FileOperationError("VERSION_CONFLICT", `复制补偿发现外部变化：${op.to}`, true);
      } else if (op.op === "move") {
        if (current(op.path) || !sameCompensationImage(current(op.to), step.after))
          throw new FileOperationError(
            "VERSION_CONFLICT",
            `移动补偿发现外部变化：${op.path}`,
            true,
          );
      } else if (op.op === "delete") {
        if (
          current(op.path) ||
          !step.stored ||
          !sameCompensationImage(compensationImage(step.stored), step.after)
        )
          throw new FileOperationError(
            "VERSION_CONFLICT",
            `删除补偿发现外部变化：${op.path}`,
            true,
          );
      } else if (!sameCompensationImage(current(op.path), step.after))
        throw new FileOperationError("VERSION_CONFLICT", `目录补偿发现外部变化：${op.path}`, true);
    };
    for (const step of complete) verify(step);
    const expectedRoots = complete.flatMap(({ op }) =>
      op.op === "mkdir" ? [op.path] : "to" in op ? [op.to] : [],
    );
    const verifyParents = (rel: string): void => {
      const abs = compensationPath(root, rel),
        stat = lstatSync(abs, { bigint: true }),
        expected = state.parents.get(rel)!;
      if (
        !stat.isDirectory() ||
        String(stat.dev) !== expected.device ||
        String(stat.ino) !== expected.inode
      )
        throw new FileOperationError("VERSION_CONFLICT", `补偿父目录已被替换：${rel}`, true);
      const inspect = (folder: string) => {
        for (const name of readdirSync(compensationPath(root, folder))) {
          const child = `${folder}/${name}`;
          if (
            !expectedRoots.some(
              (path) =>
                path === child || path.startsWith(child + "/") || child.startsWith(path + "/"),
            )
          )
            throw new FileOperationError(
              "VERSION_CONFLICT",
              `补偿父目录出现外部资源：${child}`,
              true,
            );
          const st = lstatSync(compensationPath(root, child));
          if (st.isDirectory()) inspect(child);
        }
      };
      inspect(rel);
    };
    for (const rel of state.parents.keys()) verifyParents(rel);
    for (const step of complete.slice().reverse()) {
      assertEffectCompensationOwner(state.permit);
      verify(step);
      const { op } = step,
        from = compensationPath(root, op.path);
      if (op.op === "mkdir") rmdirSync(from);
      else if (op.op === "copy") rmSync(compensationPath(root, op.to), { recursive: true });
      else {
        renameSync(op.op === "move" ? compensationPath(root, op.to) : step.stored!, from);
        if (!sameRestoredContent(step.before, compensationImage(from)))
          throw new FileOperationError(
            "VERSION_CONFLICT",
            `原件补偿后的身份或字节不匹配：${op.path}`,
            true,
          );
      }
    }
    for (const [rel, expected] of [...state.parents].sort((a, b) => b[0].length - a[0].length)) {
      const abs = compensationPath(root, rel),
        stat = lstatSync(abs, { bigint: true });
      if (
        String(stat.dev) !== expected.device ||
        String(stat.ino) !== expected.inode ||
        readdirSync(abs).length
      )
        throw new FileOperationError(
          "VERSION_CONFLICT",
          `补偿父目录不再是本次空目录：${rel}`,
          true,
        );
      rmdirSync(abs);
    }
    this.commitFileBatch(state.journalId);
    this.cleanupFileBatch(root, state.journalId);
  }

  closeFileBatchCompensation(token: FileBatchCompensation): void {
    const state = compensations.get(token);
    if (state?.service === this) state.phase = "closed";
  }
  /** Stage original bytes before a multi-path write; deletion of this row commits with metadata. */
  beginFileBatch(
    workspaceId: string,
    root: string,
    changes: Array<{ path: string; after: string | null; before?: string | null }>,
  ): string | null {
    if (!changes.length) return null;
    const rootReal = canonicalWorkspaceRoot(root);
    const id = newId("batch");
    const folder = internalPath(root, `file-batches/${id}`);
    const parents = new Set<string>();
    try {
      mkdirSync(folder, { recursive: true });
      const items = changes.map((change, index) => {
        const { abs, rel } = resolveWorkspacePath(root, change.path);
        const before = change.before !== undefined ? change.before : pathVersion(abs);
        const saved = `${index}`;
        if (before !== null) copyPath(abs, join(folder, saved), false, true);
        let parent = dirname(abs);
        while (
          before === null &&
          !assertFiniteFileParent(abs, "create") &&
          parent !== rootReal &&
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

  private assertStartupWorkspace(workspaceId: string, root: string): void {
    if (currentToolAccess() || currentHostNativeAccess())
      throw new FileOperationError("APPROVAL_DENIED", "启动维护不能由任务或原生文件请求代调用");
    const workspace = this.db.prepare("SELECT path FROM workspaces WHERE id=?").get(workspaceId);
    if (
      !workspace ||
      canonicalWorkspaceRoot(String(workspace.path)) !== canonicalWorkspaceRoot(root)
    )
      throw new FileOperationError("OUT_OF_WORKSPACE", "启动维护的数据库工作区与根目录不一致");
  }

  /** Legacy manifests describe bytes, not authoritative resource identity. Validate, never replay. */
  private assertLegacyManifest(row: Record<string, unknown>): void {
    const value: unknown = JSON.parse(String(row.manifest));
    const object = (x: unknown): x is Record<string, unknown> =>
      !!x && typeof x === "object" && !Array.isArray(x);
    const path = (x: unknown) =>
      typeof x === "string" &&
      x.length > 0 &&
      !x.includes("\\") &&
      !x.includes("\0") &&
      !x.includes(":") &&
      x
        .split("/")
        .every((part) => !!part && part !== "." && part !== ".." && !isInternalName(part));
    const hash = (x: unknown) => x === null || (typeof x === "string" && /^[a-f0-9]{64}$/.test(x));
    if (
      !object(value) ||
      Object.keys(value).sort().join(",") !== "items,parents" ||
      !Array.isArray(value.items) ||
      !Array.isArray(value.parents) ||
      !value.parents.every(path) ||
      !value.items.every(
        (item) =>
          object(item) &&
          Object.keys(item).sort().join(",") === "after,before,path,saved" &&
          path(item.path) &&
          hash(item.before) &&
          hash(item.after) &&
          typeof item.saved === "string" &&
          /^\d+$/.test(item.saved),
      ) ||
      new Set(value.items.map((item) => (item as Record<string, unknown>).path)).size !==
        value.items.length
    )
      throw new FileOperationError("INTERNAL", "旧文件批次恢复清单损坏，保留全部恢复材料", true);
  }

  /** Fixed startup diagnostic boundary: neither committed nor identity-insufficient batches are undo candidates. */
  recoverFileBatchesOnStartup(
    workspaceId: string,
    root: string,
  ): {
    deferredIdentityCount: number;
    deferredLegacyCount: number;
    pendingIdentityResourceCount: number;
    recoveredBatchCount: number;
  } {
    this.assertStartupWorkspace(workspaceId, root);
    const pending = pendingContractIdentityWrites(this.db, workspaceId);
    const result = {
      deferredIdentityCount: 0,
      deferredLegacyCount: 0,
      pendingIdentityResourceCount: new Set(pending.flatMap((item) => item.paths)).size,
      recoveredBatchCount: 0,
    };
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='file_batches'").get())
      return result;
    for (const row of this.db
      .prepare("SELECT * FROM file_batches WHERE workspace_id=? ORDER BY id")
      .all(workspaceId)) {
      if (hasCommittedContractIdentityBatch(this.db, String(row.id)))
        result.deferredIdentityCount++;
      else {
        this.assertLegacyManifest(row);
        result.deferredLegacyCount++;
      }
    }
    return result;
  }

  recoverFileBatches(
    workspaceId: string,
    _root: string,
    batchId?: string,
    preservePaths: ReadonlySet<string> = new Set(),
  ): void {
    if (preservePaths.size && !batchId) throw new Error("保留替换目标需要明确的当前批次");
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='file_batches'").get()) return;
    const rows =
      batchId === undefined
        ? this.db.prepare("SELECT * FROM file_batches WHERE workspace_id=?").all(workspaceId)
        : this.db
            .prepare("SELECT * FROM file_batches WHERE workspace_id=? AND id=?")
            .all(workspaceId, batchId);
    for (const row of rows) {
      if (hasCommittedContractIdentityBatch(this.db, String(row.id)))
        throw new FileOperationError(
          "VERSION_CONFLICT",
          "该文件批次已提交，身份待核对或清理；禁止自动回滚，恢复材料保留",
          true,
        );
      this.assertLegacyManifest(row);
    }
    if (rows.length)
      throw new FileOperationError(
        "UNSUPPORTED_FEATURE",
        "旧批次缺少可信来源及物理身份，禁止仅凭相同哈希自动恢复；清单和副本保留待核对",
        true,
      );
  }

  bind(scope: BackupScope): BoundBackupService {
    return {
      needsBackup: (path) => {
        const { abs, rel } = resolveWorkspacePath(scope.workspaceRoot, path);
        let present = false;
        try {
          if (currentToolAccess()?.binding().contractRef) {
            statVerifiedResourceSync(scope.workspaceRoot, rel, { purpose: "backup" });
            present = true;
          } else
            present = withFileAccessSync(
              { kind: "file-metadata", path: abs, purpose: "backup" },
              () => existsSync(abs),
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return (
          present &&
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
        let present = false;
        try {
          if (currentToolAccess()?.binding().contractRef) {
            statVerifiedResourceSync(scope.workspaceRoot, rel, { purpose: "backup" });
            present = true;
          } else
            present = withFileAccessSync(
              { kind: "file-metadata", path: abs, purpose: "backup" },
              () => existsSync(abs),
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return present ? this.store(scope, rel, "backup") : undefined;
      },
      backup: (path) => this.store(scope, path, "backup"),
      markCreated: (path, created) => {
        const { abs, rel } = resolveWorkspacePath(scope.workspaceRoot, path);
        if (created) {
          this.insert(scope, rel, "", "created", created.sha256, created.size);
          return;
        }
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
    const st = currentToolAccess()?.binding().contractRef
      ? statVerifiedResourceSync(scope.workspaceRoot, rel, { purpose: kind })
      : withFileAccessSync({ kind: "file-metadata", path: abs, purpose: kind }, () =>
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
        withFileAccessSync(
          { kind: "file-write", effect: "remove", path: abs, purpose: "trash" },
          () => renameSync(abs, dest),
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
    return checkedInternalPath(root, stored.slice(".excelmanus/".length));
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
  storeBytes(
    scope: BackupScope,
    path: string,
    bytes: Uint8Array,
    document?: { docId: string; revision: number },
  ): BackupInfo {
    const authority = currentHostNativeAccess();
    if (
      !authority ||
      currentToolAccess() ||
      currentHostNativeCheckpoint() ||
      authority.db !== this.db ||
      authority.workspaceId !== scope.workspaceId ||
      canonicalWorkspaceRoot(authority.workspaceRoot) !==
        canonicalWorkspaceRoot(scope.workspaceRoot) ||
      !document ||
      !Number.isSafeInteger(document.revision)
    )
      throw new FileOperationError("APPROVAL_DENIED", "应用版本备份缺少当前原生请求及实际文档归属");
    const row = this.db
      .prepare("SELECT workspace_id,path,head_rev FROM documents WHERE id=?")
      .get(document.docId);
    if (
      !row ||
      row.workspace_id !== scope.workspaceId ||
      row.path !== path ||
      row.head_rev !== document.revision
    )
      throw new FileOperationError("APPROVAL_DENIED", "应用版本备份的文档、路径或版本不匹配");
    const { rel } = resolveWorkspacePath(scope.workspaceRoot, path);
    if (rel !== path)
      throw new FileOperationError("OUT_OF_WORKSPACE", "应用版本备份必须使用实际规范文档路径");
    const hash = sha256(bytes),
      storageRel = `backups/${newId("artifact")}/content`;
    const dest = internalPath(scope.workspaceRoot, storageRel);
    const fd = openSync(
      dest,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let created: BigIntStats;
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      created = fstatSync(fd, { bigint: true });
    } finally {
      closeSync(fd);
    }
    // Unknown/failed artifacts stay retained; never recursively remove a potentially unique copy.
    readAtomicStagedFile(scope.workspaceRoot, `.excelmanus/${storageRel}`, created, hash);
    if (currentHostNativeAccess() !== authority)
      throw new FileOperationError("APPROVAL_DENIED", "应用版本备份请求已失效");
    const current = this.db
      .prepare("SELECT workspace_id,path,head_rev FROM documents WHERE id=?")
      .get(document.docId);
    if (
      !current ||
      current.workspace_id !== scope.workspaceId ||
      current.path !== path ||
      current.head_rev !== document.revision
    )
      throw new FileOperationError(
        "VERSION_CONFLICT",
        "应用版本备份期间文档已变化，副本保留",
        true,
      );
    return this.insert(scope, rel, `.excelmanus/${storageRel}`, "backup", hash, bytes.length);
  }

  /**
   * 替换回原文件（14 §5 场景 18）：备份 → 先为当前文件再做一次备份，再原子替换；
   * 回收站 → 原位置不存在时移回。scope 记录执行者（用户操作记为 user）。
   */
  restoreEntry(
    scope: BackupScope,
    id: string,
  ): { path: string; kind: string; backupOfCurrent?: BackupInfo } {
    assertHostBackupEntry(this.db, scope.workspaceId, scope.workspaceRoot, id, "restore");
    const r = this.entry(scope.workspaceId, id);
    if (!r) throw new FileOperationError("NOT_FOUND", "备份不存在");
    const src = this.storedAbs(scope.workspaceRoot, r);
    if (!existsSync(src)) throw new FileOperationError("NOT_FOUND", "备份文件已丢失");
    const sourceStat = lstatSync(src, { bigint: true });
    if (!sourceStat.isFile() || sourceStat.nlink !== 1n)
      throw new FileOperationError(
        "UNSUPPORTED_FEATURE",
        "目录恢复缺少完整子树效果计划，当前仅支持单个普通文件",
      );
    const rel = String(r.original_path);
    const { abs } = resolveWorkspacePath(scope.workspaceRoot, rel);
    const present = existsSync(abs);
    if (present && !lstatSync(abs).isFile())
      throw new FileOperationError("UNSUPPORTED_FEATURE", "不支持用单个文件恢复替换目录");
    if (String(r.kind) === "trash" && present)
      throw new FileOperationError("VERSION_CONFLICT", `原位置已有同名文件：${rel}`);
    const permit = prepareEffectPlan({
      workspaceRoot: scope.workspaceRoot,
      atomicScope: "single-resource",
      effects: [
        { operation: present ? "mutate" : "create", path: rel },
        ...(present
          ? [
              { operation: "read-content" as const, path: rel },
              { operation: "read-metadata" as const, path: rel },
            ]
          : []),
      ],
    });
    return runWithEffectPlan(permit, () => {
      const fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const first = fstatSync(fd, { bigint: true });
        bytes = readFileSync(fd);
        const last = fstatSync(fd, { bigint: true }),
          atPath = lstatSync(src, { bigint: true });
        if (
          [first, last, atPath].some(
            (st) =>
              st.dev !== sourceStat.dev ||
              st.ino !== sourceStat.ino ||
              st.size !== sourceStat.size ||
              st.mtimeNs !== sourceStat.mtimeNs ||
              st.ctimeNs !== sourceStat.ctimeNs ||
              st.nlink !== 1n,
          ) ||
          sha256(bytes) !== String(r.sha256)
        )
          throw new FileOperationError("VERSION_CONFLICT", "备份身份或内容校验失败，未替换");
      } finally {
        closeSync(fd);
      }
      const current = present ? pathVersion(abs) : null;
      let backupOfCurrent: BackupInfo | undefined;
      if (current !== null && current !== String(r.sha256))
        backupOfCurrent = this.store(scope, rel, "backup");
      recheckEffectPlan(permit);
      atomicWrite(scope.workspaceRoot, rel, bytes, current);
      if (String(r.kind) === "trash") {
        try {
          this.db.prepare("DELETE FROM backups WHERE id=?").run(id);
          rmSync(src);
        } catch (error) {
          throw new FileOperationError(
            "INTERNAL",
            `文件已恢复，回收站记录清理未完成：${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      }
      return { path: rel, kind: String(r.kind), ...(backupOfCurrent ? { backupOfCurrent } : {}) };
    });
  }

  /** 删除一条备份或永久删除回收站中的条目。 */
  removeEntry(workspaceId: string, root: string, id: string): boolean {
    assertHostBackupEntry(this.db, workspaceId, root, id, "remove");
    const r = this.entry(workspaceId, id);
    if (!r) return false;
    const abs = this.storedAbs(root, r);
    assertHostBackupEntry(this.db, workspaceId, root, id, "remove");
    rmSync(abs, { recursive: true, force: true });
    this.db.prepare("DELETE FROM backups WHERE id=?").run(id);
    return true;
  }

  pruneBackups(_workspaceId: string, _root: string): void {
    throw new FileOperationError(
      "APPROVAL_DENIED",
      "通用调用不能清理历史备份；仅固定启动维护可处理已验证冗余副本",
    );
  }

  /** Fixed DB-selected artifact inspection. Does not grant tools access to historical content. */
  private maintenanceArtifact(
    root: string,
    row: Record<string, unknown>,
  ): { abs: string; image: CompensationImage } | undefined {
    const stored = String(row.backup_path);
    if (!stored.startsWith(".excelmanus/backups/") || row.kind !== "backup") return;
    try {
      const abs = checkedInternalPath(root, stored.slice(".excelmanus/".length));
      const st = lstatSync(abs, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n) return;
      const image = compensationImage(abs);
      if (
        !image ||
        image.kind !== "file" ||
        image.links !== "1" ||
        image.sha256 !== row.sha256 ||
        image.size !== String(row.size)
      )
        return;
      return { abs, image };
    } catch {
      return;
    } // Unknown artifact identity is retention, never permission to delete.
  }

  private maintenanceBlocked(workspaceId: string): boolean {
    if (pendingContractIdentityWrites(this.db, workspaceId).length) return true;
    const has = (name: string) =>
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (
      has("file_batches") &&
      this.db.prepare("SELECT 1 FROM file_batches WHERE workspace_id=? LIMIT 1").get(workspaceId)
    )
      return true;
    if (
      has("documents") &&
      this.db
        .prepare(
          "SELECT 1 FROM documents WHERE workspace_id=? AND head_rev<>checkpoint_rev LIMIT 1",
        )
        .get(workspaceId)
    )
      return true;
    if (
      has("doc_checkpoints") &&
      has("documents") &&
      this.db
        .prepare(
          "SELECT 1 FROM doc_checkpoints c JOIN documents d ON d.id=c.doc_id WHERE d.workspace_id=? LIMIT 1",
        )
        .get(workspaceId)
    )
      return true;
    return false;
  }

  pruneBackupsOnStartup(
    workspaceId: string,
    root: string,
  ): { prunedCount: number; preservedCount: number } {
    this.assertStartupWorkspace(workspaceId, root);
    if (this.maintainedWorkspaces.has(workspaceId))
      throw new FileOperationError("APPROVAL_DENIED", "该启动实例已执行过此工作区维护");
    this.maintainedWorkspaces.add(workspaceId);
    const rows = this.db
      .prepare(
        "SELECT * FROM backups WHERE workspace_id=? AND kind='backup' ORDER BY created_at DESC,id DESC",
      )
      .all(workspaceId);
    let prunedCount = 0;
    if (this.maintenanceBlocked(workspaceId)) return { prunedCount, preservedCount: rows.length };
    const counts = new Map<string, number>(),
      cutoff = Date.now() - 30 * 86400_000;
    for (const row of rows) {
      const path = String(row.original_path),
        count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      if (count <= 20 && Date.parse(String(row.created_at)) >= cutoff) continue;
      const original = this.maintenanceArtifact(root, row);
      if (!original) continue;
      let committing = false;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.db
          .prepare("SELECT * FROM backups WHERE id=? AND workspace_id=?")
          .get(String(row.id), workspaceId);
        if (
          !current ||
          JSON.stringify(current) !== JSON.stringify(row) ||
          this.maintenanceBlocked(workspaceId)
        ) {
          this.db.exec("ROLLBACK");
          continue;
        }
        // Old rows carry workspace/path, not task origin. Require a distinct surviving physical copy.
        const alternatives = this.db
          .prepare(
            "SELECT * FROM backups WHERE workspace_id=? AND original_path=? AND sha256=? AND kind='backup' AND id<>?",
          )
          .all(workspaceId, path, String(row.sha256), String(row.id));
        const survivor = alternatives
          .map((item) => this.maintenanceArtifact(root, item))
          .find(
            (item) =>
              item &&
              item.abs !== original.abs &&
              (item.image.device !== original.image.device ||
                item.image.inode !== original.image.inode),
          );
        const target = this.maintenanceArtifact(root, current);
        if (
          !survivor ||
          !target ||
          !sameCompensationImage(original.image, target.image) ||
          !sameCompensationImage(survivor.image, compensationImage(survivor.abs))
        ) {
          this.db.exec("ROLLBACK");
          continue;
        }
        const deleted = this.db
          .prepare(
            "DELETE FROM backups WHERE id=? AND workspace_id=? AND backup_path=? AND sha256=? AND size=? AND created_at=?",
          )
          .run(
            String(row.id),
            workspaceId,
            String(row.backup_path),
            String(row.sha256),
            Number(row.size),
            String(row.created_at),
          );
        if (deleted.changes !== 1) {
          this.db.exec("ROLLBACK");
          continue;
        }
        if (!sameCompensationImage(target.image, compensationImage(target.abs)))
          throw new FileOperationError(
            "VERSION_CONFLICT",
            "备份清理前身份已变化，保留未决记录",
            true,
          );
        rmSync(target.abs); // Single exact regular artifact, never recursive and never a user file.
        committing = true;
        this.db.exec("COMMIT");
        prunedCount++;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        if (committing)
          throw new FileOperationError(
            "INTERNAL",
            "冗余副本已清理但记录提交不确定，其他副本仍保留",
            true,
          );
        throw error;
      }
    }
    return { prunedCount, preservedCount: rows.length - prunedCount };
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
