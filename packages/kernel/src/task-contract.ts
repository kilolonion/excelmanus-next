import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { posix } from "node:path";
import { z } from "zod";
import { parseRange } from "@excelmanus/core";
import {
  TaskContractProposal,
  TaskContract,
  ContractOperation as ContractOperationSchema,
  type ContractOperation,
  type ContractSourceRef,
  type ContractTarget,
  type TurnAccessBinding,
} from "@excelmanus/protocol";
import { accessScopeAllows, deliveryScopeAllows, deriveUserAccessScope, deriveUserDeliveryScope } from "./access-scope.ts";
import type { SessionLog } from "./session-log.ts";
import { turnAccessBinding } from "./turn-access.ts";
import { lookupHostCreatedOutput } from "./created-output.ts";
import { advanceContractReadIdentity, type ContractIdentityAnchor } from "./contract-identity-recovery.ts";

export interface ContractHostAuthority {
  originTaskId: string;
  revision: number;
  /** Populated only from authenticated ingress, never from a tool argument. */
  sources: {
    dispatchId: string;
    /** Host journal sequence, never proposed by the model. */
    journalSeq?: number;
    text: string;
    origin: "user" | "tool" | "file" | "agent";
    excludedSpans: { start: number; end: number }[];
  }[];
  grants: { operation: ContractOperation; target: ContractTarget }[];
  atomicGroups?: NonNullable<TaskContractProposal["atomicGroups"]>;
  prohibitions: {
    id?: string;
    operation: ContractOperation;
    target: ContractTarget;
    source: ContractSourceRef;
  }[];
  obligations: {
    id: string; requirement: string; required: boolean; source: ContractSourceRef;
  }[];
}

function pathOf(path: string): string {
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") ||
      path.split("/").some((part) => part === "..") || /^[a-z]+:/i.test(path))
    throw new Error("Invalid contract resource path");
  const normalized = posix.normalize(path).replace(/\/$/, "");
  if (!normalized || normalized === ".") throw new Error("Invalid contract resource path");
  return normalized;
}

function regionOf(target: ContractTarget) {
  if (target.range === undefined) return undefined;
  if (!target.sheetId) throw new Error("Contract range requires a physical worksheet identity");
  const raw = target.range.trim();
  const absoluteCells = /^[$]?[A-Za-z]{1,3}[$]?[1-9][0-9]*(?::[$]?[A-Za-z]{1,3}[$]?[1-9][0-9]*)?$/.test(raw);
  const range = parseRange((absoluteCells ? raw.replaceAll("$", "") : raw).toUpperCase());
  if (range.sheet !== undefined) throw new Error("Contract range must use its physical worksheet identity");
  return range;
}

function validateTarget(target: ContractTarget): void {
  if (target.path !== ".") pathOf(target.path);
  else if (target.sheetId !== undefined || target.range !== undefined || target.objectId !== undefined)
    throw new Error("Workspace root cannot select a document region");
  regionOf(target);
}

function covers(outer: ContractTarget, inner: ContractTarget): boolean {
  validateTarget(outer);
  validateTarget(inner);
  const left = outer.path === "." ? "." : pathOf(outer.path);
  const right = inner.path === "." ? "." : pathOf(inner.path);
  if (outer.match === "exact" && (inner.match !== "exact" || left !== right)) return false;
  if (outer.match === "tree" && left !== "." && right !== left && !right.startsWith(left + "/")) return false;
  for (const key of ["sheetId", "objectId"] as const)
    if (outer[key] !== undefined && outer[key] !== inner[key]) return false;
  const a = regionOf(outer);
  const b = regionOf(inner);
  return !a || !!b && a.startRow <= b.startRow && a.endRow >= b.endRow &&
    a.startCol <= b.startCol && a.endCol >= b.endCol;
}

function intersects(left: ContractTarget, right: ContractTarget): boolean {
  validateTarget(left);
  validateTarget(right);
  const aPath = left.path === "." ? "." : pathOf(left.path);
  const bPath = right.path === "." ? "." : pathOf(right.path);
  if (aPath !== bPath &&
      !(left.match === "tree" && (aPath === "." || bPath.startsWith(aPath + "/"))) &&
      !(right.match === "tree" && (bPath === "." || aPath.startsWith(bPath + "/")))) return false;
  for (const key of ["sheetId", "objectId"] as const)
    if (left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]) return false;
  const a = regionOf(left);
  const b = regionOf(right);
  return !a || !b || a.startRow <= b.endRow && b.startRow <= a.endRow &&
    a.startCol <= b.endCol && b.startCol <= a.endCol;
}

/** Shared finite physical-target overlap semantics for contract denial fences. */
export const contractTargetsIntersect = intersects;

function verifySource(ref: ContractSourceRef, authority: ContractHostAuthority): void {
  const source = authority.sources.find((entry) => entry.dispatchId === ref.dispatchId);
  if (!source || source.origin !== "user" || ref.end > source.text.length ||
      source.excludedSpans.some((span) => ref.start < span.end && ref.end > span.start) ||
      createHash("sha256").update(source.text.slice(ref.start, ref.end)).digest("hex") !== ref.sha256)
    throw new Error("Invalid trusted authority source reference");
}

export interface ContractAccessContext {
  db: DatabaseSync;
  sessionId: string;
  originAgentId: string;
  originTurnId: string;
  /** Reconstructed from a trusted binding, never supplied by the model. */
  contractExpected?: boolean;
}
export interface ContractAccessRequest {
  operation: ContractOperation;
  path: string;
  to?: string;
  sheetId?: string;
  range?: string;
  objectId?: string;
  expectedRevision?: number;
}

export function taskContractState(ctx: ContractAccessContext): TaskContract | undefined {
  const rows = ctx.db.prepare(
    "SELECT type,data FROM session_log WHERE session_id=? AND type IN ('contract.expected','contract.updated') AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC"
  ).all(ctx.sessionId, ctx.originAgentId, ctx.originTurnId) as {type: string; data: string}[];
  const expectedRow = rows.find((row) => row.type === "contract.expected");
  if (!expectedRow) {
    if (ctx.contractExpected || rows.length) throw new Error("Contract authority record unavailable");
    return; // Existing pre-contract task only; ingress never uses absence to authorize a new contract task.
  }
  const expected = JSON.parse(expectedRow.data) as {contractId?: unknown; originTaskId?: unknown};
  if (typeof expected.contractId !== "string" || typeof expected.originTaskId !== "string")
    throw new Error("Contract authority record invalid");
  const latestRow = rows[0];
  if (!latestRow || latestRow.type !== "contract.updated")
    throw new Error("Contract proposal is pending; this action is not yet authorized");
  const latest = JSON.parse(latestRow.data) as {contractId?: unknown; contract?: unknown};
  const parsed = TaskContract.safeParse(latest.contract);
  if (latest.contractId !== expected.contractId || !parsed.success ||
      parsed.data.originTaskId !== expected.originTaskId)
    throw new Error("Contract authority state invalid");
  return parsed.data;
}

/** Pending proposal metadata is not authority to read or mutate a resource. */
export function isTaskContractPending(ctx: ContractAccessContext): boolean {
  try {
    taskContractState(ctx);
    return false;
  } catch (error) {
    if (error instanceof Error &&
        error.message === "Contract proposal is pending; this action is not yet authorized")
      return true;
    throw error;
  }
}

export function getContractAtomicRequirement(
  ctx: ContractAccessContext,
  effects: readonly ContractAccessRequest[],
): "none" | "single-resource" | "file-batch" {
  const contract = taskContractState(ctx);
  if (!contract) return "none";
  const writes = new Set(effects.filter((effect) =>
    ["create", "mutate", "remove", "relocate"].includes(effect.operation))
    .flatMap((effect) => [pathOf(effect.path), ...(effect.to ? [pathOf(effect.to)] : [])]));
  let result: "none" | "single-resource" | "file-batch" = "none";
  for (const group of contract.atomicGroups ?? []) {
    const paths = group.paths.map(pathOf);
    if (!paths.some((path) => writes.has(path))) continue;
    if (!paths.every((path) => writes.has(path))) throw new Error("Atomic group requires its complete resource plan");
    if (paths.length > 1) result = "file-batch";
    else if (result === "none") result = "single-resource";
  }
  return result;
}

export function assertContractAccess(ctx: ContractAccessContext, request: ContractAccessRequest): void {
  const operation = ContractOperationSchema.parse(request.operation);
  if (request.path !== "." || operation !== "enumerate") pathOf(request.path);
  const contract = taskContractState(ctx);
  if (!contract) return;
  if (request.expectedRevision !== undefined && request.expectedRevision !== contract.revision)
    throw new Error("Contract revision changed before publication");
  const target: ContractTarget = {
    path: request.path, match: "exact",
    ...(request.sheetId !== undefined ? {sheetId: request.sheetId} : {}),
    ...(request.range !== undefined ? {range: request.range} : {}),
    ...(request.objectId !== undefined ? {objectId: request.objectId} : {}),
  };
  validateTarget(target);
  if (contract.prohibitions.some((entry) =>
    entry.operation === operation && intersects(entry.target, target)))
    throw new Error("Contract prohibition rejects this operation");
  if (contract.permissions.some((entry) =>
    entry.state === "denied" && entry.operation === operation && intersects(entry.target, target)))
    throw new Error("Contract denied permission rejects this operation");
  if (!contract.permissions.some((entry) =>
    entry.state === "active" && entry.operation === operation && covers(entry.target, target)))
    throw new Error("Contract permission unavailable or needs_confirmation");
  if (operation === "relocate") {
    if (!request.to) throw new Error("Relocation destination is required");
    assertContractAccess(ctx, {...request, operation: "remove", to: undefined});
    assertContractAccess(ctx, {operation: "create", path: request.to, expectedRevision: request.expectedRevision});
  }
}


export type ApprovedContractIdentity =
  | { path: string; exists: false }
  | { path: string; exists: true; device: string; inode: string; size: string; mtime: string; ctime: string };
export interface ApprovedContractIdentityReceipt {
  questionId: string;
  permissionId: string;
  authorizationRevision: number;
  identity: ApprovedContractIdentity;
}
/** Pure lookup only. A caller must still compare the actual resource at the last I/O boundary.
 * Only authenticated committed successor receipts advance the original approval identity; pending state never does.
 */
export function lookupApprovedContractIdentity(
  ctx: ContractAccessContext, request: ContractAccessRequest,
): ApprovedContractIdentityReceipt | undefined {
  assertContractAccess(ctx, request);
  const contract = taskContractState(ctx);
  if (!contract) return undefined;
  const target: ContractTarget = {path: request.path, match: "exact",
    ...(request.sheetId !== undefined ? {sheetId: request.sheetId} : {}),
    ...(request.range !== undefined ? {range: request.range} : {}),
    ...(request.objectId !== undefined ? {objectId: request.objectId} : {})};
  const rows = ctx.db.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.authorization' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? AND json_extract(data,'$.permission.operation')=? AND json_extract(data,'$.permission.target.path')=? ORDER BY seq DESC",
  ).all(ctx.sessionId, ctx.originAgentId, ctx.originTurnId, request.operation, request.path) as {seq:number;data:string}[];
  const expectedRow=ctx.db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC LIMIT 1")
    .get(ctx.sessionId,ctx.originAgentId,ctx.originTurnId) as {data:string}|undefined;
  const expected=expectedRow?JSON.parse(expectedRow.data):undefined;
  for (const row of rows) {
    const raw = JSON.parse(row.data);
    if (raw.originTaskId !== contract.originTaskId || raw.contractId !== expected?.contractId)
      throw new Error("Approved identity contract or origin is corrupt");
    if (raw.decision !== "approve") continue;
    if (!raw.permission?.target || !covers(raw.permission.target, target)) continue;
    const diff = raw.diff;
    if (!diff || createHash("sha256").update(JSON.stringify(diff)).digest("hex") !== raw.diffHash ||
        JSON.stringify(diff.target) !== JSON.stringify(raw.permission.target) ||
        diff.operation !== raw.permission.operation ||
        typeof raw.questionId !== "string" || !raw.questionId ||
        typeof raw.permission.id !== "string" || !raw.permission.id ||
        !Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision > contract.revision)
      throw new Error("Approved identity receipt hash or revision is corrupt");
    const identity = diff.identity;
    if (!identity || identity.path !== request.path || typeof identity.exists !== "boolean")
      throw new Error("Approved identity is invalid");
    if (identity.exists && ["device","inode","size","mtime","ctime"].some(
      key => typeof identity[key] !== "string" || !/^[0-9]+$/.test(identity[key])))
      throw new Error("Approved identity fields are invalid");
    const advanced=advanceContractReadIdentity(ctx.db,{sessionId:ctx.sessionId,originTaskId:contract.originTaskId,
      originAgentId:ctx.originAgentId,originTurnId:ctx.originTurnId,contractId:raw.contractId},identity,row.seq,
      ["create","mutate","remove","relocate"].includes(request.operation)?raw.questionId:undefined);
    return {questionId:raw.questionId,permissionId:raw.permission.id,
      authorizationRevision:raw.revision,identity:advanced??structuredClone(identity)};
  }
  return undefined;
}

export interface ContractReadIdentity {
  path: string;
  sha256: string;
  size: number;
  device: string;
  inode: string;
  originTaskId: string;
}
export type ContractReadAuthority =
  | { kind: "explicit" }
  | { kind: "identity-bound"; proof: ContractReadIdentity }
  | { kind: "metadata-bound"; authorizationId: string; proof: {path:string;exists:true;device:string;inode:string;size:number;mtime:string;ctime:string} };


const ClaimedUploadIdentity = z.strictObject({
  id: z.string().min(1), ownerId: z.string().min(1), workspaceId: z.string().min(1),
  path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(), device: z.string(), inode: z.string(),
  issuedAt: z.number(), expiresAt: z.number(), originTaskId: z.string().min(1),
});
/** A carried upload proof is not newly issued authority. Restore only its unique
 * authenticated claim cutoff, never an identity/grant or an arbitrary path anchor. */
function carriedUploadClaimSequence(
  ctx: ContractAccessContext, originTaskId: string,
  baseline: {seq:number;data:string}, proof: Record<string,unknown>,
): number {
  const current = JSON.parse(baseline.data) as Record<string,unknown>;
  // Older non-upload baseline formats keep their existing cutoff; no authority is added.
  if (!Array.isArray(current.claimIds) || typeof proof.id !== "string") return baseline.seq;
  const claimIds = z.array(z.string()).parse(current.claimIds);
  if (claimIds.includes(proof.id)) return baseline.seq;
  const receipt = ClaimedUploadIdentity.parse(proof);
  if (pathOf(receipt.path) !== receipt.path) throw new Error("Upload claim path is not canonical");
  const expectedRow = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC LIMIT 1",
  ).get(ctx.sessionId,ctx.originAgentId,ctx.originTurnId) as {data:string}|undefined;
  if (!expectedRow) throw new Error("Upload claim authority is unavailable");
  const expected = JSON.parse(expectedRow.data) as Record<string,unknown>;
  if (expected.originTaskId !== originTaskId || expected.originAgentId !== ctx.originAgentId ||
      expected.originTurnId !== ctx.originTurnId || typeof expected.contractId !== "string")
    throw new Error("Upload claim authority is inconsistent");
  const session = ctx.db.prepare("SELECT workspace_id FROM sessions WHERE id=?")
    .get(ctx.sessionId) as {workspace_id:string}|undefined;
  if (!session || session.workspace_id !== receipt.workspaceId || receipt.originTaskId !== originTaskId)
    throw new Error("Upload claim task or workspace is inconsistent");
  const fields = ["id","ownerId","workspaceId","path","sha256","size","device","inode",
    "issuedAt","expiresAt","originTaskId"] as const;
  const same = (value:unknown) => {
    const parsed = ClaimedUploadIdentity.parse(value);
    return fields.every(field => parsed[field] === receipt[field]);
  };
  const bound = ctx.db.prepare("SELECT value FROM meta WHERE key=?")
    .get("contract.upload."+receipt.id) as {value:string}|undefined;
  if (!bound || !same(JSON.parse(bound.value)))
    throw new Error("Upload claim bound receipt is unavailable or inconsistent");
  const rows = ctx.db.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.baseline' AND seq<=? AND (json_extract(data,'$.contractId')=? OR (json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=?) OR EXISTS (SELECT 1 FROM json_each(data,'$.claimIds') WHERE value=?)) ORDER BY seq",
  ).all(ctx.sessionId,baseline.seq,expected.contractId,ctx.originAgentId,ctx.originTurnId,receipt.id) as {seq:number;data:string}[];
  const claims:number[]=[];
  for (const row of rows) {
    const data = JSON.parse(row.data) as Record<string,unknown>;
    if (data.contractId !== expected.contractId || data.originTaskId !== originTaskId ||
        data.originAgentId !== ctx.originAgentId || data.originTurnId !== ctx.originTurnId ||
        data.ownerId !== receipt.ownerId || data.workspaceId !== receipt.workspaceId)
      throw new Error("Upload claim history origin or ownership is inconsistent");
    const ids = z.array(z.string()).parse(data.claimIds);
    const inputs = z.array(z.unknown()).parse(data.inputs);
    const matches = inputs.filter(input => !!input && typeof input === "object" &&
      (input as Record<string,unknown>).id === receipt.id);
    if (matches.length > 1 || (matches.length === 1 && !same(matches[0])))
      throw new Error("Upload claim history proof is conflicting");
    if (ids.includes(receipt.id)) {
      if (ids.filter(id => id === receipt.id).length !== 1 || matches.length !== 1)
        throw new Error("Upload claim history is ambiguous");
      claims.push(row.seq);
    }
  }
  const currentInputs = z.array(z.unknown()).parse(current.inputs);
  const currentPaths = currentInputs.map(input => {
    if (!input || typeof input !== "object" || typeof (input as Record<string,unknown>).path !== "string")
      throw new Error("Upload claim input path is invalid");
    return pathOf((input as Record<string,unknown>).path as string);
  });
  if (currentPaths.filter(path => path === receipt.path).length !== 1 ||
      claims.length !== 1 || claims[0]! >= baseline.seq)
    throw new Error("Upload claim anchor is missing or ambiguous");
  // Claimed receipt expiration behavior is unchanged: no renewal or new clock check.
  return claims[0]!;
}

/** A logical read grant is not permission to reopen an identity-bound path.
 * The filesystem adapter must verify the actual descriptor and returned bytes. */
export function getContractReadAuthority(
  ctx: ContractAccessContext,
  request: ContractAccessRequest,
): ContractReadAuthority {
  if (request.operation !== "read-content" && request.operation !== "read-metadata")
    throw new Error("Read identity authority cannot authorize a write");
  assertContractAccess(ctx, request);
  const contract = taskContractState(ctx);
  if (!contract) return {kind: "explicit"};
  const successor = (anchor:ContractIdentityAnchor,afterSeq:number):ContractReadIdentity|undefined => {
    const expected=ctx.db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC LIMIT 1")
      .get(ctx.sessionId,ctx.originAgentId,ctx.originTurnId) as {data:string}|undefined;
    const contractId=expected?JSON.parse(expected.data).contractId:undefined;
    if(typeof contractId!=="string")throw new Error("Identity successor contract is unavailable");
    const after=advanceContractReadIdentity(ctx.db,{sessionId:ctx.sessionId,originTaskId:contract.originTaskId,
      originAgentId:ctx.originAgentId,originTurnId:ctx.originTurnId,contractId},anchor,afterSeq);
    if(!after)return;
    if(!after.exists)throw new Error("The previously authorized resource was removed");
    const size=Number(after.size);
    if(!Number.isSafeInteger(size)||size<0)throw new Error("Identity successor size is invalid");
    return {path:after.path,sha256:after.sha256,size,device:after.device,inode:after.inode,originTaskId:contract.originTaskId};
  };
  const fromProof=(proof:ContractReadIdentity,seq:number)=>successor({path:proof.path,exists:true,device:proof.device,
    inode:proof.inode,size:String(proof.size),sha256:proof.sha256},seq)??proof;
  const approved=lookupApprovedContractIdentity(ctx,request);
  const approvedRow=approved?ctx.db.prepare("SELECT seq FROM session_log WHERE session_id=? AND type='contract.authorization' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? AND json_extract(data,'$.questionId')=? ORDER BY seq DESC LIMIT 1")
    .get(ctx.sessionId,ctx.originAgentId,ctx.originTurnId,approved.questionId) as {seq:number}|undefined:undefined;
  const fromApproved=():ContractReadAuthority=>{
    if(!approved||!approvedRow)throw new Error("Confirmed read identity is unavailable");
    if(!approved.identity.exists)throw new Error("Confirmed read identity is unavailable");
    const size=Number(approved.identity.size);
    if(!Number.isSafeInteger(size)||size<0)throw new Error("Confirmed read identity size is invalid");
    return {kind:"metadata-bound",authorizationId:approved.questionId,proof:{...approved.identity,size}};
  };
  const created = lookupHostCreatedOutput(ctx, pathOf(request.path));
  if (created) {
    const createdRow=ctx.db.prepare("SELECT seq FROM session_log WHERE session_id=? AND type='contract.output.created' AND json_extract(data,'$.originTaskId')=? AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? AND json_extract(data,'$.proof.path')=? ORDER BY seq DESC LIMIT 1")
      .get(ctx.sessionId,contract.originTaskId,ctx.originAgentId,ctx.originTurnId,pathOf(request.path)) as {seq:number}|undefined;
    if(!createdRow)throw new Error("Created identity anchor is unavailable");
    if(approvedRow&&approvedRow.seq>createdRow.seq)return fromApproved();
    return {kind:"identity-bound",proof:fromProof(created.proof,createdRow.seq)};
  }
  const row = ctx.db.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.baseline' AND json_extract(data,'$.originTaskId')=? AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, contract.originTaskId, ctx.originAgentId, ctx.originTurnId) as {seq:number;data: string} | undefined;
  if (!row) throw new Error("Contract read identity baseline is unavailable");
  const data = JSON.parse(row.data) as {inputs?: unknown};
  if (!Array.isArray(data.inputs)) throw new Error("Uploaded identity baseline is invalid");
  for (const raw of data.inputs) {
    if (!raw || typeof raw !== "object") throw new Error("Uploaded identity is invalid");
    const proof = raw as Record<string, unknown>;
    if (typeof proof.path !== "string") throw new Error("Uploaded identity path is invalid");
    if (pathOf(proof.path) !== pathOf(request.path)) continue;
    if (typeof proof.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.sha256) ||
        typeof proof.size !== "number" || !Number.isSafeInteger(proof.size) || proof.size < 0 ||
        typeof proof.device !== "string" || !/^[0-9]+$/.test(proof.device) ||
        typeof proof.inode !== "string" || !/^[0-9]+$/.test(proof.inode) ||
        proof.originTaskId !== contract.originTaskId)
      throw new Error("Uploaded identity is incomplete or belongs to another task");
    if(approvedRow&&approvedRow.seq>row.seq)return fromApproved();
    return {kind: "identity-bound", proof: fromProof({
      path: pathOf(proof.path), sha256: proof.sha256, size: proof.size,
      device: proof.device, inode: proof.inode, originTaskId: contract.originTaskId,
    },carriedUploadClaimSequence(ctx,contract.originTaskId,row,proof))};
  }
  return fromApproved();
}

/** Newly committed outputs add baseline read candidates, not effective permissions.
 * Once a proposal has considered them, omission keeps the narrowed allowlist. */
export function availableCreatedOutputReadGrants(ctx: ContractAccessContext): ContractHostAuthority["grants"] {
  const contract = taskContractState(ctx);
  if (!contract) return [];
  return createdReadCandidates(ctx, contract.originTaskId);
}

/** Proposal validation may inspect prior committed proof candidates while effects
 * are locked by a newer user dispatch. This function does not authorize I/O. */
function createdReadCandidates(ctx: ContractAccessContext, originTaskId: string): ContractHostAuthority["grants"] {
  const latest = ctx.db.prepare(
    "SELECT seq FROM session_log WHERE session_id=? AND type='contract.updated' AND json_extract(data,'$.originTaskId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, originTaskId) as {seq: number} | undefined;
  const rows = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.output.created' AND seq>? AND json_extract(data,'$.originTaskId')=? ORDER BY seq DESC LIMIT 256"
  ).all(ctx.sessionId, latest?.seq ?? 0, originTaskId) as {data: string}[];
  const paths = new Set<string>();
  for (const row of rows) {
    const data = JSON.parse(row.data) as {proof?: {path?: unknown}};
    if (typeof data.proof?.path === "string" && lookupHostCreatedOutput(ctx, data.proof.path))
      paths.add(data.proof.path);
  }
  return [...paths].flatMap(path => [
    {operation: "read-content" as const, target: {path, match: "exact" as const}},
    {operation: "read-metadata" as const, target: {path, match: "exact" as const}},
  ]);
}

/** Mark explicitly quoted payloads as data; this is not a natural-language permission parser. */
function excludedSourceSpans(text: string): {start: number; end: number}[] {
  const spans: {start: number; end: number}[] = [];
  let cursor = 0;
  let fence: {character: string; length: number; start: number} | undefined;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.character && marker.length >= fence.length) {
        spans.push({start: fence.start, end: cursor + line.length});
        fence = undefined;
      }
    } else if (marker) {
      fence = {character: marker[0]!, length: marker.length, start: cursor};
    } else if (/^ {0,3}>/.test(line)) {
      spans.push({start: cursor, end: cursor + line.length});
    }
    cursor += line.length;
  }
  if (fence) spans.push({start: fence.start, end: text.length});
  return spans;
}

function legacyAllowsTarget(binding: TurnAccessBinding, permission: TaskContractProposal["permissions"][number]): boolean {
  const {operation, target} = permission;
  if (operation === "deliver") {
    if (!deliveryScopeAllows(binding.deliveryScope, target.path)) return false;
    return target.match === "exact" || !binding.deliveryScope || binding.deliveryScope.kind === "unbounded" ||
      binding.deliveryScope.kind === "roots" && binding.deliveryScope.roots.some((path) => covers({path, match: "tree"}, target));
  }
  const read = operation === "read-content" || operation === "read-metadata";
  const mode = operation === "enumerate" ? "enumerate" : read ? "read" : "write";
  const scope = binding.decision;
  if (!accessScopeAllows(scope, target.path, mode)) return false;
  if (target.match === "exact") return true;
  if (scope.kind === "unbounded") return true;
  if (scope.kind === "restricted") return covers({path: scope.root, match: "tree"}, target);
  if (scope.kind !== "split") return false;
  if (mode !== "write" && scope.readPaths === undefined && scope.readRoots === undefined) return true;
  return (mode === "write" ? scope.writeRoots : scope.readRoots ?? [])
    .some((path) => covers({path, match: "tree"}, target));
}

// These are diagnostics from the existing finite parser, not new language templates.
// Unsupported syntax alone never removes an independently established host grant.
const locatedAmbiguityReasons = new Set([
  "目录限制包含多个不同根，不能扩大为公共父目录",
  "目录限制缺少可唯一确定的同目录路径",
  "仅文件名不能确定允许目录",
  "文件名包含多个候选，不能确定唯一的源文件和输出文件",
  "两文件限制包含其他文件或多个另存关系，不能扩大授权",
  "文件集合与目录限制冲突或不明确",
]);
function crosscheckPermission(
  binding: TurnAccessBinding,
  permission: TaskContractProposal["permissions"][number],
  sources: ContractHostAuthority["sources"],
  hostCovered: boolean,
) {
  const evidence: {source: ContractSourceRef; classification: string; axis: string; constraint: unknown; reason?: string}[] = [];
  let conflict = false, ambiguity = false, unsupported = false;
  for (const source of sources) {
    if (source.origin !== "user") continue;
    // Mask rather than remove excluded content, preserving exact trusted offsets.
    const masked = source.text.split("").map((ch, i) =>
      source.excludedSpans.some(span => i >= span.start && i < span.end) ? " " : ch).join("");
    const pieces = [...masked.matchAll(/[^。；;\n]+/g)].map(match =>
      ({text: match[0], start: match.index!}));
    if (!source.excludedSpans.length) pieces.unshift({text: masked, start: 0});
    const seen = new Set<string>();
    for (const piece of pieces) {
      if (!piece.text.trim()) continue;
      const key = piece.start + ":" + piece.text.length;
      if (seen.has(key)) continue;
      seen.add(key);
      const decision = deriveUserAccessScope(piece.text);
      const deliveryScope = deriveUserDeliveryScope(piece.text);
      const isWrite = !["read-content", "read-metadata", "enumerate", "deliver"].includes(permission.operation);
      const unresolvedReason = permission.operation === "deliver"
        ? deliveryScope.kind === "unresolved" ? deliveryScope.reason : undefined
        : decision.kind === "unresolved" ? decision.reason
        : decision.kind === "split" && isWrite ? decision.writeUnresolved?.reason : undefined;
      let classification: string | undefined;
      if (unresolvedReason) {
        if (locatedAmbiguityReasons.has(unresolvedReason)) {
          ambiguity = true; classification = "located_ambiguity";
        } else {
          unsupported = true; classification = "unsupported_observation";
        }
      } else if (!legacyAllowsTarget({...binding, decision, deliveryScope}, permission)) {
        conflict = true; classification = "located_conflict";
      }
      if (classification) evidence.push({
        source: {dispatchId: source.dispatchId, start: piece.start,
          end: piece.start + piece.text.length,
          sha256: createHash("sha256").update(source.text.slice(piece.start, piece.start + piece.text.length)).digest("hex")},
        classification,
        axis: permission.operation === "deliver" ? "delivery" : isWrite ? "write" : "read",
        constraint: permission.operation === "deliver"
          ? deliveryScope.kind === "roots" ? {kind: deliveryScope.kind, roots: deliveryScope.roots} : {kind: deliveryScope.kind}
          : decision.kind === "restricted" ? {kind: decision.kind, root: decision.root}
          : decision.kind === "files" ? {kind: decision.kind, readPaths: decision.readPaths, writePaths: decision.writePaths}
          : decision.kind === "split" ? {kind: decision.kind, readPaths: decision.readPaths, readRoots: decision.readRoots, writePaths: decision.writePaths, writeRoots: decision.writeRoots}
          : {kind: decision.kind},
        ...(unresolvedReason ? {reason: unresolvedReason} : {}),
      });
    }
  }
  return {
    permissionId: permission.id, hostCovered,
    legacyAllows: legacyAllowsTarget(binding, permission),
    classification: !hostCovered ? "authority_expansion"
      : conflict ? "located_conflict" : ambiguity ? "located_ambiguity"
      : unsupported ? "unsupported_observation" : "compatible",
    evidence,
  };
}

/** Unmentioned baseline reads remain host candidates; callers may also carry current active prerequisites.
 * Previously removed or denied scopes still require the existing confirmation path. */
export function availableBaselineReadCandidates(ctx: {
  db: DatabaseSync; sessionId: string; contractId: string; originTaskId: string;
  includeActive?: boolean;
}): ContractHostAuthority["grants"] {
  const row = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.baseline' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, ctx.contractId) as {data: string} | undefined;
  const baseline = row ? JSON.parse(row.data) as {inputs?: {path: string}[]} : {};
  const history = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.updated' AND json_extract(data,'$.contractId')=? AND json_extract(data,'$.originTaskId')=? ORDER BY seq"
  ).all(ctx.sessionId, ctx.contractId, ctx.originTaskId) as {data: string}[];
  const contracts = history.map(row => TaskContract.parse(JSON.parse(row.data).contract));
  const mentioned = contracts.flatMap(contract => [...contract.permissions, ...contract.prohibitions]);
  return (baseline.inputs ?? []).flatMap(entry =>
    (["read-content", "read-metadata"] as const).map(operation => ({
      operation, target: {path: pathOf(entry.path), match: "exact" as const},
    }))
  ).filter(grant => !mentioned.some(permission =>
    permission.operation === grant.operation && intersects(permission.target, grant.target)) ||
    ctx.includeActive === true && contracts.at(-1)?.permissions.some(permission =>
      permission.state === "active" && permission.operation === grant.operation && covers(permission.target, grant.target)));
}

/** Explicit root-name listing is a current-user instruction, not a model grant.
 * This adds only exact nonrecursive enumeration, never child metadata or bytes. */
export function availableExplicitUserRootNamesCandidates(ctx: {
  db:DatabaseSync;sessionId:string;agentId:string;turnId:string;includeActive?:boolean;
}): ContractHostAuthority["grants"] {
  const binding=turnAccessBinding(ctx.db,ctx.sessionId,ctx.agentId,ctx.turnId);
  const ref=binding?.contractRef;
  if(!binding||!ref)return [];
  const expectedRow=ctx.db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1")
    .get(ctx.sessionId,ref.contractId) as {data:string}|undefined;
  if(!expectedRow)return [];
  const expected=JSON.parse(expectedRow.data) as {dispatchId?:unknown;originTaskId?:unknown};
  if(typeof expected.dispatchId!=="string"||expected.originTaskId!==ref.originTaskId||!binding.sourceDispatchIds.includes(expected.dispatchId))return [];
  const row=ctx.db.prepare("SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? ORDER BY seq DESC LIMIT 1")
    .get(ctx.sessionId,ref.originAgentId,expected.dispatchId) as {data:string}|undefined;
  const message=row?JSON.parse(row.data) as {text?:unknown;accessInputOrigin?:unknown}:{};
  if(message.accessInputOrigin!=="user"||typeof message.text!=="string")return [];
  const text=message.text.trim();
  if(excludedSourceSpans(text).length||/["'\x60“”‘’「」『』]|假如|如果|示例|引用|递归|子目录|recursive|subdirector/i.test(text))return [];
  if(/(?:不|勿|别|禁止|不要).{0,6}(?:列出|列举|显示)|(?:do not|never).{0,8}(?:list|enumerate)/i.test(text))return [];
  const chinese=/^(?:请)?(?:仅|只)?(?:列出|列举|显示)(?:当前|此)?工作区根目录(?:下)?的?(?:文件名|目录项名称|条目名称)(?:即可|列表)?(?:[，。；;,\n]|$)/.test(text);
  const english=/^(?:please )?list (?:only )?(?:the )?(?:current )?workspace root (?:entry |file )?names(?: only)?(?:[.,;\n]|$)/i.test(text);
  if(!chinese&&!english)return [];
  const workspace=ctx.db.prepare("SELECT w.id FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?")
    .get(ctx.sessionId) as {id:string}|undefined;
  if(!workspace)return [];
  const history=ctx.db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.updated' AND json_extract(data,'$.contractId')=? AND json_extract(data,'$.originTaskId')=? ORDER BY seq")
    .all(ctx.sessionId,ref.contractId,ref.originTaskId) as {data:string}[];
  const contracts=history.map(value=>TaskContract.parse(JSON.parse(value.data).contract));
  const target={path:".",match:"exact" as const};
  const first=contracts.findIndex(contract=>[...contract.permissions,...contract.prohibitions]
    .some(permission=>permission.operation==="enumerate"&&intersects(permission.target,target)));
  if(first>=0&&!(ctx.includeActive&&contracts.slice(first).every(contract=>
    contract.permissions.some(permission=>permission.operation==="enumerate"&&permission.state==="active"&&covers(permission.target,target))&&
    !contract.prohibitions.some(permission=>permission.operation==="enumerate"&&intersects(permission.target,target)))))return [];
  return [{operation:"enumerate",target}];
}

/** A narrow affirmative instruction from this turn's authenticated user may cover
 * file-level mutation of its exact claimed upload. Cell wording remains a task
 * requirement, not a cell-isolation capability. No model field is a grant source. */
export function availableExplicitUserMutationCandidates(ctx: {
  db: DatabaseSync; sessionId: string; agentId: string; turnId: string;
  includeActive?: boolean;
}): ContractHostAuthority["grants"] {
  const binding = turnAccessBinding(ctx.db, ctx.sessionId, ctx.agentId, ctx.turnId);
  const ref = binding?.contractRef;
  if (!binding || !ref) return [];
  const expectedRow = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, ref.contractId) as {data:string}|undefined;
  if (!expectedRow) return [];
  const expected = JSON.parse(expectedRow.data) as {dispatchId?:unknown;originTaskId?:unknown};
  if (typeof expected.dispatchId !== "string" || expected.originTaskId !== ref.originTaskId ||
      !binding.sourceDispatchIds.includes(expected.dispatchId)) return [];
  const messageRow = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, ref.originAgentId, expected.dispatchId) as {data:string}|undefined;
  const message = messageRow ? JSON.parse(messageRow.data) as {text?:unknown;accessInputOrigin?:unknown} : {};
  if (message.accessInputOrigin !== "user" || typeof message.text !== "string") return [];
  const text = message.text.trim();
  // Unsupported or quoted/conditional instructions still require confirmation.
  if (excludedSourceSpans(text).length || /["'\x60“”‘’「」『』]|不(?!变)|禁止|勿|别|仅供|示例|假如|如果|引用|他说|她说/.test(text)) return [];
  const match = /^(?:请)?(?:把|将)\s*([^\s"'“”‘’<>]+?\.(?:xlsx|xlsm|xls|csv|tsv))\s*的[^。！？\n]+?(?:改成|改为|修改为|设置为)[^。！？\n]+/.exec(text);
  if (!match) return [];
  let path: string;
  try { path = pathOf(match[1]!); } catch { return []; }
  if (path !== match[1]) return [];
  const named = [...text.replace(/^(?:请)?(?:把|将)\s*/, "").matchAll(/[A-Za-z0-9_\u3400-\u9fff./-]+\.(?:xlsx|xlsm|xls|csv|tsv)\b/g)].map(entry => entry[0]);
  if (!named.length || named.some(entry => entry !== path)) return [];
  const baselineRow = ctx.db.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.baseline' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, ref.contractId) as {seq:number;data:string}|undefined;
  if (!baselineRow) return [];
  const baseline = JSON.parse(baselineRow.data) as {originTaskId?:unknown;ownerId?:unknown;workspaceId?:unknown;claimIds?:unknown;inputs?:unknown};
  if (baseline.originTaskId !== ref.originTaskId || !Array.isArray(baseline.inputs) || !Array.isArray(baseline.claimIds)) return [];
  const proofs = baseline.inputs.map(value => ClaimedUploadIdentity.safeParse(value))
    .filter(result => result.success && result.data.path === path);
  const parsed = proofs[0];
  if (proofs.length !== 1 || !parsed?.success) return [];
  const proof = parsed.data;
  const session = ctx.db.prepare("SELECT workspace_id FROM sessions WHERE id=?").get(ctx.sessionId) as {workspace_id:string}|undefined;
  if (!session || session.workspace_id !== proof.workspaceId || baseline.workspaceId !== proof.workspaceId ||
      baseline.ownerId !== proof.ownerId || proof.originTaskId !== ref.originTaskId ||
      !baseline.claimIds.includes(proof.id)) return [];
  const bound = ctx.db.prepare("SELECT value FROM meta WHERE key=?").get("contract.upload."+proof.id) as {value:string}|undefined;
  const persisted = bound ? ClaimedUploadIdentity.safeParse(JSON.parse(bound.value)) : undefined;
  if (!persisted?.success || (Object.keys(proof) as (keyof typeof proof)[]).some(key => persisted.data[key] !== proof[key])) return [];
  const history = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.updated' AND json_extract(data,'$.contractId')=? AND json_extract(data,'$.originTaskId')=? ORDER BY seq"
  ).all(ctx.sessionId, ref.contractId, ref.originTaskId) as {data:string}[];
  const target = {path,match:"exact" as const};
  const contracts = history.map(row => TaskContract.parse(JSON.parse(row.data).contract));
  // Once requested, only existing active authority can carry it forward. Never
  // resurrect a pending, denied or subsequently withdrawn mutation permission.
  const firstMention = contracts.findIndex(contract => [...contract.permissions,...contract.prohibitions]
    .some(permission => permission.operation === "mutate" && intersects(permission.target,target)));
  if (firstMention >= 0 && !(ctx.includeActive && contracts.slice(firstMention).every(contract =>
    contract.permissions.some(permission => permission.operation === "mutate" && permission.state === "active" && covers(permission.target,target)) &&
    !contract.prohibitions.some(permission => permission.operation === "mutate" && intersects(permission.target,target))))) return [];
  return [{operation:"mutate",target}];
}

/** Distinct host-intent provenance, never a synthetic confirmation question.
 * The publisher still checks the real descriptor/preimage before staging. */
export function lookupHostUserMutationAuthority(ctx: ContractAccessContext & {agentId?:string;turnId?:string}, request: ContractAccessRequest) {
  if (request.operation !== "mutate" || request.sheetId !== undefined ||
      request.range !== undefined || request.objectId !== undefined) return undefined;
  assertContractAccess(ctx, request);
  // Ingress allocates the contract origin before the runtime creates its actual
  // execution turn. Resolve that persisted turn binding, never treat originTurnId
  // as a turn.started primary key (and never manufacture a replacement binding).
  let execution: {agentId:string;turnId:string};
  if (ctx.agentId !== undefined || ctx.turnId !== undefined) {
    if (typeof ctx.agentId !== "string" || typeof ctx.turnId !== "string") return undefined;
    execution = {agentId:ctx.agentId,turnId:ctx.turnId};
  } else {
    const executionRow = ctx.db.prepare(
      "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type IN ('turn.started','turn.access.updated') AND json_extract(data,'$.accessBinding.originAgentId')=? AND json_extract(data,'$.accessBinding.originTurnId')=? ORDER BY seq DESC LIMIT 1"
    ).get(ctx.sessionId,ctx.originAgentId,ctx.originAgentId,ctx.originTurnId) as {data:string}|undefined;
    const persisted = executionRow ? JSON.parse(executionRow.data) as {turnId?:unknown} : undefined;
    if (typeof persisted?.turnId !== "string") return undefined;
    execution = {agentId:ctx.originAgentId,turnId:persisted.turnId};
  }
  const candidates = availableExplicitUserMutationCandidates({
    db:ctx.db,sessionId:ctx.sessionId,agentId:execution.agentId,turnId:execution.turnId,includeActive:true,
  });
  if (!candidates.some(candidate => candidate.target.path === request.path)) return undefined;
  const binding = turnAccessBinding(ctx.db,ctx.sessionId,execution.agentId,execution.turnId);
  const ref = binding?.contractRef;
  if (!ref || ref.originAgentId !== ctx.originAgentId || ref.originTurnId !== ctx.originTurnId) return undefined;
  const expectedRow = ctx.db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC LIMIT 1")
    .get(ctx.sessionId,ctx.originAgentId,ctx.originTurnId) as {data:string}|undefined;
  const baselineRow = ctx.db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.baseline' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1")
    .get(ctx.sessionId,ref.contractId) as {data:string}|undefined;
  if (!expectedRow || !baselineRow) return undefined;
  const expected = JSON.parse(expectedRow.data) as {dispatchId:string;contractId:string;originTaskId:string};
  if (expected.contractId !== ref.contractId || expected.originTaskId !== ref.originTaskId) return undefined;
  const baseline = JSON.parse(baselineRow.data) as {inputs:unknown[]};
  const upload = baseline.inputs.map(value => ClaimedUploadIdentity.parse(value)).find(value => value.path === request.path);
  if (!upload) return undefined;
  const authority = getContractReadAuthority(ctx,{operation:"read-content",path:request.path});
  if (authority.kind !== "identity-bound" || authority.proof.originTaskId !== ref.originTaskId) return undefined;
  return {provenance:{dispatchId:expected.dispatchId,uploadId:upload.id,path:request.path},identity:authority.proof};
}

export function proposeTaskContract(
  ctx: {db: DatabaseSync; log: SessionLog; sessionId: string; agentId: string; turnId: string},
  value: unknown,
) {
  const proposal = TaskContractProposal.parse(value);
  // Reject a model proposal that removes the entire scope it simultaneously
  // requests. Do not persist its accidental prohibition and poison later revisions.
  // A narrower exclusion inside a wider permission remains legal; history is untouched.
  for (const permission of proposal.permissions) {
    const prohibition = proposal.prohibitions.find(entry =>
      entry.operation === permission.operation && covers(entry.target, permission.target));
    if (prohibition) throw new Error("契约提案自相矛盾：禁止项完整覆盖同次申请权限。冲突=" + JSON.stringify({
      permissionId:permission.id, prohibitionId:prohibition.id, operation:permission.operation,
      permissionTarget:permission.target, prohibitionTarget:prohibition.target,
      baseRevision:proposal.baseRevision,
    }) + "。本次未提交，revision不变。请按用户原文修正申请或禁止范围后重提；不能删除或绕过已经生效的历史禁止。");
  }
  const binding = turnAccessBinding(ctx.db, ctx.sessionId, ctx.agentId, ctx.turnId);
  const ref = binding?.contractRef;
  if (!binding || !ref || ref.originAgentId !== binding.originAgentId || ref.originTurnId !== binding.originTurnId)
    throw new Error("Contract authority origin is unavailable");
  const expectedRow = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, ref.contractId) as {data:string} | undefined;
  if (!expectedRow) throw new Error("Contract expectation is unavailable");
  const expected = JSON.parse(expectedRow.data) as {dispatchId?:unknown};
  if (typeof expected.dispatchId === "string" && !binding.sourceDispatchIds.includes(expected.dispatchId))
    throw new Error("A newer user dispatch is pending; re-read the current contract revision");
  const previousRow = ctx.db.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.updated' AND json_extract(data,'$.contractId')=? AND json_extract(data,'$.originTaskId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, ref.contractId, ref.originTaskId) as {data: string} | undefined;
  const previous = previousRow ? TaskContract.parse(JSON.parse(previousRow.data).contract) : undefined;
  const sources: ContractHostAuthority["sources"] = binding.sourceDispatchIds.map((dispatchId) => {
    const row = ctx.db.prepare(
      "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? ORDER BY seq DESC LIMIT 1"
    ).get(ctx.sessionId, ref.originAgentId, dispatchId) as {seq: number; data: string} | undefined;
    const data = row ? JSON.parse(row.data) as {text?: unknown; accessInputOrigin?: unknown} : {};
    return {
      dispatchId, journalSeq: row?.seq, text: typeof data.text === "string" ? data.text : "",
      origin: data.accessInputOrigin === "user" ? "user" : "agent",
      excludedSpans: excludedSourceSpans(typeof data.text === "string" ? data.text : ""),
    };
  });
  // The legacy parser is a restrictive cross-check, never a grant source.
  const baselineRow = ctx.db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.baseline' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1"
  ).get(ctx.sessionId, ref.contractId) as {data:string} | undefined;
  const baseline = baselineRow ? JSON.parse(baselineRow.data) as {inputs?: {path:string}[]} : {};
  const defaults: ContractHostAuthority["grants"] = [
    {operation:"create",target:{path:"outputs",match:"tree"}},
    ...(baseline.inputs ?? []).flatMap((entry) => [
      {operation:"read-content" as const,target:{path:pathOf(entry.path),match:"exact" as const}},
      {operation:"read-metadata" as const,target:{path:pathOf(entry.path),match:"exact" as const}},
    ]),
  ];
  const newlyCreatedReads = previous
    ? createdReadCandidates({db: ctx.db, sessionId: ctx.sessionId, ...ref, contractExpected: true}, ref.originTaskId)
    : [];
  const candidates = previous
    ? [...previous.permissions.filter((entry) => entry.state === "active"), ...newlyCreatedReads,
       ...availableBaselineReadCandidates({db: ctx.db, sessionId: ctx.sessionId, ...ref})]
    : defaults;
  candidates.push(...availableExplicitUserMutationCandidates(ctx), ...availableExplicitUserRootNamesCandidates(ctx));
  const authorizationRows = ctx.db.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.authorization' AND json_extract(data,'$.contractId')=? AND json_extract(data,'$.originTaskId')=? AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC",
  ).all(ctx.sessionId, ref.contractId, ref.originTaskId, ref.originAgentId, ref.originTurnId) as {seq:number;data:string}[];
  const crosschecks = proposal.permissions.map(permission => {
    let confirmedThrough = 0;
    let confirmationQuestionId: string | undefined;
    // Only an actually active, precisely confirmed permission resolves its older
    // source conflict. A subsequent dispatch remains observable at its own sequence.
    if (previous?.permissions.some(entry => entry.state === "active" &&
      entry.operation === permission.operation && covers(entry.target, permission.target))) {
      for (const row of authorizationRows) {
        const approval = JSON.parse(row.data);
        if (approval.decision !== "approve" || approval.permission?.operation !== permission.operation ||
            !approval.permission?.target || !covers(approval.permission.target, permission.target)) continue;
        if (!approval.diff || createHash("sha256").update(JSON.stringify(approval.diff)).digest("hex") !== approval.diffHash ||
            JSON.stringify(approval.diff.target) !== JSON.stringify(approval.permission.target) ||
            approval.diff.operation !== permission.operation ||
            !Number.isSafeInteger(approval.revision) || approval.revision > previous.revision ||
            typeof approval.questionId !== "string")
          throw new Error("Confirmed contract cross-check receipt is corrupt");
        confirmedThrough = row.seq;
        confirmationQuestionId = approval.questionId;
        break;
      }
    }
    return {...crosscheckPermission(binding, permission,
      sources.filter(source => source.journalSeq === undefined || source.journalSeq > confirmedThrough),
      candidates.some(candidate => candidate.operation === permission.operation && covers(candidate.target, permission.target))),
      ...(confirmationQuestionId ? {confirmationQuestionId, confirmedThrough} : {})};
  });
  // Intersect the requested resource, not the entire baseline tree. An independent
  // exact target can remain active while another permission awaits confirmation.
  const grants = proposal.permissions.filter((_, index) => {
    const check = crosschecks[index]!;
    return check.hostCovered && !["located_conflict", "located_ambiguity"].includes(check.classification);
  });
  const contract = resolveTaskContractProposal({
    proposal,
    authority: {
      originTaskId: ref.originTaskId, revision: previous?.revision ?? 0,
      sources, grants,
      prohibitions: previous?.prohibitions ?? [],
      obligations: previous?.obligations ?? [],
      atomicGroups: previous?.atomicGroups ?? [],
    },
  });
  for (const permission of contract.permissions) {
    const check = crosschecks.find(entry => entry.permissionId === permission.id)!;
    if (permission.state === "needs_confirmation" && check.hostCovered)
      permission.reason = check.classification;
  }
  const committed = ctx.log.append(ctx.sessionId, ref.originAgentId, [{
    type: "contract.crosscheck",
    data: {...ref, revision: contract.revision, permissions: crosschecks},
  }, {
    type: "contract.updated",
    data: {...ref, requestedBy: ctx.agentId, contract},
  }]);
  if (committed.length !== 2) throw new Error("Contract authority persistence failed");
  return contract;
}

/** Pure proposal validation. Callers must obtain authority from the host, not from model JSON. */
export function resolveTaskContractProposal(input: {
  proposal: unknown;
  authority: ContractHostAuthority;
}) {
  const proposal = TaskContractProposal.parse(input.proposal);
  const authority = input.authority;
  if (proposal.baseRevision !== authority.revision) throw new Error("Contract revision changed");
  const all = [
    ...proposal.objectives, ...proposal.inputs, ...proposal.outputs,
    ...proposal.permissions, ...proposal.prohibitions, ...proposal.obligations,
    ...(proposal.atomicGroups ?? []),
  ];
  for (const item of all) verifySource(item.source, authority);
  for (const resource of [...proposal.inputs, ...proposal.outputs]) pathOf(resource.path);
  for (const permission of [...proposal.permissions, ...proposal.prohibitions]) validateTarget(permission.target);
  for (const permission of proposal.permissions)
    if (permission.target.path === "." && (permission.operation !== "enumerate" || permission.target.match !== "exact"))
      throw new Error("Workspace root permits only exact nonrecursive name enumeration");
  const ids = all.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Contract item identities must be unique");

  // Existing prohibitions cannot be deleted by re-proposal or by omitting a field.
  const prohibitions = [...authority.prohibitions];
  for (const prohibition of proposal.prohibitions) {
    if (!prohibitions.some((prior) =>
      prior.operation === prohibition.operation &&
      JSON.stringify(prior.target) === JSON.stringify(prohibition.target)))
      prohibitions.push(prohibition);
  }
  const obligations = [...authority.obligations];
  for (const obligation of proposal.obligations) {
    const prior = obligations.find((entry) => entry.id === obligation.id);
    if (prior) {
      if (prior.requirement !== obligation.requirement || (prior.required && !obligation.required))
        throw new Error("Existing required obligation cannot be replaced or weakened");
    } else obligations.push(obligation);
  }

  const atomicGroups = [...(authority.atomicGroups ?? [])];
  for (const group of proposal.atomicGroups ?? []) {
    for (const path of group.paths) pathOf(path);
    if (new Set(group.paths.map(pathOf)).size !== group.paths.length)
      throw new Error("Atomic group paths must be unique");
    const prior = atomicGroups.find((entry) => entry.id === group.id);
    if (prior && JSON.stringify(prior.paths) !== JSON.stringify(group.paths))
      throw new Error("Existing atomic group cannot be replaced");
    if (!prior) atomicGroups.push(group);
  }
  const permissions = proposal.permissions.map((permission) => {
    const denied = prohibitions.some((prohibition) =>
      prohibition.operation === permission.operation &&
      covers(prohibition.target, permission.target));
    const granted = authority.grants.some((grant) =>
      grant.operation === permission.operation && covers(grant.target, permission.target));
    return {
      ...permission,
      state: denied ? "denied" as const : granted ? "active" as const : "needs_confirmation" as const,
      reason: denied ? "trusted_prohibition" : granted ? "within_host_authority" : "authority_expansion",
    };
  });
  return {
    originTaskId: authority.originTaskId,
    revision: authority.revision + 1,
    atomicGroups,
    objectives: proposal.objectives,
    inputs: proposal.inputs,
    outputs: proposal.outputs,
    permissions,
    prohibitions,
    obligations,
  };
}
