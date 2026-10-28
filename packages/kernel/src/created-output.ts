import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import { ContractRef } from "@excelmanus/protocol";
import { normalizeAccessPath } from "./access-scope.ts";
import { FileOperationError } from "./backup.ts";
import {
  assertPlannedOperation,
  type EffectPermit,
  hasPlannedPath,
  recheckEffectPlan,
} from "./effect-gate.ts";
import { resolveWorkspacePath } from "./paths.ts";
import {
  currentToolAccess,
  type ExpectedPhysicalIdentity,
  type ToolAccessContext,
} from "./tool-access.ts";
import { turnAccessBinding } from "./turn-access.ts";

export interface HostCreatedOutputProof {
  path: string;
  sha256: string;
  size: number;
  device: string;
  inode: string;
  originTaskId: string;
}
export interface HostCreatedOutputReceipt {
  contractId: string;
  originTaskId: string;
  originAgentId: string;
  originTurnId: string;
  operationId: string;
  proof: HostCreatedOutputProof;
}
interface Origin {
  db: DatabaseSync;
  sessionId: string;
  originAgentId: string;
  originTurnId: string;
}
function validProof(value: unknown): value is HostCreatedOutputProof {
  if (!value || typeof value !== "object") return false;
  const p = value as HostCreatedOutputProof;
  return (
    typeof p.path === "string" &&
    p.path.startsWith("outputs/") &&
    normalizeAccessPath(p.path) === p.path &&
    typeof p.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(p.sha256) &&
    Number.isSafeInteger(p.size) &&
    p.size >= 0 &&
    typeof p.device === "string" &&
    /^\d+$/.test(p.device) &&
    typeof p.inode === "string" &&
    /^\d+$/.test(p.inode) &&
    typeof p.originTaskId === "string" &&
    !!p.originTaskId
  );
}
/** Pure append-only host lookup. The caller still must verify the actual read descriptor. */
export function lookupHostCreatedOutput(
  ctx: Origin,
  path: string,
): HostCreatedOutputReceipt | undefined {
  if (normalizeAccessPath(path) !== path || !path.startsWith("outputs/")) return;
  const expected = ctx.db
    .prepare(
      "SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(ctx.sessionId, ctx.originAgentId, ctx.originTurnId) as { data: string } | undefined;
  if (!expected) return;
  const raw = JSON.parse(expected.data) as Record<string, unknown>;
  const ref = ContractRef.safeParse({
    contractId: raw.contractId,
    originTaskId: raw.originTaskId,
    originAgentId: raw.originAgentId,
    originTurnId: raw.originTurnId,
  });
  if (!ref.success) return;
  const row = ctx.db
    .prepare(
      "SELECT data FROM session_log WHERE session_id=? AND type='contract.output.created' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? AND json_extract(data,'$.proof.path')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(ctx.sessionId, ctx.originAgentId, ctx.originTurnId, path) as { data: string } | undefined;
  if (!row) return;
  const receipt = JSON.parse(row.data) as HostCreatedOutputReceipt;
  if (
    !validProof(receipt.proof) ||
    receipt.proof.path !== path ||
    receipt.contractId !== ref.data.contractId ||
    receipt.originTaskId !== ref.data.originTaskId ||
    receipt.proof.originTaskId !== ref.data.originTaskId ||
    receipt.originAgentId !== ctx.originAgentId ||
    receipt.originTurnId !== ctx.originTurnId ||
    typeof receipt.operationId !== "string" ||
    !receipt.operationId
  )
    return;
  return receipt;
}

/** Private provenance, not authority to read the published resource. */
export interface CommittedCreatedDocument {
  version: 1;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  agentId: string;
  turnId: string;
  stepId: string;
  toolCallId: string;
  intentSeq: number;
  contractRef: ContractRef;
  operation: "create";
  docId: string;
  revision: 1;
  path: string;
  sha256: string;
  physical: ExpectedPhysicalIdentity;
}
declare const createdReceiptBrand: unique symbol;
export interface CreatedDocumentReceipt {
  readonly [createdReceiptBrand]: true;
}
export interface PublishedCreatedDocument {
  docId: string;
  receipt?: CreatedDocumentReceipt;
}
const createdDocuments = new WeakMap<
  CreatedDocumentReceipt,
  {
    owner: object;
    db: DatabaseSync;
    proof: CommittedCreatedDocument;
  }
>();
function sameRef(a: ContractRef, b: ContractRef): boolean {
  return (
    a.contractId === b.contractId &&
    a.originTaskId === b.originTaskId &&
    a.originAgentId === b.originAgentId &&
    a.originTurnId === b.originTurnId
  );
}
function documentIntent(
  access: Pick<
    ToolAccessContext,
    "db" | "sessionId" | "agentId" | "turnId" | "toolCallId" | "stepId"
  >,
): { stepId: string; intentSeq: number } {
  const rows = access.db
    .prepare(
      "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND json_extract(data,'$.toolCallId')=? ORDER BY seq",
    )
    .all(access.sessionId, access.agentId, access.toolCallId) as Array<{
    seq: number;
    data: string;
  }>;
  if (rows.length !== 1)
    throw new FileOperationError("INVALID_ARGUMENT", "创建来源调用无法唯一关联");
  const intent = JSON.parse(rows[0]!.data) as { stepId?: unknown; toolName?: unknown };
  if (
    typeof access.stepId !== "string" ||
    intent.stepId !== access.stepId ||
    !["workbook_edit", "run_script"].includes(String(intent.toolName))
  )
    throw new FileOperationError("INVALID_ARGUMENT", "创建来源不是当前宿主文档调用");
  const step = access.db
    .prepare(
      "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='step.started' AND seq<? ORDER BY seq DESC LIMIT 1",
    )
    .get(access.sessionId, access.agentId, rows[0]!.seq) as
    | { seq: number; data: string }
    | undefined;
  const data = step ? (JSON.parse(step.data) as { stepId?: unknown; turnId?: unknown }) : undefined;
  if (!step || data?.stepId !== intent.stepId || data.turnId !== access.turnId)
    throw new FileOperationError("INVALID_ARGUMENT", "创建来源不属于当前轮次步骤");
  return { stepId: intent.stepId, intentSeq: Number(rows[0]!.seq) };
}
function createdDocumentScope(root: string) {
  const access = currentToolAccess();
  if (!access) return;
  const binding = access.binding(),
    ref = binding.contractRef;
  const expected = access.db
    .prepare(
      "SELECT 1 FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? LIMIT 1",
    )
    .get(access.sessionId, binding.originAgentId, binding.originTurnId);
  if (!ref) {
    if (expected) throw new FileOperationError("INVALID_ARGUMENT", "创建缺少当前契约来源");
    return;
  }
  const parsed = ContractRef.safeParse(ref);
  const recorded = turnAccessBinding(
    access.db,
    access.sessionId,
    access.agentId,
    access.turnId,
  )?.contractRef;
  const session = access.db
    .prepare("SELECT workspace_id FROM sessions WHERE id=?")
    .get(access.sessionId) as { workspace_id: string } | undefined;
  if (
    !parsed.success ||
    !recorded ||
    !sameRef(parsed.data, recorded) ||
    !session?.workspace_id ||
    resolve(access.workspaceRoot) !== resolve(root)
  )
    throw new FileOperationError("INVALID_ARGUMENT", "创建缺少可信工作区或轮次来源");
  return { access, ref: parsed.data, workspaceId: session.workspace_id, ...documentIntent(access) };
}
/** One-use consumption is prior to the caller's DB transaction, including failed COMMITs. */
export function consumeCreatedDocumentReceipt(
  receipt: CreatedDocumentReceipt,
  input: {
    owner: object;
    db: DatabaseSync;
    workspaceId: string;
    root: string;
    path: string;
    docId: string;
    sha256: string;
  },
): CommittedCreatedDocument {
  const stored = createdDocuments.get(receipt);
  createdDocuments.delete(receipt);
  const scope = createdDocumentScope(input.root);
  if (
    !stored ||
    !scope ||
    stored.owner !== input.owner ||
    stored.db !== input.db ||
    scope.access.db !== input.db ||
    stored.proof.workspaceId !== input.workspaceId ||
    stored.proof.workspaceRoot !== resolve(input.root) ||
    stored.proof.path !== input.path ||
    stored.proof.docId !== input.docId ||
    stored.proof.sha256 !== input.sha256 ||
    stored.proof.sessionId !== scope.access.sessionId ||
    stored.proof.agentId !== scope.access.agentId ||
    stored.proof.turnId !== scope.access.turnId ||
    stored.proof.toolCallId !== scope.access.toolCallId ||
    stored.proof.intentSeq !== scope.intentSeq ||
    stored.proof.stepId !== scope.stepId ||
    !sameRef(stored.proof.contractRef, scope.ref)
  )
    throw new FileOperationError("INVALID_ARGUMENT", "创建凭据不可仿造、重复或跨归属使用");
  return stored.proof;
}
/** Original committed provenance only; this does not assert a current postimage or grant reads. */
export function listCommittedCreatedDocuments(input: {
  db: DatabaseSync;
  workspaceId: string;
  root: string;
}): CommittedCreatedDocument[] {
  const access = currentToolAccess(),
    ref = access?.binding().contractRef;
  if (
    !access ||
    !ref ||
    access.db !== input.db ||
    resolve(access.workspaceRoot) !== resolve(input.root)
  )
    throw new Error("CREATE_PROVENANCE_CONTEXT_MISSING");
  const rows = input.db
    .prepare(
      "SELECT d.id,d.path,d.workspace_id,o.rev,o.base_rev,o.source_kind,o.source_id,o.session_id,o.tool_call_id,o.inverse FROM documents d JOIN doc_ops o ON o.doc_id=d.id WHERE d.workspace_id=? AND o.session_id=? AND (NOT json_valid(o.inverse) OR json_type(o.inverse,'$._hostCreatedDocument') IS NOT NULL) LIMIT 1001",
    )
    .all(input.workspaceId, access.sessionId) as Array<Record<string, unknown>>;
  if (rows.length > 1000) throw new Error("CREATE_PROVENANCE_SCAN_INCOMPLETE");
  const proofs: CommittedCreatedDocument[] = [];
  for (const row of rows) {
    let proof: CommittedCreatedDocument;
    try {
      proof = JSON.parse(String(row.inverse))._hostCreatedDocument;
    } catch {
      throw new Error("CREATE_PROVENANCE_INVALID");
    }
    if (!proof || !ContractRef.safeParse(proof.contractRef).success)
      throw new Error("CREATE_PROVENANCE_INVALID");
    if (!sameRef(proof.contractRef, ref)) continue;
    if (
      proof.version !== 1 ||
      proof.operation !== "create" ||
      proof.revision !== 1 ||
      row.rev !== 1 ||
      row.base_rev !== 0 ||
      !["agent", "script"].includes(String(row.source_kind)) ||
      proof.workspaceId !== input.workspaceId ||
      proof.workspaceRoot !== resolve(input.root) ||
      proof.sessionId !== access.sessionId ||
      proof.docId !== row.id ||
      typeof proof.path !== "string" ||
      normalizeAccessPath(proof.path) !== proof.path ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      typeof proof.agentId !== "string" ||
      typeof proof.turnId !== "string" ||
      typeof proof.stepId !== "string" ||
      typeof proof.toolCallId !== "string" ||
      !Number.isSafeInteger(proof.intentSeq) ||
      row.source_id !== `${proof.sessionId}/${proof.agentId}` ||
      row.tool_call_id !== proof.toolCallId
    )
      throw new Error("CREATE_PROVENANCE_INVALID");
    const origin = turnAccessBinding(
      input.db,
      proof.sessionId,
      proof.agentId,
      proof.turnId,
    )?.contractRef;
    if (!origin || !sameRef(origin, ref)) throw new Error("CREATE_PROVENANCE_ORIGIN_CHANGED");
    const actual = documentIntent({ db: input.db, ...proof }),
      physical = proof.physical;
    if (
      actual.intentSeq !== proof.intentSeq ||
      actual.stepId !== proof.stepId ||
      !physical ||
      physical.kind !== "file" ||
      physical.nlink !== 1 ||
      !Number.isSafeInteger(physical.size) ||
      physical.size < 0 ||
      ![physical.device, physical.inode, physical.mtimeNs, physical.ctimeNs].every(
        (v) => typeof v === "string" && /^\d+$/.test(v),
      )
    )
      throw new Error("CREATE_PROVENANCE_INVALID");
    proofs.push(proof);
  }
  return proofs;
}

/** Only an exact committed create and its original physical anchor can be rebound. */
export function lookupCommittedCreatedDocument(input: {
  db: DatabaseSync;
  workspaceId: string;
  root: string;
  path: string;
  docId: string;
  revision: number;
  toolCallId: string;
}): CommittedCreatedDocument | undefined {
  const access = currentToolAccess(),
    ref = access?.binding().contractRef;
  if (
    !access ||
    !ref ||
    access.db !== input.db ||
    input.revision !== 1 ||
    resolve(access.workspaceRoot) !== resolve(input.root) ||
    normalizeAccessPath(input.path) !== input.path
  )
    return;
  const row = input.db
    .prepare(
      "SELECT d.rev,d.head_rev,d.checkpoint_rev,d.checkpoint_hash,o.base_rev,o.source_kind,o.source_id,o.session_id,o.tool_call_id,o.inverse FROM documents d JOIN doc_ops o ON o.doc_id=d.id AND o.rev=1 WHERE d.id=? AND d.workspace_id=? AND d.path=?",
    )
    .get(input.docId, input.workspaceId, input.path) as Record<string, unknown> | undefined;
  if (
    !row ||
    row.rev !== 1 ||
    row.head_rev !== 1 ||
    row.checkpoint_rev !== 1 ||
    row.base_rev !== 0 ||
    !["agent", "script"].includes(String(row.source_kind)) ||
    row.session_id !== access.sessionId
  )
    return;
  try {
    const proof = (
      JSON.parse(String(row.inverse)) as { _hostCreatedDocument?: CommittedCreatedDocument }
    )._hostCreatedDocument;
    if (
      !proof ||
      proof.version !== 1 ||
      proof.operation !== "create" ||
      proof.revision !== 1 ||
      proof.workspaceId !== input.workspaceId ||
      proof.workspaceRoot !== resolve(input.root) ||
      proof.sessionId !== access.sessionId ||
      proof.docId !== input.docId ||
      proof.path !== input.path ||
      proof.toolCallId !== input.toolCallId ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      proof.sha256 !== row.checkpoint_hash ||
      typeof proof.agentId !== "string" ||
      typeof proof.turnId !== "string" ||
      typeof proof.stepId !== "string" ||
      typeof proof.toolCallId !== "string" ||
      !Number.isSafeInteger(proof.intentSeq) ||
      row.source_id !== `${proof.sessionId}/${proof.agentId}` ||
      row.tool_call_id !== proof.toolCallId ||
      !ContractRef.safeParse(proof.contractRef).success ||
      !sameRef(proof.contractRef, ref)
    )
      return;
    const origin = turnAccessBinding(
      input.db,
      proof.sessionId,
      proof.agentId,
      proof.turnId,
    )?.contractRef;
    if (!origin || !sameRef(origin, proof.contractRef)) return;
    const actual = documentIntent({ db: input.db, ...proof });
    const physical = proof.physical;
    if (
      actual.intentSeq !== proof.intentSeq ||
      actual.stepId !== proof.stepId ||
      !physical ||
      physical.kind !== "file" ||
      physical.nlink !== 1 ||
      !Number.isSafeInteger(physical.size) ||
      physical.size < 0 ||
      ![physical.device, physical.inode, physical.mtimeNs, physical.ctimeNs].every(
        (v) => typeof v === "string" && /^\d+$/.test(v),
      )
    )
      return;
    return proof;
  } catch {
    return;
  }
}

/** Performs the exclusive publication itself. There is deliberately no arbitrary "record metadata" API. */
export function publishExclusiveCreatedOutput(input: {
  permit: EffectPermit;
  root: string;
  path: string;
  temporaryPath: string;
  sha256: string;
  documentOwner?: object;
}): PublishedCreatedDocument | undefined {
  const document = input.documentOwner
    ? { docId: newId("doc"), scope: createdDocumentScope(input.root) }
    : undefined;
  recheckEffectPlan(input.permit);
  if (!hasPlannedPath(input.path, input.root))
    throw new FileOperationError("INVALID_ARGUMENT", "新建发布缺少当前计划");
  assertPlannedOperation(input.path, "create", input.root);
  const { abs, rel } = resolveWorkspacePath(input.root, input.path);
  const tmpRel = relative(resolve(input.root, ".excelmanus", "tmp"), resolve(input.temporaryPath));
  if (!tmpRel || tmpRel === ".." || tmpRel.startsWith(`..${sep}`) || isAbsolute(tmpRel))
    throw new FileOperationError("OUT_OF_WORKSPACE", "新建暂存不属于宿主操作目录");
  const fd = openSync(input.temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let published = false;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      createHash("sha256").update(readFileSync(fd)).digest("hex") !== input.sha256
    )
      throw new FileOperationError("VERSION_CONFLICT", "宿主暂存身份或内容已变化");
    recheckEffectPlan(input.permit);
    try {
      linkSync(input.temporaryPath, abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new FileOperationError("VERSION_CONFLICT", "目标已存在，未覆盖");
      throw error;
    }
    published = true;
    rmSync(input.temporaryPath);
    const after = fstatSync(fd, { bigint: true }),
      atPath = lstatSync(abs, { bigint: true });
    if (
      !atPath.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      atPath.dev !== after.dev ||
      atPath.ino !== after.ino ||
      after.nlink !== 1n ||
      atPath.nlink !== 1n ||
      !after.isFile() ||
      atPath.size !== after.size ||
      atPath.mtimeNs !== after.mtimeNs ||
      atPath.ctimeNs !== after.ctimeNs ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      resolveWorkspacePath(input.root, rel).abs !== abs
    )
      throw new Error("已发布资源的身份不再与宿主暂存一致");
    recheckEffectPlan(input.permit);
    const ctx = currentToolAccess(),
      ref = ctx?.binding().contractRef;
    if (ctx && ref && rel.startsWith("outputs/")) {
      const receipt: HostCreatedOutputReceipt = {
        ...ref,
        operationId: ctx.toolCallId,
        proof: {
          path: rel,
          sha256: input.sha256,
          size: Number(after.size),
          device: String(after.dev),
          inode: String(after.ino),
          originTaskId: ref.originTaskId,
        },
      };
      if (!validProof(receipt.proof)) throw new Error("创建记录格式不可用");
      ctx.log.append(ctx.sessionId, ctx.agentId, [
        { type: "contract.output.created", data: receipt },
      ]);
    }
    if (document) {
      const scope = document.scope;
      if (!scope) return { docId: document.docId };
      const current = createdDocumentScope(input.root);
      if (
        !current ||
        current.access.db !== scope.access.db ||
        current.intentSeq !== scope.intentSeq ||
        current.stepId !== scope.stepId ||
        !sameRef(current.ref, scope.ref) ||
        !Number.isSafeInteger(Number(after.size))
      )
        throw new Error("发布期间创建归属发生变化");
      const receipt = Object.freeze({}) as CreatedDocumentReceipt;
      const proof: CommittedCreatedDocument = {
        version: 1,
        workspaceId: scope.workspaceId,
        workspaceRoot: resolve(input.root),
        sessionId: scope.access.sessionId,
        agentId: scope.access.agentId,
        turnId: scope.access.turnId,
        toolCallId: scope.access.toolCallId,
        stepId: scope.stepId,
        intentSeq: scope.intentSeq,
        contractRef: { ...scope.ref },
        operation: "create",
        docId: document.docId,
        revision: 1,
        path: rel,
        sha256: input.sha256,
        physical: {
          kind: "file",
          nlink: 1,
          size: Number(after.size),
          device: String(after.dev),
          inode: String(after.ino),
          mtimeNs: String(after.mtimeNs),
          ctimeNs: String(after.ctimeNs),
        },
      };
      Object.freeze(proof.contractRef);
      Object.freeze(proof.physical);
      Object.freeze(proof);
      createdDocuments.set(receipt, { owner: input.documentOwner!, db: scope.access.db, proof });
      return { docId: document.docId, receipt };
    }
  } catch (error) {
    if (published)
      throw new FileOperationError(
        "VERSION_CONFLICT",
        `文件已发布但身份记录未完成；不得授读，需核对实际输出：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    throw error;
  } finally {
    closeSync(fd);
  }
}
