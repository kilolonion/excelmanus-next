import type { DatabaseSync } from "node:sqlite";
import { ContractOperation, ContractTarget, type ContractOperation as Operation, type ContractTarget as Target } from "@excelmanus/protocol";
import { contractTargetsIntersect } from "./task-contract.ts";
import { normalizeAccessPath } from "./access-scope.ts";
import type { EffectIntent } from "./tools.ts";
import { turnAccessBinding } from "./turn-access.ts";

export interface FileEffectIdentity {
  dev: string;
  ino: string;
  birthtimeMs: string;
}
/** Only host capture supplies physical identity, never a model tool argument. */
export type CapturedEffectIntent = EffectIntent & { identity?: FileEffectIdentity };
export interface DeniedEffectFence {
  version: 1;
  approvalId: string;
  decisionSeq: number;
  originAgentId: string;
  originTurnId: string;
  canonicalPath: string;
  deniedEffects: Array<"remove" | "replace">;
  identity?: FileEffectIdentity;
  provenance: "user" | "legacy-unknown";
  /** New precise host denials; absence retains the original V14 broad fence unchanged. */
  contractDenial?: { operation: Operation; target: Target; contractId: string; originTaskId: string; revision: number };
}
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
function sameIdentity(a?: FileEffectIdentity, b?: FileEffectIdentity): boolean {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}
export function evaluateDeniedEffects(
  fences: readonly DeniedEffectFence[],
  effects: readonly CapturedEffectIntent[],
):
  | { allowed: true }
  | {
      allowed: false;
      approvalId: string;
      path: string;
      effect: string;
      provenance: DeniedEffectFence["provenance"];
    } {
  for (const effect of effects) {
    const path = normalizeAccessPath(effect.path);
    const to = effect.to === undefined ? undefined : normalizeAccessPath(effect.to);
    for (const fence of fences) {
      if (fence.contractDenial) {
        const denied = fence.contractDenial;
        const destructiveSource = denied.operation === "mutate" ||
          (denied.operation === "remove" || denied.operation === "relocate")
            && (effect.kind === "remove" || effect.kind === "relocate") ||
          denied.operation === "create" && effect.kind === "create";
        const target = (value: string, source: boolean): Target => ({
          path: source && sameIdentity(fence.identity, effect.identity) ? fence.canonicalPath : value,
          match: source && (effect.kind === "remove" || effect.kind === "relocate") ? "tree" : "exact",
          ...(source && effect.sheetId !== undefined ? { sheetId: effect.sheetId } : {}),
          ...(source && effect.range !== undefined ? { range: effect.range } : {}),
          ...(source && effect.objectId !== undefined ? { objectId: effect.objectId } : {}),
        });
        const sourceBlocked = path !== undefined && destructiveSource &&
          contractTargetsIntersect(denied.target, target(path, true));
        const destinationBlocked = to !== undefined &&
          (denied.operation === "create" || denied.operation === "mutate") &&
          contractTargetsIntersect(denied.target, target(to, false));
        if (sourceBlocked || destinationBlocked) return {
          allowed: false, approvalId: fence.approvalId, path: fence.canonicalPath,
          effect: effect.kind, provenance: fence.provenance,
        };
        continue;
      }
      // A directory removal/relocation also removes fenced descendants. A fresh
      // replacement at the denied location remains forbidden even after bytes change.
      const source =
        path !== undefined &&
        (within(fence.canonicalPath, path) ||
          (effect.kind !== "create" && within(path, fence.canonicalPath)) ||
          sameIdentity(fence.identity, effect.identity));
      const destination = to !== undefined && within(fence.canonicalPath, to);
      if (source || destination)
        return {
          allowed: false,
          approvalId: fence.approvalId,
          path: fence.canonicalPath,
          effect: effect.kind,
          provenance: fence.provenance,
        };
    }
  }
  return { allowed: true };
}

/** Bounded legacy mapping, not arbitrary inference from model text. */
export function knownApprovalEffects(
  toolName: string,
  args: unknown,
  targets: readonly string[],
  effect: string,
): EffectIntent[] {
  const value = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === "files" && Array.isArray(value.ops)) {
    const effects: EffectIntent[] = [];
    for (const raw of value.ops) {
      if (!raw || typeof raw !== "object") continue;
      const op = raw as Record<string, unknown>;
      if (typeof op.path !== "string") continue;
      if (op.op === "delete") effects.push({ kind: "remove", path: op.path });
      else if (op.op === "move" && typeof op.to === "string")
        effects.push({ kind: "relocate", path: op.path, to: op.to });
      else if (op.op === "copy" && typeof op.to === "string")
        effects.push({ kind: "create", path: op.to });
      else if (op.op === "mkdir") effects.push({ kind: "create", path: op.path });
    }
    if (effects.length) return effects;
  }
  if ((toolName === "write" || toolName === "edit") && typeof value.path === "string")
    return [{ kind: "mutate", path: value.path }];
  return effect === "write" || effect === "destructive"
    ? targets
        .filter((path) => normalizeAccessPath(path) !== undefined)
        .map((path) => ({ kind: "mutate", path }))
    : [];
}

const cache = new WeakMap<
  DatabaseSync,
  Map<string, { epoch: number; fences: DeniedEffectFence[] }>
>();
/** Original task identity comes from host turn bindings, never model output. */
export function taskDeniedEffects(
  db: DatabaseSync,
  sessionId: string,
  originAgentId: string,
  originTurnId: string,
): DeniedEffectFence[] {
  const epoch = (
    db
      .prepare(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM session_log WHERE session_id=? AND type IN ('approval.decided','contract.authorization')",
      )
      .get(sessionId) as { seq: number }
  ).seq;
  const key = JSON.stringify([sessionId, originAgentId, originTurnId]);
  let entries = cache.get(db);
  if (!entries) {
    entries = new Map();
    cache.set(db, entries);
  }
  const hit = entries.get(key);
  if (hit?.epoch === epoch) return hit.fences;
  const rows = db
    .prepare(
      "SELECT d.seq,d.data AS decision,r.agent_id,r.data AS request FROM session_log d JOIN session_log r ON r.session_id=d.session_id AND r.type='approval.requested' AND json_extract(r.data,'$.approvalId')=json_extract(d.data,'$.approvalId') WHERE d.session_id=? AND d.type='approval.decided' AND json_extract(d.data,'$.decision')='denied' ORDER BY d.seq",
    )
    .all(sessionId) as Array<{ seq: number; decision: string; agent_id: string; request: string }>;
  const fences: DeniedEffectFence[] = [];
  for (const row of rows) {
    const decision = JSON.parse(row.decision) as { approvalId: string; cause?: string };
    if (decision.cause !== undefined && decision.cause !== "user") continue;
    const request = JSON.parse(row.request) as {
      toolName: string;
      args: unknown;
      targets: string[];
      effect: string;
      spec?: {
        turnId?: string;
        originAgentId?: string;
        originTurnId?: string;
        effects?: CapturedEffectIntent[];
      };
    };
    const spec = request.spec;
    const binding = spec?.turnId
      ? turnAccessBinding(db, sessionId, row.agent_id, spec.turnId)
      : undefined;
    const agent = spec?.originAgentId ?? binding?.originAgentId ?? row.agent_id;
    const turn = spec?.originTurnId ?? binding?.originTurnId ?? spec?.turnId;
    if (agent !== originAgentId || turn !== originTurnId) continue;
    const effects: CapturedEffectIntent[] =
      spec?.effects ??
      knownApprovalEffects(request.toolName, request.args, request.targets, request.effect);
    for (const effect of effects) {
      for (const path of [effect.path, ...(effect.to ? [effect.to] : [])]) {
        const canonicalPath = normalizeAccessPath(path);
        if (!canonicalPath) continue;
        fences.push({
          version: 1,
          approvalId: decision.approvalId,
          decisionSeq: row.seq,
          originAgentId,
          originTurnId,
          canonicalPath,
          deniedEffects: ["remove", "replace"],
          ...(effect.identity && path === effect.path ? { identity: effect.identity } : {}),
          provenance: decision.cause === "user" ? "user" : "legacy-unknown",
        });
      }
    }
  }
  const expectedRow = db.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq DESC LIMIT 1",
  ).get(sessionId, originAgentId, originTurnId) as { data: string } | undefined;
  const expected = expectedRow ? JSON.parse(expectedRow.data) as { contractId: string; originTaskId: string } : undefined;
  const authorizations = db.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.authorization' AND json_extract(data,'$.decision')='deny' AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq",
  ).all(sessionId, originAgentId, originTurnId) as { seq: number; data: string }[];
  for (const row of authorizations) {
    const raw = JSON.parse(row.data) as {
      contractId: string; originTaskId: string; questionId: string; deviceId: string; revision: number;
      permission: { operation: unknown; target: unknown };
    };
    if (!expected || raw.contractId !== expected.contractId || raw.originTaskId !== expected.originTaskId) continue;
    if (!raw.questionId || !raw.deviceId || !Number.isSafeInteger(raw.revision) || raw.revision < 1)
      throw new Error("Persisted host denial identity is invalid");
    const operation = ContractOperation.parse(raw.permission.operation);
    const target = ContractTarget.parse(raw.permission.target);
    if (!["create", "mutate", "remove", "relocate"].includes(operation)) continue;
    const canonicalPath = normalizeAccessPath(target.path);
    if (!canonicalPath || canonicalPath !== target.path) throw new Error("Persisted host denial path is invalid");
    fences.push({
      version: 1, approvalId: raw.questionId, decisionSeq: row.seq, originAgentId, originTurnId,
      canonicalPath, deniedEffects: ["remove", "replace"], provenance: "user",
      contractDenial: { operation, target, contractId: raw.contractId, originTaskId: raw.originTaskId, revision: raw.revision },
    });
  }
  entries.set(key, { epoch, fences });
  return fences;
}
