import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AccessFact,
  AccessKind,
  ContractOperation,
  TurnAccessBinding,
} from "@excelmanus/protocol";
import { accessScopeAllows, deliveryScopeAllows, normalizeAccessPath } from "./access-scope.ts";
import {
  type CapturedEffectIntent,
  evaluateDeniedEffects,
  taskDeniedEffects,
} from "./denial-fence.ts";
import {
  assertHostNativeStorage,
  assertPlannedOperation,
  currentHostNativeAccess,
  type EffectPermit,
  hasPlannedPath,
  prepareEffectPlan,
  publicationWriteEffects,
  runWithEffectPlan,
} from "./effect-gate.ts";
import { isInternalName, resolveWorkspacePath } from "./paths.ts";
import type { NewRecord, SessionLog } from "./session-log.ts";
import {
  availableExplicitUserRootNamesCandidates,
  assertContractAccess,
  type ContractAccessRequest,
  type ContractReadAuthority,
  getContractReadAuthority,
  lookupApprovedContractIdentity,
  taskContractState,
} from "./task-contract.ts";
import type { EffectIntent } from "./tools.ts";
import { turnAccessBinding } from "./turn-access.ts";

export interface ToolAccessContext {
  readonly db: DatabaseSync;
  readonly log: SessionLog;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly stepId?: string;
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
            deliveryScope: { kind: "unresolved", reason: "本轮交付范围记录不可用", clause: "" },
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
/** Publication gate only: a delivery restriction is not a write permission. */
export function assertDeliveryArtifactAllowed(path: string, binding?: TurnAccessBinding): void {
  const ctx = currentToolAccess();
  const effective = ctx?.binding() ?? binding;
  const relativePath = ctx ? relativeResource(ctx, path) : path;
  if (!deliveryScopeAllows(effective?.deliveryScope, relativePath))
    throw new TurnAccessError(
      effective?.deliveryScope?.kind === "unresolved"
        ? `交付范围未明确：${effective.deliveryScope.reason}`
        : "该文件不在本任务允许的交付目录中，未生成交付引用",
    );
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
  if (binding.contractRef) {
    // The live host contract is the one authority ledger. The parser remains a cross-check,
    // not an irrevocable second allowlist after a precise authenticated confirmation.
    const contract = taskContractState({ ...ctx, contractExpected: true });
    if (!contract) throw new TurnAccessError("当前宿主契约不可用");
    const normalized = normalizeAccessPath(relativeResource(ctx, path));
    if (!normalized) throw new TurnAccessError("路径必须是合法的工作区相对路径");
    const mode =
      kind === "file-write" ? "write" : kind === "directory-enumeration" ? "enumerate" : "read";
    if (
      !accessScopeAllows(binding.decision, normalized, mode) &&
      !ctx.db
        .prepare(
          "SELECT 1 FROM session_log WHERE session_id=? AND type='access.scope-crosscheck' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? AND json_extract(data,'$.revision')=? AND json_extract(data,'$.path')=? AND json_extract(data,'$.mode')=? LIMIT 1",
        )
        .get(
          ctx.sessionId,
          ctx.originAgentId,
          ctx.originTurnId,
          contract.revision,
          normalized,
          mode,
        )
    )
      append(ctx, [
        {
          type: "access.scope-crosscheck",
          data: {
            originAgentId: ctx.originAgentId,
            originTurnId: ctx.originTurnId,
            revision: contract.revision,
            path: normalized,
            mode,
            legacyDecision: binding.decision,
            outcome: "host-contract-required",
          },
        },
      ]);
    return normalized;
  }
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
        : binding.decision.kind === "split"
          ? "本轮读写范围独立；该路径不在允许的读取范围或输出目录中，该操作未执行。"
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
/** Pure contract check. It never resolves or reads the target resource. */
export function assertToolContractAccess(
  request: ContractAccessRequest,
  workspaceRoot?: string,
): void {
  const ctx = currentToolAccess();
  if (!ctx) return;
  if (workspaceRoot !== undefined && resolve(workspaceRoot) !== resolve(ctx.workspaceRoot))
    throw new TurnAccessError("路径不属于当前任务的工作区");
  try {
    assertContractAccess(
      { ...ctx, contractExpected: ctx.binding().contractRef !== undefined },
      {
        ...request,
        path: relativeResource(ctx, request.path),
        ...(request.to !== undefined ? { to: relativeResource(ctx, request.to) } : {}),
      },
    );
  } catch (error) {
    throw new TurnAccessError(error instanceof Error ? error.message : "任务契约未授权此操作");
  }
}
export function assertToolReadAccess(
  path: string,
  kind: Exclude<AccessKind, "file-write">,
  workspaceRoot?: string,
  scope: Pick<ContractAccessRequest, "sheetId" | "range" | "objectId" | "expectedRevision"> = {},
): string {
  return assertAccess(path, workspaceRoot, kind, scope);
}
function readOperation(kind: AccessKind): ContractOperation {
  return kind === "directory-enumeration"
    ? "enumerate"
    : kind === "file-metadata"
      ? "read-metadata"
      : "read-content";
}

/** Pure pre-resolution guard. The resolver calls it before any target metadata I/O. */
export function assertToolAccess(path: string, workspaceRoot?: string): string {
  return assertAccess(path, workspaceRoot, "file-metadata");
}
export function assertToolWriteAccess(
  path: string,
  workspaceRoot?: string,
  operation: EffectIntent["kind"] = "mutate",
): string {
  const result = assertAccess(path, workspaceRoot, "file-write");
  const root =
    workspaceRoot ?? currentToolAccess()?.workspaceRoot ?? currentHostNativeAccess()?.workspaceRoot;
  if (root) assertPlannedOperation(path, operation, root);
  assertToolEffectsAllowed(
    root
      ? (publicationWriteEffects(path, operation, root) ?? [{ kind: operation, path }])
      : [{ kind: operation, path }],
    workspaceRoot,
  );
  return result;
}
/** Host resolver only: a plan grants path-chain validation, not business metadata. */
export function assertToolPathAccess(path: string, workspaceRoot?: string): string {
  const ctx = currentToolAccess();
  if (!ctx) return path;
  try {
    if (!hasPlannedPath(path, workspaceRoot ?? ctx.workspaceRoot))
      assertToolContractAccess({ operation: "read-metadata", path }, workspaceRoot);
    return checkedPath(ctx, path, workspaceRoot, "file-metadata");
  } catch (error) {
    append(ctx, [
      {
        type: "access.fact",
        data: fact(
          ctx,
          { kind: "file-metadata", path, purpose: "path-rejected" },
          randomUUID(),
          "rejected-before-access",
        ),
      },
    ]);
    throw error;
  }
}

function throwDeniedEffect(result: ReturnType<typeof evaluateDeniedEffects>): void {
  if (result.allowed) return;
  throw new TurnAccessError(
    result.provenance === "user"
      ? `用户已拒绝本任务对 ${result.path} 的删除或替换；不得通过移动、重建或其他工具绕过（${result.approvalId}）。当前不支持在同任务解除该拒绝，请停止相关操作并向用户说明；模型不得自行创建新任务绕过。`
      : `旧审批 ${result.approvalId} 的拒绝来源无法确认；对 ${result.path} 的相关写操作未执行。请向用户说明当前任务不能安全接续，不得由模型自行创建新任务绕过。`,
  );
}

/** Pure path fence first; only permitted paths may proceed to canonical identity lookup. */
export function assertToolEffectsAllowed(
  effects: readonly EffectIntent[],
  workspaceRoot?: string,
  options: { physical?: boolean } = {},
): void {
  const ctx = currentToolAccess();
  if (!ctx || !effects.length) return;
  if (workspaceRoot !== undefined && resolve(workspaceRoot) !== resolve(ctx.workspaceRoot))
    throw new TurnAccessError("路径不属于当前任务的工作区");
  const normalized = effects.map((effect) => ({
    ...effect,
    path: checkedPath(ctx, relativeResource(ctx, effect.path), workspaceRoot, "file-write"),
    ...(effect.to !== undefined
      ? { to: checkedPath(ctx, relativeResource(ctx, effect.to), workspaceRoot, "file-write") }
      : {}),
  }));
  // Check the complete set before any canonical lookup can touch target metadata.
  for (const effect of normalized)
    assertToolContractAccess(
      {
        operation: effect.kind,
        path: effect.path,
        to: effect.to,
        sheetId: effect.sheetId,
        range: effect.range,
        objectId: effect.objectId,
      },
      workspaceRoot,
    );
  const binding = ctx.binding();
  const fences = taskDeniedEffects(
    ctx.db,
    ctx.sessionId,
    binding.originAgentId,
    binding.originTurnId,
  );
  if (!fences.length) return;
  throwDeniedEffect(evaluateDeniedEffects(fences, normalized));
  if (options.physical === false) return;
  // Inspect permitted path components without following a symlink into a denied
  // canonical target. Read-only operations retain their existing behavior.
  for (const effect of normalized) {
    checkPhysicalAccess(ctx, effect.path, "file-write");
    if (effect.to !== undefined) checkPhysicalAccess(ctx, effect.to, "file-write");
  }
  const captured = captureEffects(normalized, ctx.workspaceRoot);
  // Canonical aliases and physical identity supplement, never replace, the location fence.
  throwDeniedEffect(evaluateDeniedEffects(fences, captured));
}

function captureEffects(
  effects: readonly EffectIntent[],
  workspaceRoot: string,
): CapturedEffectIntent[] {
  return effects.map((effect) => {
    const path = resolveWorkspacePath(workspaceRoot, effect.path);
    const to =
      effect.to === undefined ? undefined : resolveWorkspacePath(workspaceRoot, effect.to).rel;
    // Host-only alias/fence metadata after the complete logical write check and safe path walk.
    // No bytes, listing, or business metadata is exposed; this is not a read-grant callback.
    const identity = (() => {
      try {
        const stat = lstatSync(path.abs, { bigint: true });
        if (stat.isSymbolicLink()) throw new TurnAccessError("不能以符号链接目标授权文件效果");
        return {
          dev: String(stat.dev),
          ino: String(stat.ino),
          birthtimeMs: String(stat.birthtimeNs),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    })();
    return {
      ...effect,
      path: path.rel,
      ...(to !== undefined ? { to } : {}),
      ...(identity ? { identity } : {}),
    };
  });
}

/** Called only by host approval request preparation, after the same write/denial guard. */
export function captureApprovalEffects(
  effects: readonly EffectIntent[],
  workspaceRoot: string,
): CapturedEffectIntent[] {
  for (const effect of effects) {
    assertAccess(effect.path, workspaceRoot, "file-write");
    if (effect.to !== undefined) assertAccess(effect.to, workspaceRoot, "file-write");
  }
  assertToolEffectsAllowed(effects, workspaceRoot);
  return captureEffects(effects, workspaceRoot);
}
function assertAccess(
  path: string,
  workspaceRoot: string | undefined,
  kind: AccessKind,
  scope: Pick<ContractAccessRequest, "sheetId" | "range" | "objectId" | "expectedRevision"> = {},
): string {
  const ctx = currentToolAccess();
  if (!ctx) return path;
  try {
    if (kind !== "file-write")
      assertToolContractAccess({ operation: readOperation(kind), path, ...scope }, workspaceRoot);
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
  if (!ctx || ctx.binding().decision.kind !== "unbounded" || ctx.binding().contractRef) return;
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
function checkPhysicalAccess(
  ctx: ToolAccessContext,
  path: string,
  kind: AccessKind = "file-metadata",
): void {
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
      if (missing) {
        if (kind === "file-write")
          assertToolContractAccess({ operation: "create", path: rel }, ctx.workspaceRoot);
        if (
          kind === "file-write" &&
          !ctx.binding().contractRef &&
          !accessScopeAllows(ctx.binding().decision, rel, "write")
        ) {
          append(ctx, [
            {
              type: "access.fact",
              data: fact(
                ctx,
                { kind: "file-write", path: rel, purpose: "parent-write-rejected" },
                randomUUID(),
                "rejected-before-access",
              ),
            },
          ]);
          throw new TurnAccessError("输出目录之外的必要父目录不存在，不能通过递归创建扩大写入范围");
        }
        return;
      }
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
  if (!ctx || (ctx.binding().decision.kind === "unbounded" && !ctx.binding().contractRef)) return;
  const normalized = assertToolPathAccess(path, workspaceRoot);
  checkPhysicalAccess(ctx, normalized);
}
export interface AccessSpec {
  kind: AccessKind;
  /** Concrete host operation, never inferred from purpose. Defaults to legacy mutate. */
  effect?: EffectIntent["kind"];
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
  verifiedRead = false,
): { ctx: ToolAccessContext; spec: AccessSpec; operationId: string } | undefined {
  const ctx = currentToolAccess();
  const nativeRoot = currentHostNativeAccess()?.workspaceRoot;
  if (!ctx && nativeRoot)
    assertHostNativeStorage(
      spec.path,
      spec.kind === "file-write" ? (spec.effect ?? "mutate") : readOperation(spec.kind),
      nativeRoot,
    );
  if (spec.kind === "file-write") {
    const root = ctx?.workspaceRoot ?? currentHostNativeAccess()?.workspaceRoot;
    if (!root) throw new TurnAccessError("写入缺少可信任务或原生授权归属");
    assertPlannedOperation(spec.path, spec.effect ?? "mutate", root);
  }
  if (!ctx) return;
  const operationId = randomUUID();
  let path = spec.path;
  try {
    if (spec.kind === "file-write")
      assertToolEffectsAllowed(
        publicationWriteEffects(spec.path, spec.effect ?? "mutate", ctx.workspaceRoot) ?? [
          { kind: spec.effect ?? "mutate", path: spec.path },
        ],
        ctx.workspaceRoot,
      );
    else {
      const operation = readOperation(spec.kind);
      assertToolContractAccess({ operation, path: spec.path }, ctx.workspaceRoot);
      if (operation === "read-content" || operation === "read-metadata") {
        const authority = getContractReadAuthority(
          { ...ctx, contractExpected: ctx.binding().contractRef !== undefined },
          { operation, path: relativeResource(ctx, spec.path) },
        );
        if (authority.kind !== "explicit" && !verifiedRead)
          throw new TurnAccessError(
            "needs_confirmation：身份绑定资源必须经同一文件描述符核验读取，旧路径回调不可授信",
          );
      }
    }
    if (ctx.binding().decision.kind === "unbounded" && !ctx.binding().contractRef) {
      markUnscopedAccess();
      return;
    }
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
  checkPhysicalAccess(ctx, path, spec.kind);
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
  return withResourceAccessSync(spec, action, false);
}
function withResourceAccessSync<T>(spec: AccessSpec, action: () => T, verifiedRead: boolean): T {
  const state = begin(spec, verifiedRead);
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
/** Exact root names only; never opens children or grants content/metadata authority. */
export function listWorkspaceRootNamesSync(workspaceRoot: string): string[] {
  const ctx = currentToolAccess();
  if (!ctx || !ctx.binding().contractRef || resolve(workspaceRoot) !== resolve(ctx.workspaceRoot))
    throw new TurnAccessError("根目录名称枚举需要当前任务契约");
  const receipt = lookupApprovedContractIdentity(
    { ...ctx, contractExpected: true }, { operation: "enumerate", path: "." },
  );
  const approvedIdentity = receipt?.identity;
  const hostIntent = !receipt && availableExplicitUserRootNamesCandidates({...ctx,includeActive:true}).length === 1;
  if (!approvedIdentity?.exists && !hostIntent)
    throw new TurnAccessError("needs_confirmation：根目录枚举需要用户明确指令或真实授权确认");
  const workspace = ctx.db.prepare("SELECT w.path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?")
    .get(ctx.sessionId) as {path:string}|undefined;
  if (!workspace || resolve(workspace.path) !== resolve(workspaceRoot))
    throw new TurnAccessError("根目录枚举不属于当前会话的工作区");
  return withFileAccessSync({ kind: "directory-enumeration", path: workspaceRoot, purpose: "root-names-only" }, () => {
    // The authenticated user's current workspace is host-owned scope. Capture
    // only its directory identity for this names-only operation, not its children.
    const before = lstatSync(workspaceRoot, {bigint:true});
    const identity = approvedIdentity?.exists ? approvedIdentity : {
      device:String(before.dev),inode:String(before.ino),size:String(before.size),
      mtime:String(before.mtimeNs),ctime:String(before.ctimeNs),
    };
    const check = () => {
      const st = lstatSync(workspaceRoot, { bigint: true });
      if (!st.isDirectory() || st.isSymbolicLink() ||
          String(st.dev) !== identity.device || String(st.ino) !== identity.inode ||
          String(st.size) !== identity.size || String(st.mtimeNs) !== identity.mtime ||
          String(st.ctimeNs) !== identity.ctime)
        throw new TurnAccessError("needs_confirmation：工作区根目录身份已变化");
    };
    check();
    const names = readdirSync(workspaceRoot).filter(name => !isInternalName(name)).sort();
    check();
    return names;
  });
}

export interface ExpectedPhysicalIdentity {
  kind: "file";
  nlink: 1;
  device: string;
  inode: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}
function readResourceSync(
  root: string,
  path: string,
  metadataOnly: boolean,
  details: Omit<AccessSpec, "kind" | "path"> = {},
  expectedPhysical?: ExpectedPhysicalIdentity,
): { bytes: Buffer; stat: Stats } {
  // Host adapters may already have resolved an absolute path. Convert only within this root;
  // the ordinary resolver still rejects arbitrary absolute or escaping model paths.
  if (isAbsolute(path)) {
    const rel = relative(resolve(root), resolve(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new TurnAccessError("读取路径不属于授权工作区");
    path = rel.split(sep).join("/");
  }
  const spec: AccessSpec = {
    ...details,
    kind: metadataOnly ? "file-metadata" : "file-bytes",
    path,
    purpose: details.purpose ?? "verified-resource-read",
  };
  const ctx = currentToolAccess();
  const read = () =>
    withResourceAccessSync(
      spec,
      () => {
        const authority = (): ContractReadAuthority =>
          ctx
            ? getContractReadAuthority(
                { ...ctx, contractExpected: ctx.binding().contractRef !== undefined },
                {
                  operation: metadataOnly ? "read-metadata" : "read-content",
                  path: relativeResource(ctx, path),
                },
              )
            : { kind: "explicit" };
        const readAuthority = authority();
        const { abs } = resolveWorkspacePath(root, path);
        let fd: number | undefined;
        try {
          fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
          const before = fstatSync(fd);
          const beforeExact = fstatSync(fd, { bigint: true });
          const physicalMatches = (st: typeof beforeExact) =>
            !expectedPhysical ||
            (expectedPhysical.kind === "file" &&
              expectedPhysical.nlink === 1 &&
              Number.isSafeInteger(expectedPhysical.size) &&
              expectedPhysical.size >= 0 &&
              [
                expectedPhysical.device,
                expectedPhysical.inode,
                expectedPhysical.mtimeNs,
                expectedPhysical.ctimeNs,
              ].every((value) => typeof value === "string" && /^\d+$/.test(value)) &&
              st.isFile() &&
              st.nlink === 1n &&
              String(st.dev) === expectedPhysical.device &&
              String(st.ino) === expectedPhysical.inode &&
              st.size === BigInt(expectedPhysical.size) &&
              String(st.mtimeNs) === expectedPhysical.mtimeNs &&
              String(st.ctimeNs) === expectedPhysical.ctimeNs);
          if (!physicalMatches(beforeExact))
            throw new TurnAccessError("needs_confirmation：读取不匹配原始创建物理锚");
          const proof = readAuthority.kind !== "explicit" ? readAuthority.proof : undefined;
          const metadataProof =
            readAuthority.kind === "metadata-bound" ? readAuthority.proof : undefined;
          const identityMatches = (st: typeof beforeExact) =>
            (st.isFile() || (metadataOnly && !proof && st.isDirectory())) &&
            st.dev === beforeExact.dev &&
            st.ino === beforeExact.ino &&
            st.size === beforeExact.size &&
            st.mtimeNs === beforeExact.mtimeNs &&
            st.ctimeNs === beforeExact.ctimeNs &&
            (!proof || st.nlink === 1n);
          if (
            (!before.isFile() && (!metadataOnly || proof || !before.isDirectory())) ||
            (proof &&
              (beforeExact.nlink !== 1n ||
                String(beforeExact.dev) !== proof.device ||
                String(beforeExact.ino) !== proof.inode ||
                before.size !== proof.size)) ||
            (metadataProof &&
              (String(beforeExact.mtimeNs) !== metadataProof.mtime ||
                String(beforeExact.ctimeNs) !== metadataProof.ctime))
          )
            throw new TurnAccessError("needs_confirmation：文件身份与宿主绑定不一致");
          const bytes =
            !metadataOnly || readAuthority.kind === "identity-bound"
              ? readFileSync(fd)
              : Buffer.alloc(0);
          const after = fstatSync(fd),
            afterExact = fstatSync(fd, { bigint: true }),
            atPath = lstatSync(abs, { bigint: true });
          if (
            !identityMatches(afterExact) ||
            !identityMatches(atPath) ||
            !physicalMatches(afterExact) ||
            !physicalMatches(atPath) ||
            resolveWorkspacePath(root, path).abs !== abs
          )
            throw new TurnAccessError("needs_confirmation：读取期间文件或路径身份发生变化");
          if (
            readAuthority.kind === "identity-bound" &&
            createHash("sha256").update(bytes).digest("hex") !== readAuthority.proof.sha256
          )
            throw new TurnAccessError("needs_confirmation：文件内容不再匹配宿主绑定");
          const current = authority();
          if (JSON.stringify(current) !== JSON.stringify(readAuthority))
            throw new TurnAccessError("needs_confirmation：读取期间宿主身份绑定发生变化");
          return { bytes: metadataOnly ? Buffer.alloc(0) : bytes, stat: after };
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      },
      true,
    );
  if (!ctx && !currentHostNativeAccess()) return read();
  const permit = prepareEffectPlan({
    workspaceRoot: root,
    atomicScope: "none",
    effects: [{ operation: metadataOnly ? "read-metadata" : "read-content", path }],
  });
  return runWithEffectPlan(permit, read);
}
/** Returns only bytes read from the descriptor whose identity/content was checked. */
export function readVerifiedResourceSync(
  root: string,
  path: string,
  details?: Omit<AccessSpec, "kind" | "path">,
  expectedPhysical?: ExpectedPhysicalIdentity,
): { bytes: Buffer } {
  return { bytes: readResourceSync(root, path, false, details, expectedPhysical).bytes };
}
/** Returns bytes and metadata from one guarded descriptor; both read authorities are required. */
export function readVerifiedResourceObservationSync(
  root: string,
  path: string,
  details?: Omit<AccessSpec, "kind" | "path">,
  expectedPhysical?: ExpectedPhysicalIdentity,
): { bytes: Buffer; stat: Stats } {
  if (!currentToolAccess()) throw new TurnAccessError("Verified observation requires an active tool access context");
  assertToolReadAccess(path, "file-metadata", root);
  assertToolReadAccess(path, "file-bytes", root);
  const observation = readResourceSync(root, path, false, details, expectedPhysical);
  assertToolReadAccess(path, "file-metadata", root);
  assertToolReadAccess(path, "file-bytes", root);
  return observation;
}
/** Metadata-only callers never receive the private bytes used to verify a bound identity. */
export function statVerifiedResourceSync(
  root: string,
  path: string,
  details?: Omit<AccessSpec, "kind" | "path">,
): Stats {
  return readResourceSync(root, path, true, details).stat;
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
  const ctx = currentToolAccess();
  if (ctx) {
    const authority = getContractReadAuthority(
      { ...ctx, contractExpected: ctx.binding().contractRef !== undefined },
      { operation: "read-content", path: relativeResource(ctx, spec.path) },
    );
    if (authority.kind !== "explicit") readVerifiedResourceSync(ctx.workspaceRoot, spec.path);
  }
  const state = begin(spec, true);
  finish(state, "succeeded");
}
/** Must surround, not run inside, a host SQLite transaction. Rollback never erases reads. */
export function runWithBufferedAccessFacts<T>(action: () => T): T {
  const ctx = currentToolAccess();
  if (!ctx || ctx.buffer) return action();
  // This helper is the host file-transaction boundary. Persist the one provenance bit before BEGIN.
  if (ctx.binding().decision.kind === "unbounded" && !ctx.binding().contractRef) {
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
export function assertFiniteFileParent(
  path: string,
  operation: EffectIntent["kind"] = "mutate",
  permit?: EffectPermit,
): boolean {
  const ctx = currentToolAccess();
  if (!ctx || (ctx.binding().decision.kind !== "files" && !ctx.binding().contractRef)) return false;
  const target = relativeResource(ctx, path);
  const normalized = permit
    ? runWithEffectPlan(permit, () => {
        assertPlannedOperation(target, operation, ctx.workspaceRoot);
        return checkedPath(ctx, target, ctx.workspaceRoot, "file-write");
      })
    : assertToolWriteAccess(target, ctx.workspaceRoot, operation);
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
