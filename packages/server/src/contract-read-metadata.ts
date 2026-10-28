import type { DatabaseSync } from "node:sqlite";
import { availableBaselineReadCandidates, contractTargetsIntersect } from "@excelmanus/kernel";
import type { TaskContract, TaskContractProposal } from "@excelmanus/protocol";

/** Add only the host-bound metadata prerequisite of an explicitly requested content read. */
export function completeBaselineReadMetadata(
  db: DatabaseSync, sessionId: string,
  ref: {contractId: string; originTaskId: string},
  proposal: TaskContractProposal,
): TaskContractProposal {
  const candidates = availableBaselineReadCandidates({db, sessionId, ...ref, includeActive: true});
  const permissions = [...proposal.permissions];
  for (const read of proposal.permissions) {
    if (read.operation !== "read-content" || read.target.match !== "exact") continue;
    const grant = candidates.find(candidate => candidate.operation === "read-metadata" &&
      candidate.target.path === read.target.path);
    if (!grant || permissions.some(permission => permission.operation === "read-metadata" &&
        contractTargetsIntersect(permission.target, grant.target)) ||
        proposal.prohibitions.some(permission => permission.operation === "read-metadata" &&
          contractTargetsIntersect(permission.target, grant.target))) continue;
    let id = "host_metadata_" + read.id;
    while (permissions.some(permission => permission.id === id)) id += "_";
    permissions.push({id, operation: "read-metadata", target: grant.target, source: read.source});
  }
  return {...proposal, permissions};
}

/** Availability is per permission; unrelated pending requests do not suspend active work. */
export function contractAvailability(contract: TaskContract) {
  const activePermissions = contract.permissions.filter(permission => permission.state === "active");
  const pendingPermissions = contract.permissions.filter(permission => permission.state === "needs_confirmation");
  const deniedPermissions = contract.permissions.filter(permission => permission.state === "denied");
  return {
    status: activePermissions.length ? "active" : pendingPermissions.length ? "needs_confirmation" : "restricted",
    activePermissions, pendingPermissions, deniedPermissions,
    needsConfirmation: pendingPermissions.length > 0,
    continuation: activePermissions.length
      ? "activePermissions 已可直接使用。只在任务确实需要 pendingPermissions 中的额外操作时逐项 confirm，不要因无关待确认项停止已授权读取。"
      : "当前没有可直接执行的权限；需要的额外操作须逐项确认。",
  };
}
