import { existsSync, readFileSync, statSync } from "node:fs";
import { sep } from "node:path";
import {
  AccessFactsPersistenceError,
  assertToolEffectsAllowed,
  assertToolWriteAccess,
  atomicWrite,
  type BackupService,
  type FileBatchOperation,
  type FileBatchCompensation,
  type FileBatchIdentityPreparation,
  currentToolAccess,
  type EffectIntent,
  effectPathExists,
  FileOperationError,
  PathSafetyError,
  pathVersion,
  prepareEffectPlan,
  recheckEffectPlan,
  runWithEffectPlan,
  resolveWorkspacePath,
  sha256,
  statVerifiedResourceSync,
  type ToolContext,
  type ToolDefinition,
  TurnAccessError,
  withFileAccessSync,
} from "@excelmanus/kernel";
import {
  EditInput,
  type FileIntentMeta,
  FilesInput,
  type ToolResult,
  WriteInput,
} from "@excelmanus/protocol";
import { z } from "zod";

const denied = (code: string, message: string): ToolResult => ({
  status: "error",
  error: { code, message, retryable: false },
});
const fail = (e: unknown): ToolResult =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
    ? denied(e.name === "AbortError" ? "CANCELLED" : "TIMEOUT", "文件操作已取消或超时")
    : e instanceof FileOperationError ||
        e instanceof PathSafetyError ||
        e instanceof TurnAccessError
      ? denied(e.code, e.message)
      : denied("INTERNAL", "文件操作失败，未自动重试");
function existsVerified(root: string, path: string): boolean {
  try { statVerifiedResourceSync(root, path, { purpose: "file-source-existence" }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
const BINARY =
  /\.(xlsx|xlsm|xls|xlsb|ods|zip|png|jpe?g|gif|webp|pdf|exe|dll|bin|gz|7z|woff2?|mp[34])$/i;
function readText(abs: string): string {
  const bytes = withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "edit-text" }, () =>
    readFileSync(abs),
  );
  if (bytes.length > 50 * 1024 * 1024)
    throw new FileOperationError("LIMIT_EXCEEDED", "文本文件超过 50MB");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error();
    return text;
  } catch {
    throw new FileOperationError("UNSUPPORTED_FEATURE", "仅支持 UTF-8 文本文件");
  }
}
function textPath(ctx: ToolContext, path: string, create = false): { abs: string; rel: string } {
  assertToolWriteAccess(path, ctx.workspaceRoot, create ? "create" : "mutate");
  if (BINARY.test(path))
    throw new FileOperationError(
      "UNSUPPORTED_FEATURE",
      "write/edit 只能处理文本，工作簿请用 workbook_edit",
    );
  const p = resolveWorkspacePath(ctx.workspaceRoot, path);
  if (!p.rel) throw new FileOperationError("INVALID_ARGUMENT", "不能写入工作区根目录");
  if (!create && withFileAccessSync({ kind: "file-metadata", path: p.abs }, () => existsSync(p.abs))) {
    if (!withFileAccessSync({ kind: "file-metadata", path: p.abs }, () => statSync(p.abs)).isFile())
      throw new FileOperationError("INVALID_ARGUMENT", "目标不是文本文件");
    readText(p.abs);
  }
  return p;
}
function before(paths: string[], ctx: ToolContext): FileIntentMeta {
  return {
    workspaceId: ctx.workspaceId,
    paths: Object.fromEntries(
      paths.map((p) => [p, pathVersion(resolveWorkspacePath(ctx.workspaceRoot, p).abs)]),
    ),
  };
}

export function fileMutationEffects(input: z.infer<typeof FilesInput>): EffectIntent[] {
  return input.ops.flatMap((op): EffectIntent[] => {
    if (op.op === "backup") return [];
    if (op.op === "copy") return [{ kind: "create", path: op.to }];
    if (op.op === "move") return [
      { kind: "relocate", path: op.path, to: op.to },
      { kind: "remove", path: op.path },
      { kind: "create", path: op.to },
    ];
    return [{ kind: op.op === "delete" ? "remove" : "create", path: op.path }];
  });
}

/** Validate every write target before resolving any operation in a batch. */
export function assertFileMutationAccess(
  input: z.infer<typeof FilesInput>,
  workspaceRoot?: string,
): void {
  assertToolEffectsAllowed(fileMutationEffects(input), workspaceRoot);
  for (const op of input.ops) {
    if (op.op === "backup") continue;
    if (op.op !== "copy") assertToolWriteAccess(op.path, workspaceRoot, op.op === "mkdir" ? "create" : "remove");
    if ("to" in op) assertToolWriteAccess(op.to, workspaceRoot, "create");
  }
}
export function mutationTools(
  backups: BackupService,
  assertTarget: (ctx: ToolContext, path: string, operation?: string) => void = () => {},
  onBatchCommit: () => void = () => {},
): ToolDefinition[] {
  const recovery: Pick<ToolDefinition, "recover"> = {
    recover: (info) => backups.recover(info.intentMeta),
  };
  const common = {
    output: z.record(z.string(), z.unknown()),
    replay: "unsafe" as const,
    timeoutMs: 30000,
    roles: ["main", "lead", "worker"] as ToolDefinition["roles"],
    ...recovery,
  };
  const write: ToolDefinition<z.infer<typeof WriteInput>> = {
    ...common,
    name: "write",
    title: "写入文本",
    description:
      "创建或整体覆盖工作区 UTF-8 文本文件；覆盖必须携带 sha256 expectedVersion。写入前自动备份，父目录自动创建；不能写工作簿。VERSION_CONFLICT 时先重新读取。",
    input: WriteInput,
    effect: "write",
    effectIntents: (a) => [{ kind: a.expectedVersion === undefined ? "create" : "mutate", path: a.path }],
    targets: (a, scope) => {
      assertToolWriteAccess(a.path, scope?.workspaceRoot, a.expectedVersion === undefined ? "create" : "mutate");
      return [a.path];
    },
    intentMeta: (a, c) => {
      assertToolWriteAccess(a.path, c.workspaceRoot, a.expectedVersion === undefined ? "create" : "mutate");
      return a.expectedVersion === undefined ? { workspaceId: c.workspaceId, paths: { [a.path]: null } } : before([a.path], c);
    },
    execute(a, ctx) {
      try {
        const create = a.expectedVersion === undefined;
        const permit = prepareEffectPlan({ workspaceRoot: ctx.workspaceRoot, signal: ctx.signal,
          effects: [{ operation: create ? "create" : "mutate", path: a.path },
            ...(create ? [] : [
              { operation: "read-metadata" as const, path: a.path },
              { operation: "read-content" as const, path: a.path },
            ])], atomicScope: "single-resource" });
        return runWithEffectPlan(permit, () => {
          ctx.signal.throwIfAborted();
          const { abs, rel } = textPath(ctx, a.path, create);
          assertTarget(ctx, rel);
          const old = create ? null : pathVersion(abs);
          if ((old !== null && a.expectedVersion !== old) ||
              (old === null && a.expectedVersion !== undefined))
            return denied("VERSION_CONFLICT", "文本文件版本不匹配，请重新读取 sha256");
          recheckEffectPlan(permit);
          const backup = old === null ? undefined : ctx.backups.ensureBackup(rel);
          const bytes = Buffer.from(a.content);
          const version = atomicWrite(ctx.workspaceRoot, rel, bytes, old);
          if (old === null) ctx.backups.markCreated(rel, { sha256: version, size: bytes.length });
          return { status: "ok", versions: { [rel]: version },
            data: { path: rel, size: bytes.length, ...(backup ? { backupPath: backup.backupPath } : {}) },
            changes: { paths: [rel] } };
        });
      } catch (e) {
        return fail(e);
      }
    },
  };
  const edit: ToolDefinition<z.infer<typeof EditInput>> = {
    ...common,
    name: "edit",
    title: "替换文本",
    description:
      "对 UTF-8 文本做精确字符串替换，支持多处整批替换。expectedVersion 为原文件 sha256；oldText 默认必须唯一匹配，all=true 可替换所有匹配；不匹配或版本冲突时整批不执行。",
    input: EditInput,
    effect: "write",
    effectIntents: (a) => [{ kind: "mutate", path: a.path }],
    targets: (a, scope) => {
      assertToolWriteAccess(a.path, scope?.workspaceRoot);
      return [a.path];
    },
    intentMeta: (a, c) => {
      assertToolWriteAccess(a.path, c.workspaceRoot);
      return before([a.path], c);
    },
    execute(a, ctx) {
      try {
        ctx.signal.throwIfAborted();
        const { abs, rel } = textPath(ctx, a.path);
        assertTarget(ctx, rel);
        if (!withFileAccessSync({ kind: "file-metadata", path: abs }, () => existsSync(abs)))
          return denied("NOT_FOUND", "文本文件不存在");
        const old = sha256(
          withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "edit-hash" }, () =>
            readFileSync(abs),
          ),
        );
        if (a.expectedVersion !== old)
          return denied("VERSION_CONFLICT", "文本文件版本不匹配，请重新读取 sha256");
        let text = readText(abs);
        for (const e of a.edits) {
          const count = text.split(e.oldText).length - 1;
          if (count === 0 || (!e.all && count !== 1))
            return denied("INVALID_ARGUMENT", "oldText 必须匹配，多个匹配需要 all=true");
          // Use a replacer callback so user text such as "$&" is never interpreted
          // as a replacement pattern by String.replace.
          const replace = () => e.newText;
          text = e.all ? text.replaceAll(e.oldText, replace) : text.replace(e.oldText, replace);
        }
        const backup = ctx.backups.ensureBackup(rel);
        const version = atomicWrite(ctx.workspaceRoot, rel, Buffer.from(text), old);
        return {
          status: "ok",
          versions: { [rel]: version },
          data: { path: rel, ...(backup ? { backupPath: backup.backupPath } : {}) },
          changes: { paths: [rel] },
        };
      } catch (e) {
        return fail(e);
      }
    },
  };
  const files: ToolDefinition<z.infer<typeof FilesInput>> = {
    ...common,
    name: "files",
    title: "管理文件",
    description:
      "整批预检工作区文件操作：mkdir/copy/move/delete/backup。copy/move 使用 path 与 to，不覆盖目标；delete 移入回收站且需审批；backup list=true 可列出备份，path 可筛选。任一预检失败整批不执行；相互重叠路径需分批。",
    input: FilesInput,
    effectIntents: fileMutationEffects,
    effect: (a: z.infer<typeof FilesInput>) =>
      a.ops.some((o) => o.op === "delete")
        ? "destructive"
        : a.ops.every((o) => o.op === "backup" && o.list)
          ? "read"
          : "write",
    targets: (a, scope) => {
      assertFileMutationAccess(a, scope?.workspaceRoot);
      return a.ops.flatMap((o) => [...(o.path ? [o.path] : []), ...("to" in o ? [o.to] : [])]);
    },
    intentMeta: (a, c) => {
      assertFileMutationAccess(a, c.workspaceRoot);
      return before(
        a.ops.flatMap((o) => [...(o.path ? [o.path] : []), ...("to" in o ? [o.to] : [])]),
        c,
      );
    },
    execute(a, ctx) {
      let journal: string | null = null;
      let compensation: FileBatchCompensation | undefined;
      let identityPreparation: FileBatchIdentityPreparation | undefined;
      try {
        ctx.signal.throwIfAborted();
        assertFileMutationAccess(a, ctx.workspaceRoot);
        backups.recoverFileBatches(ctx.workspaceId, ctx.workspaceRoot);
        const touched: string[] = [];
        const access: Array<{ path: string; write: boolean }> = [];
        const plan = a.ops.map((o) => {
          if (o.op === "backup" && o.list) return { op: o };
          if (o.op === "mkdir" && currentToolAccess()?.binding().decision.kind === "files")
            throw new TurnAccessError("有限文件任务不授权创建目录");
          if (!o.path) throw new FileOperationError("INVALID_ARGUMENT", "操作需要 path");
          const src = resolveWorkspacePath(ctx.workspaceRoot, o.path);
          if (!src.rel) throw new FileOperationError("INVALID_ARGUMENT", "不能操作工作区根目录");
          const dst = "to" in o ? resolveWorkspacePath(ctx.workspaceRoot, o.to) : undefined;
          if (
            dst &&
            (!dst.rel ||
              effectPathExists(dst.rel, ctx.workspaceRoot))
          )
            throw new FileOperationError("VERSION_CONFLICT", "目标已存在，未覆盖");
          if (
            o.op !== "mkdir" &&
            !existsVerified(ctx.workspaceRoot, src.rel)
          )
            throw new FileOperationError("NOT_FOUND", "源文件不存在");
          if (
            o.op === "mkdir" && effectPathExists(src.rel, ctx.workspaceRoot)
          )
            throw new FileOperationError("VERSION_CONFLICT", "目录已存在");
          if (o.op === "move" || o.op === "delete") assertTarget(ctx, src.rel, o.op);
          if (dst) assertTarget(ctx, dst.rel, "destination");
          if (o.op !== "mkdir" &&
            existsVerified(ctx.workspaceRoot, src.rel))
            pathVersion(src.abs);
          for (const item of [
            { path: src.abs, write: o.op !== "copy" && o.op !== "backup" },
            ...(dst ? [{ path: dst.abs, write: true }] : []),
          ]) {
            if (
              access.some(
                (x) =>
                  (x.write || item.write) &&
                  (item.path === x.path ||
                    item.path.startsWith(x.path + sep) ||
                    x.path.startsWith(item.path + sep)),
              )
            )
              throw new FileOperationError("INVALID_ARGUMENT", "批量路径重叠，请拆为多个调用");
            access.push(item);
            if (item.write) touched.push(item.path);
          }
          return { op: o, src, dst };
        });
        // 受信标记只由运行时审批门在放行（已批准 / auto / 会话自动批准）后注入；
        // 未经审批执行器的直接调用一律拒绝删除（fail-closed）。
        if (a.ops.some((o) => o.op === "delete") && !ctx.destructiveApproved)
          return denied("APPROVAL_DENIED", "删除未经审批放行，未执行");
        const operations: FileBatchOperation[] = plan.flatMap<FileBatchOperation>(({ op, src, dst }) => {
          if (!src || op.op === "backup") return [];
          return "to" in op ? [{ op: op.op, path: src.rel, to: dst!.rel }] : [{ op: op.op, path: src.rel }];
        });
        const scope = { workspaceId: ctx.workspaceId, workspaceRoot: ctx.workspaceRoot,
          sessionId: ctx.sessionId, agentId: ctx.agentId };
        identityPreparation = backups.prepareFileBatchIdentity(scope, operations);
        journal = backups.beginFileBatch(
          ctx.workspaceId,
          ctx.workspaceRoot,
          plan.flatMap(({ op: o, src, dst }) => {
            if (!src || o.op === "backup") return [];
            if (o.op === "mkdir") return [{ path: src.rel, before: null, after: sha256(new Uint8Array()) }];
            const after = pathVersion(src.abs);
            return [
              ...(o.op === "move" || o.op === "delete" ? [{ path: src.rel, after: null }] : []),
              ...(dst ? [{ path: dst.rel, before: null, after }] : []),
            ];
          }),
        );
        if (journal) compensation = backups.prepareFileBatchCompensation(journal, scope, operations, identityPreparation);
        let result: ToolResult;
        try {
          result = backups.atomicBatch(() => {
            const results: unknown[] = [];
            let step = 0;
            for (const { op: o, src, dst } of plan) {
              ctx.signal.throwIfAborted();
              if (o.op === "backup" && o.list) {
                results.push({ backups: ctx.backups.list(o.path) }); continue;
              }
              if (!src) throw new Error("文件批次缺少已预检路径");
              if (o.op === "backup") { results.push(ctx.backups.backup(src.rel)); continue; }
              if (!compensation) throw new Error("文件批次缺少固定补偿能力");
              const applied = backups.executeFileBatchStep(compensation, step++);
              if (o.op === "mkdir") { results.push({ path: src.rel }); continue; }
              if (o.op === "delete") {
                results.push({ path: src.rel, trashPath: applied.trash!.backupPath }); continue;
              }
              if (!dst) throw new Error("文件批次缺少已预检目标");
              results.push({ path: src.rel, to: dst.rel,
                ...(applied.backup ? { backupPath: applied.backup.backupPath } : {}),
                ...(o.op === "copy" ? applied.copyBaseline ? { copyBaseline: applied.copyBaseline } : {
                  copyBaselineWarning: "复制成功，但未确认源与目标的稳定字节身份，不能作为原样基线证明",
                } : {}),
              });
            }
            onBatchCommit();
            if (identityPreparation && compensation) backups.stageFileBatchIdentity(compensation);
            else backups.commitFileBatch(journal);
            return {
              status: "ok" as const,
              data: { results },
              changes: { paths: touched.map((p) => p.slice(ctx.workspaceRoot.length + 1)) },
            };
          }, compensation);
        } catch (error) {
          // The business transaction committed before its access-fact flush failed.
          // Keep the actual result; undoing here would split files from committed metadata.
          if (error instanceof AccessFactsPersistenceError && error.operationSucceeded) {
            const committed = error.operationResult as ToolResult;
            if (!identityPreparation) backups.cleanupFileBatch(ctx.workspaceRoot, journal);
            return {
              ...committed,
              status: "uncertain",
              error: {
                code: "INTERNAL",
                message: "文件操作已提交，但实际访问记录未完整保存；未回滚，请重新核验",
                retryable: false,
              },
              data: {
                ...(committed.data as Record<string, unknown>),
                results: (
                  (committed.data as { results?: Record<string, unknown>[] }).results ?? []
                ).map((item) => {
                  const result = { ...item };
                  delete result.copyBaseline;
                  return result;
                }),
                accessFactsRecorded: false,
              },
            };
          }
          throw error;
        }
        if (identityPreparation && compensation) backups.finalizeFileBatchIdentity(compensation);
        else backups.cleanupFileBatch(ctx.workspaceRoot, journal);
        return result;
      } catch (e) {
        if (e instanceof FileOperationError && e.uncertain)
          return { status: "uncertain", error: { code: e.code, message: e.message, retryable: false } };
        if (compensation) {
          try { backups.rollbackFileBatchCompensation(compensation); }
          catch (rollback) {
            return { status: "uncertain", error: { code: "INTERNAL",
              message: `本批固定补偿未完成，未覆盖外部资源；可用日志与副本保留：${rollback instanceof Error ? rollback.message : String(rollback)}`,
              retryable: false } };
          }
        } else if (journal) {
          // No forward business operation ran before the compensation capability existed.
          backups.commitFileBatch(journal);
          backups.cleanupFileBatch(ctx.workspaceRoot, journal);
        }
        return fail(e);
      } finally {
        if (compensation) backups.closeFileBatchCompensation(compensation);
      }
    },
  };
  for (const tool of [edit, files] as ToolDefinition[]) {
    const execute = tool.execute;
    tool.execute = (args, ctx) => {
      try {
        const effects = tool.name === "edit"
          ? [
              { operation: "mutate" as const, path: (args as z.infer<typeof EditInput>).path },
              { operation: "read-metadata" as const, path: (args as z.infer<typeof EditInput>).path },
              { operation: "read-content" as const, path: (args as z.infer<typeof EditInput>).path },
            ]
          : [
              ...fileMutationEffects(args as z.infer<typeof FilesInput>).map(({ kind, ...effect }) => ({ operation: kind, ...effect })),
              ...(args as z.infer<typeof FilesInput>).ops.flatMap((op) =>
                op.op === "mkdir" || (op.op === "backup" && op.list) || !op.path ? [] : [
                  { operation: "read-metadata" as const, path: op.path },
                  { operation: "read-content" as const, path: op.path },
                ]),
            ];
        const permit = prepareEffectPlan({ workspaceRoot: ctx.workspaceRoot, effects,
          atomicScope: tool.name === "edit" ? "single-resource" : "none", signal: ctx.signal });
        return runWithEffectPlan(permit, () => execute(args, ctx));
      } catch (error) { return fail(error); }
    };
  }
  return [write, edit, files];
}
