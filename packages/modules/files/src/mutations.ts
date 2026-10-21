import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, sep } from "node:path";
import {
  AccessFactsPersistenceError,
  assertFiniteFileParent,
  atomicWrite,
  type BackupService,
  copyWorkspacePath,
  currentToolAccess,
  FileOperationError,
  internalPath,
  PathSafetyError,
  pathVersion,
  resolveWorkspacePath,
  sha256,
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
function textPath(ctx: ToolContext, path: string): { abs: string; rel: string } {
  if (BINARY.test(path))
    throw new FileOperationError(
      "UNSUPPORTED_FEATURE",
      "write/edit 只能处理文本，工作簿请用 workbook_edit",
    );
  const p = resolveWorkspacePath(ctx.workspaceRoot, path);
  if (!p.rel) throw new FileOperationError("INVALID_ARGUMENT", "不能写入工作区根目录");
  if (withFileAccessSync({ kind: "file-metadata", path: p.abs }, () => existsSync(p.abs))) {
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
    targets: (a) => [a.path],
    intentMeta: (a, c) => before([a.path], c),
    execute(a, ctx) {
      try {
        ctx.signal.throwIfAborted();
        const { abs, rel } = textPath(ctx, a.path);
        assertTarget(ctx, rel);
        const old = pathVersion(abs);
        if (
          (old !== null && a.expectedVersion !== old) ||
          (old === null && a.expectedVersion !== undefined)
        )
          return denied("VERSION_CONFLICT", "文本文件版本不匹配，请重新读取 sha256");
        const backup = ctx.backups.ensureBackup(rel);
        const version = atomicWrite(ctx.workspaceRoot, rel, Buffer.from(a.content), old);
        if (old === null) ctx.backups.markCreated(rel);
        return {
          status: "ok",
          versions: { [rel]: version },
          data: {
            path: rel,
            size: withFileAccessSync({ kind: "file-metadata", path: abs }, () => statSync(abs))
              .size,
            ...(backup ? { backupPath: backup.backupPath } : {}),
          },
          changes: { paths: [rel] },
        };
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
    targets: (a) => [a.path],
    intentMeta: (a, c) => before([a.path], c),
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
    effect: (a: z.infer<typeof FilesInput>) =>
      a.ops.some((o) => o.op === "delete")
        ? "destructive"
        : a.ops.every((o) => o.op === "backup" && o.list)
          ? "read"
          : "write",
    targets: (a) =>
      a.ops.flatMap((o) => [...(o.path ? [o.path] : []), ...("to" in o ? [o.to] : [])]),
    intentMeta: (a, c) =>
      before(
        a.ops.flatMap((o) => [...(o.path ? [o.path] : []), ...("to" in o ? [o.to] : [])]),
        c,
      ),
    execute(a, ctx) {
      let journal: string | null = null;
      const undo: Array<() => void> = [];
      const replacedTargets = new Set<string>();
      const trashArtifacts: string[] = [];
      const prepareParents = (abs: string): string[] => {
        if (assertFiniteFileParent(abs)) return [];
        const created: string[] = [];
        let p = dirname(abs);
        while (
          !withFileAccessSync({ kind: "file-metadata", path: p, purpose: "parents" }, () =>
            existsSync(p),
          )
        ) {
          created.push(p);
          p = dirname(p);
        }
        return created.reverse();
      };
      try {
        ctx.signal.throwIfAborted();
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
              withFileAccessSync({ kind: "file-metadata", path: dst.abs }, () =>
                existsSync(dst.abs),
              ))
          )
            throw new FileOperationError("VERSION_CONFLICT", "目标已存在，未覆盖");
          if (
            o.op !== "mkdir" &&
            !withFileAccessSync({ kind: "file-metadata", path: src.abs }, () => existsSync(src.abs))
          )
            throw new FileOperationError("NOT_FOUND", "源文件不存在");
          if (
            o.op === "mkdir" &&
            withFileAccessSync({ kind: "file-metadata", path: src.abs }, () => existsSync(src.abs))
          )
            throw new FileOperationError("VERSION_CONFLICT", "目录已存在");
          if (o.op === "move" || o.op === "delete") assertTarget(ctx, src.rel, o.op);
          if (dst) assertTarget(ctx, dst.rel, "destination");
          if (
            withFileAccessSync({ kind: "file-metadata", path: src.abs }, () => existsSync(src.abs))
          )
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
        journal = backups.beginFileBatch(
          ctx.workspaceId,
          ctx.workspaceRoot,
          plan.flatMap(({ op: o, src, dst }) => {
            if (!src || o.op === "backup") return [];
            if (o.op === "mkdir") return [{ path: src.rel, after: sha256(new Uint8Array()) }];
            const after = pathVersion(src.abs);
            return [
              ...(o.op === "move" || o.op === "delete" ? [{ path: src.rel, after: null }] : []),
              ...(dst ? [{ path: dst.rel, after }] : []),
            ];
          }),
        );
        let result: ToolResult;
        try {
          result = backups.atomicBatch(() => {
            const results: unknown[] = [];
            for (const { op: o, src, dst } of plan) {
              ctx.signal.throwIfAborted();
              if (o.op === "backup" && o.list) {
                results.push({ backups: ctx.backups.list(o.path) });
                continue;
              }
              if (!src) throw new Error();
              if (o.op === "backup") {
                results.push(ctx.backups.backup(src.rel));
                continue;
              }
              if (o.op === "mkdir") {
                const parents = prepareParents(src.abs);
                withFileAccessSync({ kind: "file-write", path: src.abs, purpose: "mkdir" }, () =>
                  mkdirSync(src.abs, { recursive: true }),
                );
                undo.push(() => {
                  withFileAccessSync(
                    { kind: "file-write", path: src.abs, purpose: "rollback" },
                    () => rmdirSync(src.abs),
                  );
                  for (const p of parents.reverse())
                    withFileAccessSync({ kind: "file-write", path: p, purpose: "rollback" }, () =>
                      rmdirSync(p),
                    );
                });
                results.push({ path: src.rel });
                continue;
              }
              if (o.op === "delete") {
                const info = ctx.backups.trash(src.rel);
                trashArtifacts.push(info.backupPath);
                undo.push(() =>
                  withFileAccessSync(
                    { kind: "file-write", path: src.abs, purpose: "rollback" },
                    () =>
                      cpSync(
                        internalPath(
                          ctx.workspaceRoot,
                          info.backupPath.slice(".excelmanus/".length),
                        ),
                        src.abs,
                        { recursive: true, errorOnExist: true, force: false },
                      ),
                  ),
                );
                results.push({ path: src.rel, trashPath: info.backupPath });
                continue;
              }
              if (!dst) throw new Error();
              const hash = pathVersion(src.abs);
              const backup = o.op === "move" ? ctx.backups.ensureBackup(src.rel) : undefined;
              const parents = prepareParents(dst.abs);
              withFileAccessSync(
                { kind: "file-write", path: dst.abs, purpose: "copy-parents" },
                () => mkdirSync(dirname(dst.abs), { recursive: true }),
              );
              // Parent cleanup runs after the file operation is undone (undo stack is LIFO).
              if (parents.length > 0)
                undo.push(() => {
                  for (const p of parents.slice().reverse())
                    withFileAccessSync({ kind: "file-write", path: p, purpose: "rollback" }, () =>
                      rmdirSync(p),
                    );
                });
              let copyBaseline:
                | {
                    version: 1;
                    sourceSha256: string;
                    destinationSha256: string;
                    destinationWasAbsent: true;
                  }
                | undefined;
              if (o.op === "copy") {
                copyBaseline = copyWorkspacePath(ctx.workspaceRoot, src.rel, dst.rel, (revert) =>
                  undo.push(() => {
                    try {
                      revert();
                    } catch (error) {
                      if (error instanceof FileOperationError && error.uncertain)
                        replacedTargets.add(dst.rel);
                      throw error;
                    }
                  }),
                );
                if (pathVersion(dst.abs) !== hash)
                  throw new FileOperationError("INTERNAL", "复制回读校验失败");
                if (copyBaseline?.sourceSha256 !== hash) copyBaseline = undefined;
              } else {
                withFileAccessSync({ kind: "file-write", path: src.abs, purpose: "move" }, () =>
                  withFileAccessSync({ kind: "file-write", path: dst.abs, purpose: "move" }, () =>
                    renameSync(src.abs, dst.abs),
                  ),
                );
                undo.push(() =>
                  withFileAccessSync(
                    { kind: "file-write", path: dst.abs, purpose: "rollback" },
                    () =>
                      withFileAccessSync(
                        { kind: "file-write", path: src.abs, purpose: "rollback" },
                        () => renameSync(dst.abs, src.abs),
                      ),
                  ),
                );
              }
              ctx.backups.markCreated(dst.rel);
              results.push({
                path: src.rel,
                to: dst.rel,
                ...(backup ? { backupPath: backup.backupPath } : {}),
                ...(o.op === "copy"
                  ? copyBaseline
                    ? { copyBaseline }
                    : {
                        copyBaselineWarning:
                          "复制成功，但未确认源与目标的稳定字节身份，不能作为原样基线证明",
                      }
                  : {}),
              });
            }
            onBatchCommit();
            backups.commitFileBatch(journal);
            return {
              status: "ok" as const,
              data: { results },
              changes: { paths: touched.map((p) => p.slice(ctx.workspaceRoot.length + 1)) },
            };
          });
        } catch (error) {
          // The business transaction committed before its access-fact flush failed.
          // Keep the actual result; undoing here would split files from committed metadata.
          if (error instanceof AccessFactsPersistenceError && error.operationSucceeded) {
            const committed = error.operationResult as ToolResult;
            backups.cleanupFileBatch(ctx.workspaceRoot, journal);
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
        backups.cleanupFileBatch(ctx.workspaceRoot, journal);
        return result;
      } catch (e) {
        let failed = false;
        for (const revert of undo.reverse())
          try {
            revert();
          } catch {
            failed = true;
          }
        if (!failed)
          for (const stored of trashArtifacts)
            try {
              rmSync(internalPath(ctx.workspaceRoot, stored.slice(".excelmanus/".length)), {
                recursive: true,
                force: true,
              });
            } catch {
              failed = true;
            }
        if (journal) {
          try {
            const access = currentToolAccess();
            backups.recoverFileBatches(
              ctx.workspaceId,
              ctx.workspaceRoot,
              replacedTargets.size || (access && access.binding().decision.kind !== "unbounded")
                ? journal
                : undefined,
              replacedTargets,
            );
            failed = replacedTargets.size > 0;
          } catch {
            failed = true;
          }
        }
        return failed
          ? {
              status: "uncertain",
              error: {
                code: "INTERNAL",
                message: replacedTargets.size
                  ? `复制目标已被其他操作替换，未触碰替换者；本批其余目标已尝试回滚，结果不确定：${[...replacedTargets].join("、")}`
                  : "批量文件操作回滚失败，结果不确定",
                retryable: false,
              },
            }
          : fail(e);
      }
    },
  };
  return [write, edit, files];
}
