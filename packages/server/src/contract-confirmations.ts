import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import { inspectPendingContractTargetIdentity, taskContractState, turnAccessBinding, type NewRecord, type SessionLog } from "@excelmanus/kernel";
import { ContractRef, TaskContract } from "@excelmanus/protocol";

const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
type RequestContext={db:DatabaseSync;log:SessionLog;sessionId:string;agentId:string;turnId:string;workspaceRoot:string;toolCallId:string;stepId:string};
export function requestContractConfirmation(ctx:RequestContext,permissionId:string|readonly string[]){
 const binding=turnAccessBinding(ctx.db,ctx.sessionId,ctx.agentId,ctx.turnId);
 const ref=binding?.contractRef;
 if(!ref)throw new Error("没有可信任务契约");
 const contract=taskContractState({db:ctx.db,sessionId:ctx.sessionId,...ref,contractExpected:true});
 if(!contract)throw new Error("契约不可用");
 const ids=typeof permissionId==="string"?[permissionId]:[...permissionId];
 if(!ids.length||ids.length>16||new Set(ids).size!==ids.length)throw new Error("确认权限必须是1至16个不同的待确认项");
 const entries=ids.map(id=>{
  const permission=contract.permissions.find(p=>p.id===id);
  if(!permission||permission.state!=="needs_confirmation")throw new Error("该权限不是当前待确认差异");
  const identity=inspectPendingContractTargetIdentity({db:ctx.db,sessionId:ctx.sessionId,...ref,workspaceRoot:ctx.workspaceRoot,contractExpected:true},id);
  const diff={operation:permission.operation,target:permission.target,identity,atomicGroups:contract.atomicGroups??[]};
  return {permission,diff,diffHash:hash(diff)};
 });
 const questionId=newId("qst"), first=entries[0]!;
 const request={...ref,questionId,revision:contract.revision,contractHash:hash(contract),...first,
  ...(entries.length>1?{batch:entries}:{})};
 const summary=(entries.length>1?"仅确认以下全部额外权限，不解除已有拒绝或禁止：":"仅确认这一项额外权限，不解除已有拒绝或禁止：")+JSON.stringify(entries.length>1?entries.map(item=>item.diff):first.diff);
 ctx.log.append(ctx.sessionId,ctx.agentId,[
  {type:"contract.confirmation.requested",data:request},
  {type:"question.asked",data:{questionId,questionType:"choice",spec:{
   title:"确认具体权限差异",question:summary,options:[{value:"approve",label:"仅批准以上差异"},{value:"deny",label:"拒绝以上差异"}],
   _runtime:{toolCallId:ctx.toolCallId,toolName:"contract",turnId:ctx.turnId,stepId:ctx.stepId},
  }}},
 ]);
 return {questionId,status:"pending"};
}

/** Called only by the authenticated REST answer path; ordinary question specs never grant authority. */
export function contractConfirmationRecords(db:DatabaseSync,questionId:string,answer:unknown,workspaceRoot:string,deviceId:string):NewRecord[]{
 const row=db.prepare("SELECT session_id,agent_id,status FROM pending_interactions WHERE id=? AND kind='question'").get(questionId) as {session_id:string;agent_id:string;status:string}|undefined;
 if(!row||row.status!=="pending")return [];
 const requestRow=db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.confirmation.requested' AND json_extract(data,'$.questionId')=? ORDER BY seq DESC LIMIT 1")
  .get(row.session_id,questionId) as {data:string}|undefined;
 if(!requestRow)return [];
 if(answer!=="approve"&&answer!=="deny")throw new Error("权限确认只接受宿主列出的明确批准或拒绝");
 const raw=JSON.parse(requestRow.data);
 const ref=ContractRef.parse({contractId:raw.contractId,originTaskId:raw.originTaskId,originAgentId:raw.originAgentId,originTurnId:raw.originTurnId});
 const contract=taskContractState({db,sessionId:row.session_id,...ref,contractExpected:true});
 if(!contract||contract.revision!==raw.revision||hash(contract)!==raw.contractHash)
  throw new Error("契约或用户限制已变化，旧确认不可复用");
 const entries=Array.isArray(raw.batch)?raw.batch:[raw];
 if(!entries.length||entries.length>16||new Set(entries.map((item:{permission?:{id?:unknown}})=>item.permission?.id)).size!==entries.length)
  throw new Error("确认权限列表无效");
 // Validate the entire frozen batch before producing any authorization or revision.
 const verified: {permission: ReturnType<typeof TaskContract.parse>["permissions"][number]; diff: {operation: ReturnType<typeof TaskContract.parse>["permissions"][number]["operation"]; target: ReturnType<typeof TaskContract.parse>["permissions"][number]["target"]; identity: ReturnType<typeof inspectPendingContractTargetIdentity>; atomicGroups: NonNullable<ReturnType<typeof TaskContract.parse>["atomicGroups"]>}; diffHash: string}[]=entries.map((entry:{permission?:unknown;diffHash?:unknown})=>{
  const requested=TaskContract.shape.permissions.element.parse(entry.permission);
  const permission=contract.permissions.find(p=>p.id===requested.id);
  if(!permission||permission.state!=="needs_confirmation"||hash(permission)!==hash(requested))
   throw new Error("确认差异与当前权限不一致");
  const diff={operation:permission.operation,target:permission.target,identity:inspectPendingContractTargetIdentity({db,sessionId:row.session_id,...ref,workspaceRoot,contractExpected:true},permission.id),atomicGroups:contract.atomicGroups??[]};
  if(hash(diff)!==entry.diffHash)throw new Error("确认资源身份已变化，请重新请求具体权限");
  return {permission,diff,diffHash:String(entry.diffHash)};
 });
 if(!deviceId)throw new Error("权限确认缺少认证主体");
 const ids=new Set(verified.map(item=>item.permission.id));
 const updated=TaskContract.parse({...contract,revision:contract.revision+1,
  permissions:contract.permissions.map(p=>ids.has(p.id)?{...p,state:answer==="approve"?"active":"denied",reason:answer==="approve"?"authenticated exact user confirmation":"explicit user denial"}:p),
  prohibitions:answer==="deny"?[...contract.prohibitions,...verified.map(({permission})=>({id:permission.id,operation:permission.operation,target:permission.target,source:permission.source}))]:contract.prohibitions,
 });
 return [
  ...verified.map(({permission,diff,diffHash}):NewRecord=>({type:"contract.authorization",data:{...ref,questionId,decision:answer,permission,diff,diffHash,deviceId,revision:updated.revision}})),
  {type:"contract.updated",data:{...ref,requestedBy:row.agent_id,contract:updated}},
 ];
}
