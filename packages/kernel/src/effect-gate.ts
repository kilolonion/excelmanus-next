import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pendingContractIdentityWrites } from "./contract-identity-recovery.ts";
import { isCurrentIdentityPublicationContinuation } from "./backup.ts";
import { getContractAtomicRequirement, taskContractState, type ContractAccessRequest } from "./task-contract.ts";
import { normalizeAccessPath } from "./access-scope.ts";
import { isInternalName, PathSafetyError, resolveWorkspacePath } from "./paths.ts";
import {
  assertToolContractAccess, assertToolEffectsAllowed, assertToolReadAccess,
  canonicalWorkspaceRoot, currentToolAccess, type ToolAccessContext, TurnAccessError,
} from "./tool-access.ts";
import type { EffectIntent } from "./tools.ts";

export type EffectAtomicScope = "single-resource" | "file-batch" | "none";
export interface EffectPlan {
  workspaceRoot: string;
  effects: readonly ContractAccessRequest[];
  atomicScope: EffectAtomicScope;
  requestedAtomicScope?: EffectAtomicScope;
  signal?: AbortSignal;
}
export interface HostNativeAuthority {
  db: DatabaseSync;
  workspaceId: string;
  workspaceRoot: string;
  operationId: string;
}
interface Prepared {
  permit: EffectPermit;
  plan: EffectPlan;
  access?: ToolAccessContext;
  native?: HostNativeAuthority;
}
/** Opaque host object: only this module's WeakMap can establish a permit. */
export interface EffectPermit { readonly effectPermit: unique symbol }
const prepared = new WeakMap<object, Prepared>();
const active = new AsyncLocalStorage<EffectPermit>();
const native = new AsyncLocalStorage<HostNativeAuthority>();
interface NativeCheckpoint {
  owner: object; db: DatabaseSync; workspaceId: string; workspaceRoot: string; operationId: string; docId: string;
  revision: number; path: string; preimageHash: string;
}
const nativeStates = new WeakMap<HostNativeAuthority, { active: boolean; checkpoint?: NativeCheckpoint }>();
export interface HostNativeCheckpoint { readonly hostNativeCheckpoint: unique symbol }
const nativeCheckpoints = new WeakMap<object, NativeCheckpoint & { consumed: boolean }>();

/** Trusted DocumentService issuer after validating its complete committed native journal chain. */
export function issueHostNativeCheckpoint(input: NativeCheckpoint): HostNativeCheckpoint {
  if (currentToolAccess() || !input.owner || !input.operationId || !input.docId ||
      !Number.isSafeInteger(input.revision) || input.revision < 1 || !/^[a-f0-9]{64}$/.test(input.preimageHash))
    throw new TurnAccessError("原生检查点缺少可信已提交文档归属");
  const root = resolve(input.workspaceRoot);
  const token = Object.freeze({}) as HostNativeCheckpoint;
  nativeCheckpoints.set(token, { ...input, workspaceRoot: root, path: pathOf(root, input.path), consumed: false });
  return token;
}

/** Only the fixed document checkpoint path consumes this one-use capability, never a tool. */
export function runWithHostNativeCheckpoint<T>(token: HostNativeCheckpoint,
  input: { owner: object; docId: string; revision: number; preimageHash: string }, action: () => T): T {
  const proof = nativeCheckpoints.get(token);
  if (!proof || proof.consumed || currentToolAccess() || proof.owner !== input.owner ||
      proof.docId !== input.docId || proof.revision !== input.revision || proof.preimageHash !== input.preimageHash)
    throw new TurnAccessError("原生检查点续接归属、修订或前像失效");
  proof.consumed = true;
  return active.exit(() => runNative({ db: proof.db, workspaceId: proof.workspaceId,
    workspaceRoot: proof.workspaceRoot, operationId: proof.operationId }, action, proof));
}
function assertNativeWorkspace(authority: HostNativeAuthority): void {
  if (!authority.db || !authority.workspaceId) throw new TurnAccessError("原生操作缺少宿主数据库和工作区归属");
  const row = authority.db.prepare("SELECT path FROM workspaces WHERE id=?").get(authority.workspaceId) as { path: string } | undefined;
  if (!row || canonicalWorkspaceRoot(row.path) !== canonicalWorkspaceRoot(authority.workspaceRoot))
    throw new TurnAccessError("原生数据库、工作区与根目录不一致");
}
function runNative<T>(authority: HostNativeAuthority, action: () => T, checkpoint?: NativeCheckpoint): T {
  assertNativeWorkspace(authority);
  const value = Object.freeze({ ...authority, workspaceRoot: resolve(authority.workspaceRoot) });
  const state = { active: true, checkpoint };
  nativeStates.set(value, state);
  try {
    const result = native.run(value, action);
    if (result && typeof (result as { then?: unknown }).then === "function")
      return Promise.resolve(result).finally(() => { state.active = false; }) as T;
    state.active = false;
    return result;
  } catch (error) { state.active = false; throw error; }
}
export function currentHostNativeCheckpoint(): Readonly<Omit<NativeCheckpoint, "owner">> | undefined {
  const authority = currentHostNativeAccess();
  return authority ? nativeStates.get(authority)?.checkpoint : undefined;
}
/** Last storage boundary: checkpoint authority cannot become an arbitrary read/write callback. */
export function assertHostNativeStorage(path: string, operation: string, root: string): void {
  const checkpoint = currentHostNativeCheckpoint();
  if (!checkpoint) return;
  if (resolve(root) !== checkpoint.workspaceRoot || pathOf(root, path) !== checkpoint.path ||
      !["read-content", "read-metadata", "mutate"].includes(operation))
    throw new TurnAccessError("原生续接仅限原文档的既有检查点保存");
  if (operation === "mutate" && !publicationWriteEffects(path, "mutate", root))
    throw new TurnAccessError("原生检查点写入必须消费精确序列化字节证明");
}
export interface EffectPublication { readonly effectPublication: unique symbol }
interface Publication {
  permit: EffectPermit; path: string; resourceId: string; revision: number;
  preimageSha256: string; bytesSha256: string; contractRevision?: number; consumed: boolean;
  open: boolean; active: boolean; storageSteps: Set<string>;
}
const publications = new WeakMap<object, Publication>();
const publishing = new AsyncLocalStorage<Publication>();
const byteHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/**
 * Trusted host issuer only. Production caller: DocumentService's private checkpoint path,
 * after compiling, verifying actual mutations and validating the serialized workbook.
 * Never expose this function or its arguments through a tool/SDK schema.
 */
export function issueEffectPublication(permit: EffectPermit, input: {
  path: string; resourceId: string; revision: number; preimageSha256: string; bytes: Uint8Array;
}): EffectPublication {
  recheckEffectPlan(permit);
  const state = prepared.get(permit)!;
  const path = pathOf(state.plan.workspaceRoot, input.path);
  if (!input.resourceId || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(input.preimageSha256) ||
      !state.plan.effects.some((effect) => effect.path === path && effect.operation === "mutate") ||
      state.plan.effects.some((effect) => isWrite(effect.operation) && effect.path !== path))
    throw new TurnAccessError("检查点发布证明缺少精确文档/修订/前像");
  const access = currentToolAccess();
  const contractRevision = access ? taskContractState({ ...access, contractExpected: !!access.binding().contractRef })?.revision : undefined;
  const checkpoint = currentHostNativeCheckpoint();
  if (checkpoint && (checkpoint.docId !== input.resourceId || checkpoint.revision !== input.revision ||
      checkpoint.preimageHash !== input.preimageSha256 || checkpoint.path !== path))
    throw new TurnAccessError("原生检查点字节证明与已提交修订不匹配");
  const token = Object.freeze({}) as EffectPublication;
  publications.set(token, { permit, path, resourceId: input.resourceId, revision: input.revision,
    preimageSha256: input.preimageSha256, bytesSha256: byteHash(input.bytes), contractRevision, consumed: false, open: false, active: false, storageSteps: new Set() });
  return token;
}
/** A ticket is consumed once even if publication fails; retries must regenerate and revalidate. */
export function consumeEffectPublication<T>(token: EffectPublication, input: {
  root: string; path: string; resourceId: string; revision: number; expected: string | null; bytes: Uint8Array;
}, action: (permit: EffectPermit) => T): T {
  const proof = publications.get(token);
  if (!proof || proof.consumed) throw new TurnAccessError("检查点发布证明无效或已消费");
  const state = prepared.get(proof.permit);
  if (!state || resolve(input.root) !== state.plan.workspaceRoot ||
      pathOf(input.root, input.path) !== proof.path || input.resourceId !== proof.resourceId ||
      input.revision !== proof.revision || input.expected !== proof.preimageSha256 ||
      byteHash(input.bytes) !== proof.bytesSha256)
    throw new TurnAccessError("检查点发布字节、资源、修订或前像不匹配");
  recheckEffectPlan(proof.permit);
  const access = currentToolAccess();
  const revision = access ? taskContractState({ ...access, contractExpected: !!access.binding().contractRef })?.revision : undefined;
  if (revision !== proof.contractRevision) throw new TurnAccessError("检查点发布后的授权修订已变化");
  proof.consumed = true;
  proof.open = true;
  try { return action(proof.permit); }
  finally { proof.open = false; }
}
/** Only atomicWrite's fixed synchronous parent-mkdir and rename closures call this. */
export function withEffectPublicationStorage<T>(token: EffectPublication, input: {
  root: string; path: string; resourceId: string; revision: number; expected: string | null; bytes: Uint8Array;
}, step: "parents" | "publish", action: () => T): T {
  const proof = publications.get(token);
  const state = proof ? prepared.get(proof.permit) : undefined;
  if (!proof || !state || !proof.consumed || !proof.open || proof.active || proof.storageSteps.has(step) ||
      resolve(input.root) !== state.plan.workspaceRoot || pathOf(input.root, input.path) !== proof.path ||
      input.resourceId !== proof.resourceId || input.revision !== proof.revision ||
      input.expected !== proof.preimageSha256 || byteHash(input.bytes) !== proof.bytesSha256)
    throw new TurnAccessError("检查点存储操作不是当前一次性绑定字节");
  recheckEffectPlan(proof.permit);
  const access = currentToolAccess();
  const revision = access ? taskContractState({ ...access, contractExpected: !!access.binding().contractRef })?.revision : undefined;
  if (revision !== proof.contractRevision) throw new TurnAccessError("检查点发布授权修订已变化");
  proof.storageSteps.add(step);
  proof.active = true;
  try { return publishing.run(proof, action); }
  finally { proof.active = false; }
}
/** Storage adapters consume only the exact actor-issued publication currently in progress. */
export function publicationWriteEffects(path: string, operation: EffectIntent["kind"], root: string): EffectIntent[] | undefined {
  const proof = publishing.getStore();
  if (!proof) return undefined;
  if (!proof.active || !proof.open) throw new TurnAccessError("检查点存储授权已经离开同步边界");
  const state = prepared.get(proof.permit);
  if (!state || operation !== "mutate" || resolve(root) !== state.plan.workspaceRoot ||
      pathOf(root, path) !== proof.path) throw new TurnAccessError("不能借检查点证明写入其他资源");
  recheckEffectPlan(proof.permit);
  return state.plan.effects.filter((effect) => effect.operation === operation && effect.path === proof.path)
    .map((effect) => ({ kind: operation, path: effect.path, sheetId: effect.sheetId, range: effect.range, objectId: effect.objectId }));
}

/** Only authenticated native ingress calls this; it is not a model/tool argument. */
export function runWithHostNativeAccess<T>(authority: HostNativeAuthority, action: () => T): T {
  if (currentToolAccess()) throw new TurnAccessError("任务操作不能切换为用户原生授权");
  if (!authority.operationId || !authority.workspaceRoot)
    throw new TurnAccessError("原生操作缺少已认证归属");
  return runNative(authority, action);
}
export function currentHostNativeAccess(): HostNativeAuthority | undefined {
  const authority = native.getStore();
  return authority && nativeStates.get(authority)?.active ? authority : undefined;
}
function pathOf(root: string, value: string): string {
  let path = value;
  if (isAbsolute(path)) {
    path = relative(root, resolve(path));
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new PathSafetyError("OUT_OF_WORKSPACE", "效果路径不属于授权工作区");
    path = path.split(sep).join("/");
  }
  const normalized = normalizeAccessPath(path);
  if (!normalized) throw new PathSafetyError("OUT_OF_WORKSPACE", "效果路径不合法或越出工作区");
  if (normalized.split("/").some(isInternalName)) throw new PathSafetyError("NOT_FOUND", "路径不存在");
  return normalized;
}
const isWrite = (operation: string): operation is EffectIntent["kind"] =>
  ["create", "mutate", "remove", "relocate"].includes(operation);
function check(state: Prepared, physical = true): void {
  const { plan } = state;
  plan.signal?.throwIfAborted();
  const access = currentToolAccess();
  if (state.access) {
    if (!access || access.db !== state.access.db || access.sessionId !== state.access.sessionId ||
        access.originAgentId !== state.access.originAgentId ||
        access.originTurnId !== state.access.originTurnId ||
        resolve(access.workspaceRoot) !== plan.workspaceRoot)
      throw new TurnAccessError("效果计划不能跨任务授权归属使用");
  } else if (!state.native || currentHostNativeAccess() !== state.native || access) {
    throw new TurnAccessError("效果计划缺少当前可信授权归属");
  }
  if (state.native) assertNativeWorkspace(state.native);
  const checkpoint = state.native ? nativeStates.get(state.native)?.checkpoint : undefined;
  if (checkpoint && plan.effects.some((effect) => effect.path !== checkpoint.path ||
      !["mutate", "read-content", "read-metadata"].includes(effect.operation) ||
      effect.to !== undefined || effect.sheetId !== undefined || effect.range !== undefined || effect.objectId !== undefined))
    throw new TurnAccessError("原生检查点续接不能扩展到其他资源或操作");
  if (access) {
    let required: EffectAtomicScope;
    try { required = getContractAtomicRequirement({ ...access, contractExpected: access.binding().contractRef !== undefined }, plan.effects); }
    catch (error) { throw new TurnAccessError(error instanceof Error ? error.message : "契约原子范围不可用"); }
    if ((required !== "none" && plan.atomicScope === "none") ||
        (required === "file-batch" && plan.atomicScope !== "file-batch"))
      throw new TurnAccessError("当前执行路径不支持契约要求的原子范围");
  }
  // All pure contract checks precede the legacy canonical/identity fence's metadata lookup.
  for (const effect of plan.effects) assertToolContractAccess(effect, plan.workspaceRoot);
  for (const effect of plan.effects) {
    if (effect.operation === "read-content") assertToolReadAccess(effect.path, "file-bytes", plan.workspaceRoot, effect);
    else if (effect.operation === "read-metadata") assertToolReadAccess(effect.path, "file-metadata", plan.workspaceRoot, effect);
    else if (effect.operation === "enumerate") assertToolReadAccess(effect.path, "directory-enumeration", plan.workspaceRoot, effect);
  }
  const writes = plan.effects.filter(effect => isWrite(effect.operation));
  const intents = plan.effects.flatMap((effect): EffectIntent[] =>
    isWrite(effect.operation) ? [{ kind: effect.operation, path: effect.path,
      ...(effect.to ? { to: effect.to } : {}),
      ...(effect.sheetId !== undefined ? { sheetId: effect.sheetId } : {}),
      ...(effect.range !== undefined ? { range: effect.range } : {}),
      ...(effect.objectId !== undefined ? { objectId: effect.objectId } : {}),
    }] : []);
  // User denials are checked before pending-state diagnostics, with no filesystem lookup.
  assertToolEffectsAllowed(intents, plan.workspaceRoot, { physical: false });
  if (writes.length) {
    const db = access?.db ?? state.native!.db;
    const workspaceId = access
      ? (db.prepare("SELECT workspace_id FROM sessions WHERE id=?").get(access.sessionId) as { workspace_id: string } | undefined)?.workspace_id
      : state.native!.workspaceId;
    if (!workspaceId) throw new TurnAccessError("写入缺少持久工作区归属");
    const touched = writes.flatMap(effect => [effect.path, ...(effect.to ? [effect.to] : [])]);
    for (const pending of pendingContractIdentityWrites(db, workspaceId)) {
      const overlaps = pending.paths.some(path => touched.some(target => target === path ||
        target === "." || path.startsWith(target + "/") || target.startsWith(path + "/")));
      if (overlaps && !isCurrentIdentityPublicationContinuation(state.permit, db, pending, physical))
        throw new TurnAccessError("needs_confirmation：资源存在未决的身份发布，材料已保留；当前不能开始另一写入");
    }
  }
  if (physical) assertToolEffectsAllowed(intents, plan.workspaceRoot, { physical: true });
}

export function prepareEffectPlan(input: EffectPlan): EffectPermit {
  const access = currentToolAccess();
  const host = currentHostNativeAccess();
  if (!access && !host) throw new TurnAccessError("效果计划缺少可信授权归属");
  const root = resolve(input.workspaceRoot);
  if (root !== resolve(access?.workspaceRoot ?? host!.workspaceRoot))
    throw new TurnAccessError("效果计划不属于授权工作区");
  const requested = input.requestedAtomicScope ?? "none";
  if ((requested !== "none" && input.atomicScope === "none") ||
      (requested === "file-batch" && input.atomicScope !== "file-batch"))
    throw new TurnAccessError("当前执行路径不支持所要求的原子范围");
  const effects = input.effects.map((effect) => Object.freeze({
    ...effect, path: pathOf(root, effect.path),
    ...(effect.to !== undefined ? { to: pathOf(root, effect.to) } : {}),
  }));
  const parentPermit = active.getStore();
  const parent = parentPermit ? prepared.get(parentPermit) : undefined;
  if (parent && effects.some((effect) => !parent.plan.effects.some((allowed) =>
    allowed.operation === effect.operation && allowed.path === effect.path && allowed.to === effect.to &&
    allowed.sheetId === effect.sheetId && allowed.range === effect.range &&
    allowed.objectId === effect.objectId && allowed.expectedRevision === effect.expectedRevision)))
    throw new TurnAccessError("子效果计划不能扩大当前完整计划");
  const resources = new Set(effects.filter((effect) => isWrite(effect.operation)).flatMap((effect) =>
    [effect.path, ...(effect.to ? [effect.to] : [])]));
  if (input.atomicScope === "single-resource" && resources.size > 1)
    throw new TurnAccessError("单资源原子计划不能包含多个写入资源");
  const plan = Object.freeze({ ...input, workspaceRoot: root, effects: Object.freeze(effects) });
  const permit = Object.freeze({}) as EffectPermit;
  const state: Prepared = { permit, plan, access, native: access ? undefined : host };
  prepared.set(permit, state);
  try { active.run(permit, () => check(state)); }
  catch (error) { prepared.delete(permit); throw error; }
  return permit;
}
export function recheckEffectPlan(permit: EffectPermit): void {
  const state = prepared.get(permit);
  if (!state) throw new TurnAccessError("效果许可不是宿主创建的当前计划");
  const parentPermit = active.getStore();
  const parent = parentPermit && parentPermit !== permit ? prepared.get(parentPermit) : undefined;
  if (parent && state.plan.effects.some((effect) => !parent.plan.effects.some((allowed) =>
    allowed.operation === effect.operation && allowed.path === effect.path && allowed.to === effect.to &&
    allowed.sheetId === effect.sheetId && allowed.range === effect.range &&
    allowed.objectId === effect.objectId && allowed.expectedRevision === effect.expectedRevision)))
    throw new TurnAccessError("已准备的许可不能扩大当前完整计划");
  active.run(permit, () => check(state));
}
export function runWithEffectPlan<T>(permit: EffectPermit, action: () => T): T {
  recheckEffectPlan(permit);
  return active.run(permit, action);
}
export function assertPlannedEffect(effect: ContractAccessRequest, root: string): void {
  const permit = active.getStore(), state = permit ? prepared.get(permit) : undefined;
  if (!permit || !state || state.plan.workspaceRoot !== resolve(root))
    throw new TurnAccessError("操作缺少当前完整效果计划");
  const path = pathOf(root, effect.path), to = effect.to === undefined ? undefined : pathOf(root, effect.to);
  if (!state.plan.effects.some((allowed) => allowed.operation === effect.operation && allowed.path === path &&
      allowed.to === to && allowed.sheetId === effect.sheetId && allowed.range === effect.range &&
      allowed.objectId === effect.objectId && allowed.expectedRevision === effect.expectedRevision))
    throw new TurnAccessError("预登记动作与完整效果计划不一致");
}
/** Capture only the current full host operation, before any forward business I/O. */
export function captureEffectPlanForCompensation(root: string): EffectPermit {
  const permit = active.getStore();
  const state = permit ? prepared.get(permit) : undefined;
  if (!permit || !state || resolve(root) !== state.plan.workspaceRoot)
    throw new TurnAccessError("补偿缺少当前完整效果计划");
  recheckEffectPlan(permit);
  return permit;
}
/** Host commit producers inspect the frozen plan without treating a saved preimage as the current file.
 * Logical authority, owner, cancellation and denial remain current. The producer separately verifies exact afterimages.
 */
export function inspectEffectPlanForIdentityCommit(permit: EffectPermit): Readonly<EffectPlan> {
  assertEffectCompensationOwner(permit);
  const state = prepared.get(permit)!;
  check(state, false);
  return state.plan;
}
/** Compensation restores only that operation; newer deny/abort never grants new business effects. */
export function assertEffectCompensationOwner(permit: EffectPermit): void {
  const state = prepared.get(permit), access = currentToolAccess();
  if (!state || active.getStore() !== permit) throw new TurnAccessError("补偿不能离开原操作执行域");
  if (state.access) {
    if (!access || access.db !== state.access.db || access.sessionId !== state.access.sessionId ||
        access.originAgentId !== state.access.originAgentId || access.originTurnId !== state.access.originTurnId ||
        resolve(access.workspaceRoot) !== state.plan.workspaceRoot)
      throw new TurnAccessError("补偿不能跨任务或宿主归属");
  } else if (access || !state.native || currentHostNativeAccess() !== state.native) {
    throw new TurnAccessError("补偿原生操作已失效");
  }
}
/** Only grants necessary path-chain validation, never bytes/hash/list or business metadata. */
export function hasPlannedPath(path: string, root: string): boolean {
  const permit = active.getStore();
  const state = permit ? prepared.get(permit) : undefined;
  if (!state || resolve(root) !== state.plan.workspaceRoot) return false;
  const normalized = pathOf(state.plan.workspaceRoot, path);
  check(state, false);
  return state.plan.effects.some((effect) => effect.path === normalized || effect.to === normalized);
}
/** Non-disclosed collision validation for an already planned resource. */
export function effectPathExists(path: string, root: string): boolean {
  if (!hasPlannedPath(path, root)) throw new TurnAccessError("路径检查缺少当前效果计划");
  const { abs } = resolveWorkspacePath(root, path);
  try { lstatSync(abs); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Lower writes must name their operation; an unrelated active plan cannot authorize them. */
export function assertPlannedOperation(path: string, operation: EffectIntent["kind"], root: string): void {
  const permit = active.getStore();
  if (!permit) return;
  const state = prepared.get(permit);
  if (!state || resolve(root) !== state.plan.workspaceRoot) throw new TurnAccessError("效果许可工作区不匹配");
  recheckEffectPlan(permit);
  const normalized = pathOf(state.plan.workspaceRoot, path);
  const matching = state.plan.effects.some((effect) =>
    (effect.path === normalized && effect.operation === operation) ||
    (effect.operation === "relocate" && ((operation === "remove" && effect.path === normalized) ||
      (operation === "create" && effect.to === normalized))));
  if (!matching) throw new TurnAccessError("当前计划没有该资源的精确写入效果");
}
