import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AccessFact, AccessKind, TurnAccessBinding } from "@excelmanus/protocol";
import { accessScopeAllows, normalizeAccessPath } from "./access-scope.ts";
import type { NewRecord, SessionLog } from "./session-log.ts";
import { turnAccessBinding } from "./turn-access.ts";

export interface ToolAccessContext {
  readonly db: DatabaseSync;
  readonly log: SessionLog;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly sdkCallIndex?: number;
  readonly originAgentId: string;
  readonly originTurnId: string;
  binding(): TurnAccessBinding;
  auditFailed: boolean;
  /** Host-only transaction buffer, never a tool or model parameter. */
  buffer?: NewRecord[];
}
const local = new AsyncLocalStorage<ToolAccessContext | undefined>();
export function currentToolAccess(): ToolAccessContext | undefined {
  return local.getStore();
}
export function runWithToolAccess<T>(context: ToolAccessContext, action: () => T): T {
  return local.run(context, action);
}
/** Only for independent system schedulers, never for user-resource operations. */
export function runWithoutToolAccess<T>(action: () => T): T {
  return local.run(undefined, action);
}
export function bindToolAccess(input: {
  db: DatabaseSync;
  log: SessionLog;
  workspaceRoot: string;
  sessionId: string;
  agentId: string;
  turnId: string;
  toolCallId: string;
  stepId?: string;
}): ToolAccessContext {
  const initial = turnAccessBinding(input.db, input.sessionId, input.agentId, input.turnId);
  const fallback: TurnAccessBinding = {
    originAgentId: input.agentId,
    originTurnId: input.turnId,
    sourceDispatchIds: [],
    ruleVersion: 1,
    decision: { kind: "unbounded" },
    accessDeliveryRequired: false,
  };
  return {
    ...input,
    originAgentId: initial?.originAgentId ?? input.agentId,
    originTurnId: initial?.originTurnId ?? input.turnId,
    auditFailed: false,
    binding: () =>
      turnAccessBinding(input.db, input.sessionId, input.agentId, input.turnId) ??
      (initial
        ? {
            ...initial,
            decision: { kind: "unresolved", reason: "本轮访问范围记录不可用" },
            accessDeliveryRequired: true,
          }
        : fallback),
  };
}
export class TurnAccessError extends Error {
  readonly code = "INVALID_ARGUMENT";
  constructor(message: string) {
    super(message);
    this.name = "TurnAccessError";
  }
}
/** A host result and an audit failure are independent: never undo an already committed batch. */
export class AccessFactsPersistenceError<T = unknown> extends TurnAccessError {
  readonly operationSucceeded: boolean;
  readonly operationResult?: T;
  readonly operationError?: unknown;
  constructor(
    message: string,
    operationSucceeded: boolean,
    operationResult?: T,
    operationError?: unknown,
  ) {
    super(message);
    this.name = "AccessFactsPersistenceError";
    this.operationSucceeded = operationSucceeded;
    this.operationResult = operationResult;
    this.operationError = operationError;
  }
}
function append(ctx: ToolAccessContext, records: NewRecord[]): void {
  if (ctx.buffer) {
    ctx.buffer.push(...records);
    return;
  }
  try {
    if (ctx.db.isTransaction)
      throw new Error("宿主事务必须使用 runWithBufferedAccessFacts 保存访问事实");
    if (ctx.log.append(ctx.sessionId, ctx.agentId, records).length !== records.length)
      throw new Error("会话不可写");
  } catch (error) {
    ctx.auditFailed = true;
    throw new TurnAccessError(
      `访问事实未能持久化，不能完成本轮核验：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function relativeResource(ctx: ToolAccessContext, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(resolve(ctx.workspaceRoot), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new TurnAccessError("路径不在当前任务的工作区内");
  return rel.split(sep).join("/") || ".";
}
function checkedPath(
  ctx: ToolAccessContext,
  path: string,
  workspaceRoot?: string,
  kind: AccessKind = "file-metadata",
): string {
  if (workspaceRoot !== undefined && resolve(workspaceRoot) !== resolve(ctx.workspaceRoot))
    throw new TurnAccessError("路径不属于当前任务的工作区");
  const binding = ctx.binding();
  if (binding.decision.kind === "unbounded") return path;
  if (binding.decision.kind === "unresolved")
    throw new TurnAccessError(
      `本轮允许文件或目录不明确，访问未执行：${binding.decision.reason}。请在新消息中写明“仅访问目录 <相对目录>，执行 <任务>”。`,
    );
  const normalized = normalizeAccessPath(path);
  if (normalized === undefined) throw new TurnAccessError("路径必须是合法的工作区相对路径");
  if (
    !accessScopeAllows(
      binding.decision,
      normalized,
      kind === "file-write" ? "write" : kind === "directory-enumeration" ? "enumerate" : "read",
    )
  )
    throw new TurnAccessError(
      binding.decision.kind === "files"
        ? "本轮仅允许读取明确的源文件和输出文件，只有输出文件可写；不允许目录枚举或其他路径，该操作未执行。"
        : `本轮仅允许访问目录 ${binding.decision.root}；该路径未访问。`,
    );
  return normalized;
}
function fact(
  ctx: ToolAccessContext,
  spec: AccessSpec,
  operationId: string,
  outcome: AccessFact["outcome"],
): AccessFact {
  return {
    operationId,
    turnId: ctx.turnId,
    originAgentId: ctx.originAgentId,
    originTurnId: ctx.originTurnId,
    toolCallId: ctx.toolCallId,
    ...(ctx.sdkCallIndex !== undefined ? { sdkCallIndex: ctx.sdkCallIndex } : {}),
    ...spec,
    outcome,
  };
}
/** Pure pre-resolution guard. The resolver calls it before any target metadata I/O. */
export function assertToolAccess(path: string, workspaceRoot?: string): string {
  return assertAccess(path, workspaceRoot, "file-metadata");
}
export function assertToolWriteAccess(path: string, workspaceRoot?: string): string {
  return assertAccess(path, workspaceRoot, "file-write");
}
function assertAccess(path: string, workspaceRoot: string | undefined, kind: AccessKind): string {
  const ctx = currentToolAccess();
  if (!ctx || ctx.binding().decision.kind === "unbounded") return path;
  try {
    return checkedPath(ctx, path, workspaceRoot, kind);
  } catch (error) {
    append(ctx, [
      {
        type: "access.fact",
        data: fact(
          ctx,
          { kind, path, purpose: "path-rejected" },
          randomUUID(),
          "rejected-before-access",
        ),
      },
    ]);
    throw error;
  }
}
/** One provenance bit, not a path audit: later narrowing cannot certify unknown earlier I/O. */
export function markUnscopedAccess(): void {
  const ctx = currentToolAccess();
  if (!ctx || ctx.binding().decision.kind !== "unbounded") return;
  if (
    ctx.db
      .prepare(
        "SELECT 1 FROM session_log WHERE session_id=? AND type='access.unscoped' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? LIMIT 1",
      )
      .get(ctx.sessionId, ctx.originAgentId, ctx.originTurnId)
  )
    return;
  append(ctx, [
    {
      type: "access.unscoped",
      data: {
        turnId: ctx.turnId,
        originAgentId: ctx.originAgentId,
        originTurnId: ctx.originTurnId,
      },
    },
  ]);
}
/** Only the already registered workspace root, for internal identity/staging paths. */
export function canonicalWorkspaceRoot(root: string): string {
  const ctx = currentToolAccess();
  if (ctx && resolve(root) !== resolve(ctx.workspaceRoot))
    throw new TurnAccessError("系统根目录不属于当前任务工作区");
  return realpathSync.native(root);
}
/** Recheck the existing path chain immediately before each scoped host operation.
 * Lookup of a required ancestor is metadata, not directory enumeration. Never follow a symlink.
 * This is a host boundary check, not a claim of OS-level race-proof isolation.
 */
function checkPhysicalAccess(ctx: ToolAccessContext, path: string): void {
  const root = canonicalWorkspaceRoot(ctx.workspaceRoot);
  const parts = path.split("/").filter((p) => p && p !== ".");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const rel = parts.slice(0, index + 1).join("/");
    const id = randomUUID();
    const spec: AccessSpec = { kind: "file-metadata", path: rel, purpose: "path-resolution" };
    append(ctx, [{ type: "access.fact", data: fact(ctx, spec, id, "started") }]);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      // ENOENT is a completed lookup; no deeper resource has been inspected.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      append(ctx, [
        { type: "access.fact", data: fact(ctx, spec, id, missing ? "succeeded" : "failed") },
      ]);
      if (missing) return;
      throw error;
    }
    append(ctx, [{ type: "access.fact", data: fact(ctx, spec, id, "succeeded") }]);
    if (stat.isSymbolicLink()) {
      append(ctx, [
        {
          type: "access.fact",
          data: fact(
            ctx,
            { kind: "file-metadata", path, purpose: "symlink-rejected" },
            randomUUID(),
            "rejected-before-access",
          ),
        },
      ]);
      throw new TurnAccessError("受限任务不跟随符号链接；目标未访问");
    }
  }
}
/** Resolver preflight, before its own lstat/realpath; also used on already resolved host paths. */
export function assertPhysicalToolAccess(path: string, workspaceRoot?: string): void {
  const ctx = currentToolAccess();
  if (!ctx || ctx.binding().decision.kind === "unbounded") return;
  const normalized = assertToolAccess(path, workspaceRoot);
  checkPhysicalAccess(ctx, normalized);
}
export interface AccessSpec {
  kind: AccessKind;
  path: string;
  purpose?: string;
  docId?: string;
  rev?: number;
  mode?: string;
  range?: string;
  packageState?: string;
}
function begin(
  spec: AccessSpec,
): { ctx: ToolAccessContext; spec: AccessSpec; operationId: string } | undefined {
  const ctx = currentToolAccess();
  if (!ctx) return;
  if (ctx.binding().decision.kind === "unbounded") {
    markUnscopedAccess();
    return;
  }
  const operationId = randomUUID();
  let path = spec.path;
  try {
    path = checkedPath(ctx, relativeResource(ctx, path), undefined, spec.kind);
  } catch (error) {
    append(ctx, [
      {
        type: "access.fact",
        data: fact(ctx, { ...spec, path }, operationId, "rejected-before-access"),
      },
    ]);
    throw error;
  }
  checkPhysicalAccess(ctx, path);
  const normalized = { ...spec, path };
  append(ctx, [{ type: "access.fact", data: fact(ctx, normalized, operationId, "started") }]);
  return { ctx, spec: normalized, operationId };
}
function finish(state: ReturnType<typeof begin>, outcome: "succeeded" | "failed"): void {
  if (state)
    append(state.ctx, [
      { type: "access.fact", data: fact(state.ctx, state.spec, state.operationId, outcome) },
    ]);
}
function auditAfterFailure(operationError: unknown, auditError: unknown): never {
  throw new AccessFactsPersistenceError(
    `宿主操作失败（${operationError instanceof Error ? operationError.message : String(operationError)}）；访问事实记录也失败（${auditError instanceof Error ? auditError.message : String(auditError)}），本轮不能完成核验。`,
    false,
    undefined,
    operationError,
  );
}
export function withFileAccessSync<T>(spec: AccessSpec, action: () => T): T {
  const state = begin(spec);
  let value: T;
  try {
    value = action();
  } catch (error) {
    try {
      finish(state, "failed");
    } catch (audit) {
      auditAfterFailure(error, audit);
    }
    throw error;
  }
  try {
    finish(state, "succeeded");
  } catch (error) {
    throw new AccessFactsPersistenceError(
      `宿主操作已经执行成功，但访问事实记录失败，本轮不能完成核验：${error instanceof Error ? error.message : String(error)}`,
      true,
      value,
    );
  }
  return value;
}
export async function withFileAccess<T>(spec: AccessSpec, action: () => Promise<T>): Promise<T> {
  const state = begin(spec);
  let value: T;
  try {
    value = await action();
  } catch (error) {
    try {
      finish(state, "failed");
    } catch (audit) {
      auditAfterFailure(error, audit);
    }
    throw error;
  }
  try {
    finish(state, "succeeded");
  } catch (error) {
    throw new AccessFactsPersistenceError(
      `宿主操作已经执行成功，但访问事实记录失败，本轮不能完成核验：${error instanceof Error ? error.message : String(error)}`,
      true,
      value,
    );
  }
  return value;
}
/** The caller already resolved this exact permitted descendant; ancestors are lookup-only facts. */
export function recordPathResolution(path: string, outcome: "succeeded" | "failed"): void {
  const ctx = currentToolAccess();
  if (!ctx || ctx.binding().decision.kind === "unbounded") return;
  append(ctx, [
    {
      type: "access.fact",
      data: fact(
        ctx,
        { kind: "file-metadata", path, purpose: "path-resolution" },
        randomUUID(),
        outcome,
      ),
    },
  ]);
}
export function recordDocumentAccess(
  spec: AccessSpec & { kind: "document-snapshot" | "package-cache-parse" },
): void {
  const state = begin(spec);
  finish(state, "succeeded");
}
/** Must surround, not run inside, a host SQLite transaction. Rollback never erases reads. */
export function runWithBufferedAccessFacts<T>(action: () => T): T {
  const ctx = currentToolAccess();
  if (!ctx || ctx.buffer) return action();
  // This helper is the host file-transaction boundary. Persist the one provenance bit before BEGIN.
  if (ctx.binding().decision.kind === "unbounded") {
    markUnscopedAccess();
    return action();
  }
  if (ctx.db.isTransaction) throw new TurnAccessError("访问事实批次必须在宿主事务开始之前建立");
  const batchId = randomUUID();
  const base = {
    batchId,
    turnId: ctx.turnId,
    originAgentId: ctx.originAgentId,
    originTurnId: ctx.originTurnId,
    toolCallId: ctx.toolCallId,
  };
  append(ctx, [{ type: "access.batch", data: { ...base, status: "started" } }]);
  ctx.buffer = [];
  let value!: T;
  let failed = false;
  let operationError: unknown;
  try {
    value = action();
  } catch (error) {
    failed = true;
    operationError = error;
  }
  const records = ctx.buffer;
  delete ctx.buffer;
  if (
    !failed &&
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value! &&
    typeof value.then === "function"
  ) {
    // The already-started batch stays open: async misuse must not certify complete coverage.
    ctx.auditFailed = true;
    throw new TurnAccessError(
      "runWithBufferedAccessFacts 仅支持同步事务，不允许 Promise 或跨 await 操作",
    );
  }
  try {
    append(ctx, [...records, { type: "access.batch", data: { ...base, status: "closed" } }]);
  } catch (audit) {
    if (failed) auditAfterFailure(operationError, audit);
    throw new AccessFactsPersistenceError(
      `宿主批次已成功结束，但实际访问事实未保存：${audit instanceof Error ? audit.message : String(audit)}`,
      true,
      value,
    );
  }
  if (failed) throw operationError;
  return value!;
}

/** Finite-file output grants no directory creation. Its necessary existing parent is lookup-only. */
export function assertFiniteFileParent(path: string): boolean {
  const ctx = currentToolAccess();
  if (!ctx || ctx.binding().decision.kind !== "files") return false;
  const target = relativeResource(ctx, path);
  const normalized = assertToolWriteAccess(target, ctx.workspaceRoot);
  checkPhysicalAccess(ctx, normalized);
  const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : ".";
  const spec: AccessSpec = { kind: "file-metadata", path: parent, purpose: "path-resolution" };
  const state = { ctx, spec, operationId: randomUUID() };
  append(ctx, [{ type: "access.fact", data: fact(ctx, spec, state.operationId, "started") }]);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(join(canonicalWorkspaceRoot(ctx.workspaceRoot), parent));
  } catch {
    finish(state, "failed");
    throw new TurnAccessError("有限文件任务要求输出父目录已存在，不会创建额外目录");
  }
  finish(state, "succeeded");
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new TurnAccessError("输出父目录必须是已有的真实目录");
  return true;
}
