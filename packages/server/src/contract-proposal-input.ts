import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { turnAccessBinding } from "@excelmanus/kernel";
import { ContractSourceRef, TaskContractProposal } from "@excelmanus/protocol";
import { z } from "zod";

// Model convenience input only; the persisted proposal still uses the strict protocol schema.
const source = z.strictObject({
  dispatchId: z.string().min(1).optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).describe("可省略，宿主引用当前可信用户消息；选局部原文时只填start/end（可选dispatchId），SHA由宿主计算，不要猜测。");
export const ModelTaskContractProposal = TaskContractProposal.extend({
  objectives: z.array(TaskContractProposal.shape.objectives.element.extend({source: source.optional()})).max(64),
  inputs: z.array(TaskContractProposal.shape.inputs.element.extend({source: source.optional()})).max(256),
  outputs: z.array(TaskContractProposal.shape.outputs.element.extend({source: source.optional()})).max(256),
  permissions: z.array(TaskContractProposal.shape.permissions.element.extend({source: source.optional()})).max(256),
  prohibitions: z.array(TaskContractProposal.shape.prohibitions.element.extend({source: source.optional()})).max(256),
  obligations: z.array(TaskContractProposal.shape.obligations.element.extend({source: source.optional()})).max(256),
  atomicGroups: z.array(TaskContractProposal.shape.atomicGroups.unwrap().element.extend({source: source.optional()})).max(32).optional(),
});
export function normalizeProposalSources(
  db: DatabaseSync, sessionId: string, agentId: string, turnId: string,
  proposal: z.infer<typeof ModelTaskContractProposal>,
): TaskContractProposal {
  for (const permission of [...proposal.permissions, ...proposal.prohibitions]) {
    if (permission.target.sheetId !== undefined || permission.target.range !== undefined ||
        permission.target.objectId !== undefined)
      throw new Error("本轮不支持表/区域/对象级权限边界；不会自动扩大为文件权限。普通上传读取请授权文件，工作表和范围放在读取参数中；若用户明确要求区域权限隔离，请保留限制并说明暂不支持。");
  }
  const binding = turnAccessBinding(db, sessionId, agentId, turnId), ref = binding?.contractRef;
  if (!binding || !ref) throw new Error("缺少当前可信任务来源");
  const row = db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.expected' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1")
    .get(sessionId, ref.contractId) as {data: string} | undefined;
  const expected = row ? JSON.parse(row.data) as Record<string, unknown> : undefined;
  if (!expected || expected.originTaskId !== ref.originTaskId ||
      expected.originAgentId !== ref.originAgentId || expected.originTurnId !== ref.originTurnId ||
      typeof expected.dispatchId !== "string" || !binding.sourceDispatchIds.includes(expected.dispatchId))
    throw new Error("当前可信用户消息不可确定，请重新读取契约状态");
  const complete = (input: z.infer<typeof source> | undefined) => {
    const dispatchId = input?.dispatchId ?? expected.dispatchId as string;
    if (!binding.sourceDispatchIds.includes(dispatchId)) throw new Error("原文引用不属于当前任务");
    const message = db.prepare("SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? ORDER BY seq DESC LIMIT 1")
      .get(sessionId, ref.originAgentId, dispatchId) as {data: string} | undefined;
    const data = message ? JSON.parse(message.data) as {text?: unknown; accessInputOrigin?: unknown} : undefined;
    if (data?.accessInputOrigin !== "user" || typeof data.text !== "string")
      throw new Error("原文引用不是可信用户消息");
    const start = input?.start ?? 0, end = input?.end ?? data.text.length;
    if (start < 0 || end <= start || end > data.text.length) throw new Error("原文引用范围无效");
    const sha256 = createHash("sha256").update(data.text.slice(start, end)).digest("hex");
    if (input?.sha256 !== undefined && input.sha256 !== sha256)
      throw new Error("原文引用SHA不匹配；请省略SHA由宿主计算");
    return ContractSourceRef.parse({dispatchId, start, end, sha256});
  };
  return TaskContractProposal.parse({
    ...proposal,
    objectives: proposal.objectives.map(item => ({...item, source: complete(item.source)})),
    inputs: proposal.inputs.map(item => ({...item, source: complete(item.source)})),
    outputs: proposal.outputs.map(item => ({...item, source: complete(item.source)})),
    permissions: proposal.permissions.map(item => ({...item, source: complete(item.source)})),
    prohibitions: proposal.prohibitions.map(item => ({...item, source: complete(item.source)})),
    obligations: proposal.obligations.map(item => ({...item, source: complete(item.source)})),
    ...(proposal.atomicGroups ? {atomicGroups: proposal.atomicGroups.map(item => ({...item, source: complete(item.source)}))} : {}),
  });
}
