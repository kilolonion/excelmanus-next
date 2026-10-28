import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { availableExplicitUserMutationCandidates, availableBaselineReadCandidates, availableCreatedOutputReadGrants, proposeTaskContract, taskContractState, turnAccessBinding, type SessionLog, type ToolDefinition } from "@excelmanus/kernel";
import { TaskContract, type ToolResult } from "@excelmanus/protocol";
import { ModelTaskContractProposal, normalizeProposalSources } from "./contract-proposal-input.ts";
import { z } from "zod";
import { completeBaselineReadMetadata, contractAvailability } from "./contract-read-metadata.ts";

import { requestContractConfirmation } from "./contract-confirmations.ts";
export { requestContractConfirmation } from "./contract-confirmations.ts";
const input = z.union([
 z.strictObject({action:z.literal("status")}),
 z.strictObject({action:z.literal("confirm"),permissionId:z.string().min(1)}),
 z.strictObject({action:z.literal("confirm"),permissionIds:z.array(z.string().min(1)).min(1).max(16)}),
 z.strictObject({action:z.literal("propose"),proposal:ModelTaskContractProposal}),
]);

// Model proposes file permissions and source spans; unsupported sub-file boundaries are never widened.
function modelInputSchema(): Record<string, unknown> {
 const schema = z.toJSONSchema(input, {io: "input"}) as Record<string, unknown>;
 const visit = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(visit); return; }
  const node = value as Record<string, unknown>;
  if (node.properties && typeof node.properties === "object") {
   const properties = node.properties as Record<string, unknown>;
   delete properties.sha256;
   delete properties.sheetId;
   delete properties.range;
   delete properties.objectId;
   if (Array.isArray(node.required)) node.required = node.required.filter(key => !["sha256", "sheetId", "range", "objectId"].includes(String(key)));
  }
  Object.values(node).forEach(visit);
 };
 visit(schema);
 return schema;
}

/**
 * Proposal-base metadata only. A pending contract still grants no access.
 * The union deliberately retains conflicting same-contract or same-origin history;
 * filtering by originTaskId here could hide corruption and falsely report zero.
 */
function pendingProposalRevision(
 db: DatabaseSync,
 sessionId: string,
 binding: NonNullable<ReturnType<typeof turnAccessBinding>>,
): number {
 const ref = binding.contractRef;
 if (!ref || ref.originAgentId !== binding.originAgentId || ref.originTurnId !== binding.originTurnId)
  throw new Error("Contract authority origin is unavailable");
 const rows = db.prepare(
  "SELECT seq,type,data FROM session_log WHERE session_id=? AND type IN ('contract.expected','contract.updated') AND (json_extract(data,'$.contractId')=? OR (json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=?)) ORDER BY seq DESC",
 ).all(sessionId, ref.contractId, ref.originAgentId, ref.originTurnId) as {seq:number;type:string;data:string}[];
 if (rows[0]?.type !== "contract.expected")
  throw new Error("Contract pending authority history is unavailable");
 let revision: number | undefined;
 for (const row of rows) {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  if (data.contractId !== ref.contractId || data.originTaskId !== ref.originTaskId ||
      data.originAgentId !== ref.originAgentId || data.originTurnId !== ref.originTurnId)
   throw new Error("Contract pending authority history is inconsistent");
  if (row === rows[0] &&
      (typeof data.dispatchId !== "string" || !binding.sourceDispatchIds.includes(data.dispatchId)))
   throw new Error("A newer user dispatch is pending; re-read the current contract revision");
  if (row.type === "contract.updated") {
   const previous = TaskContract.parse(data.contract);
   if (previous.originTaskId !== ref.originTaskId)
    throw new Error("Contract pending revision history is inconsistent");
   revision ??= previous.revision;
  }
 }
 // Zero is only a genuine first proposal, never a fallback for unreadable history.
 return revision ?? 0;
}

/** This interface proposes constraints; only the host's stored grants authorize effects. */
export function contractTool(db:DatabaseSync,log:SessionLog):ToolDefinition<z.infer<typeof input>>{
 return {
  name:"contract",title:"任务契约",
  modelContext:ctx=>contractStatus(db,ctx),
  description:"提交任务契约或查看当前授权。首轮宿主上下文已给真实 revision、sources 和候选路径时直接 propose，不必先 status。未申请的范围默认无权；“其他文件/单元格保持不变”放 obligations，不要生成覆盖已申请文件的根目录 tree 禁止项；已有用户禁止必须保留。source可省略，由宿主绑定当前用户原文；局部引用只填start/end，不要计算SHA或猜dispatchId。普通上传读取授权到文件(path/match)，工作表和范围放workbook_read参数；本轮不支持表/区域/对象级权限隔离，用户明确要求时不得静默放宽为文件权限。新建结果文件需要后续读回和验证：提案应在同一精确输出路径同时请求 create、read-content、read-metadata，以及任务需要的 deliver；不要等写完才发现缺读权限。提案不能自行扩大权限；needs_confirmation 的具体部分须先 action:confirm 走用户确认；同一提案的多个待确认项用 permissionIds 一次列齐，用户一次明确确认，逐项身份和版本校验全过才生效，单项仍支持 permissionId，已获授权的独立部分可继续。若输出已经由本任务成功创建，可保留当前全部权限与义务、沿已知 baseRevision 补提该输出的精确读取权限；只有修订号未知或冲突才先 status，不能把 create 自动当作 read。仅列工作区根目录名称时，权限为 enumerate、target:{path:\".\",match:\"exact\"}；根目录不是 inputs/outputs 文件。该精确枚举权限 active 后即可调用 find namesOnly:true；用户原文明示列举由宿主直接认定，仅 needs_confirmation 时才 action:confirm。不授予内容或子项元数据读取。",
  input,inputJsonSchema:modelInputSchema(),output:z.record(z.string(),z.unknown()),effect:"state",targets:()=>[],
  // The current runtime includes question waiting in the tool timer. Match the
  // existing ask_user bounded wait, without changing any other tool budget.
  replay:"safe",timeoutMs:86_400_000,roles:["main","lead","worker","reader"],
  execute(args,ctx){
   const turnId=ctx.turnId;
   if(!turnId)return {status:"error",error:{code:"INVALID_ARGUMENT",message:"缺少宿主任务轮次",retryable:false}};
   const binding=turnAccessBinding(db,ctx.sessionId,ctx.agentId,turnId);
   const ref=binding?.contractRef;
   if(!ref)return {status:"error",error:{code:"INVALID_ARGUMENT",message:"本任务没有可信契约入口，不能从路径文本授予权限。",retryable:false}};
   if(args.action==="confirm"){
    try{return {status:"ok",data:requestContractConfirmation({db,log,sessionId:ctx.sessionId,agentId:ctx.agentId,turnId,workspaceRoot:ctx.workspaceRoot,toolCallId:ctx.toolCallId,stepId:ctx.stepId??"contract-confirmation"}, "permissionIds" in args ? args.permissionIds : args.permissionId)};}
    catch(error){return {status:"error",error:{code:"INVALID_ARGUMENT",message:error instanceof Error?error.message:"权限确认无法创建",retryable:false}};}
   }
   if(args.action==="propose"){
    try{
     const normalized=normalizeProposalSources(db,ctx.sessionId,ctx.agentId,turnId,args.proposal);
     const proposal=completeBaselineReadMetadata(db,ctx.sessionId,ref,normalized);
     const contract=proposeTaskContract({db,log,sessionId:ctx.sessionId,agentId:ctx.agentId,turnId},proposal);
     return {status:"ok",data:{contract,...contractAvailability(contract)}};
    }catch(error){return {status:"error",error:{code:"INVALID_ARGUMENT",message:error instanceof Error?error.message:"契约无法验证",retryable:false}};}
   }
   return contractStatus(db,ctx);
  },
 };
}

/** Same read-only projection used by status and the first model context. */
function contractStatus(db: DatabaseSync, ctx: {sessionId:string; agentId:string; turnId?:string}): ToolResult {
 const turnId=ctx.turnId;
 if(!turnId)return {status:"error" as const,error:{code:"INVALID_ARGUMENT" as const,message:"缺少宿主任务轮次",retryable:false}};
 const binding=turnAccessBinding(db,ctx.sessionId,ctx.agentId,turnId);
 const ref=binding?.contractRef;
 if(!ref)return {status:"error" as const,error:{code:"INVALID_ARGUMENT" as const,message:"本任务没有可信契约入口，不能从路径文本授予权限。",retryable:false}};
   let contract:ReturnType<typeof taskContractState>; let diagnostic:string|undefined;
   let revision: number;
   try {
    contract=taskContractState({db,sessionId:ctx.sessionId,...ref,contractExpected:true});
    if (!contract) throw new Error("Contract authority record unavailable");
    revision=contract.revision;
   } catch(error) {
    diagnostic=error instanceof Error?error.message:"契约状态不可用";
    if (diagnostic !== "Contract proposal is pending; this action is not yet authorized")
     return {status:"error",error:{code:"INVALID_ARGUMENT",message:diagnostic,retryable:false}};
    try { revision=pendingProposalRevision(db,ctx.sessionId,binding); }
    catch(historyError) {
     return {status:"error",error:{code:"INVALID_ARGUMENT",
      message:historyError instanceof Error?historyError.message:"契约修订历史不可用",retryable:false}};
    }
   }
   const sources=binding.sourceDispatchIds.flatMap(dispatchId=>{
    const row=db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? ORDER BY seq DESC LIMIT 1")
     .get(ctx.sessionId,dispatchId) as {data:string}|undefined;
    if(!row)return [];
    const data=JSON.parse(row.data) as {text?:unknown;accessInputOrigin?:unknown};
    if(data.accessInputOrigin!=="user"||typeof data.text!=="string")return [];
    return [{dispatchId,start:0,end:data.text.length,sha256:createHash("sha256").update(data.text).digest("hex")}];
   });
   const availableBaselineReads=[
    ...availableBaselineReadCandidates({db,sessionId:ctx.sessionId,...ref,includeActive:true}),
    ...(contract?availableCreatedOutputReadGrants({db,sessionId:ctx.sessionId,...ref,contractExpected:true}):[]),
   ];
   const availableUserWrites=availableExplicitUserMutationCandidates({db,sessionId:ctx.sessionId,agentId:ctx.agentId,turnId});
   return {status:"ok",data:{...ref,status:"pending",...(contract?contractAvailability(contract):{}),revision,contract,sources,availableBaselineReads,availableUserWrites,
    pathGuidance:"上传文件的真实路径见 availableBaselineReads.target.path；原样使用，不自行加 inputs/ 等前缀。列表是可提案候选，不替代当前权限或实际访问时的文件身份核验。",
    ...(diagnostic?{diagnostic}:{}),defaultPolicy:{read:"host-bound uploads and unchanged outputs created by this task only",create:"new outputs/ files only",mutate:"only exact host-bound files explicitly requested for editing by the current user; otherwise confirm",remove:false,external:"unsupported"}}};
}
