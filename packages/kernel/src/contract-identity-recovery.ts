import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ContractOperation } from "@excelmanus/protocol";
import { normalizeAccessPath } from "./access-scope.ts";
import type { SessionLog } from "./session-log.ts";
import { assertContractAccess, lookupApprovedContractIdentity, lookupHostUserMutationAuthority } from "./task-contract.ts";
import { assertCommittedFileBatchIdentityTransition, assertPreparedAtomicIdentityTransition, recheckPublishedAtomicIdentityAuthorization, type AtomicIdentityTransition, type FileBatchIdentityTransition } from "./backup.ts";

const PREFIX="contract.identity.pending.";
const id=z.string().min(1).max(256);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const numberText=z.string().regex(/^[0-9]+$/);
const path=z.string().min(1).refine(value=>normalizeAccessPath(value)===value,"canonical path required");
export const ContractPhysicalIdentity=z.discriminatedUnion("exists",[
 z.strictObject({path,exists:z.literal(false)}),
 z.strictObject({path,exists:z.literal(true),device:numberText,inode:numberText,nlink:z.literal("1"),size:numberText,sha256:sha,mtime:numberText,ctime:numberText}),
]);
const hostMutation=z.strictObject({dispatchId:id,uploadId:id,path});
const effect=z.strictObject({operation:ContractOperation,path,to:path.optional(),sheetId:id.optional(),range:z.string().min(1).optional(),objectId:id.optional(),expectedRevision:z.number().int().nonnegative().optional()});
export const ContractIdentityRecoveryRecord=z.strictObject({
 version:z.literal(1),state:z.literal("committed-awaiting-identity"),
 sessionId:id,workspaceId:id,contractId:id,originTaskId:id,originAgentId:id,originTurnId:id,
 operationId:id,contractRevision:z.number().int().positive(),
 authorizationQuestionIds:z.array(id).max(64),
 hostMutation:hostMutation.optional(),
 effects:z.array(effect).min(1).max(256),
 resources:z.array(z.strictObject({path,before:ContractPhysicalIdentity,after:ContractPhysicalIdentity})).min(1).max(256),
 recovery:z.strictObject({fileBatchId:id,manifest:z.strictObject({
  items:z.array(z.strictObject({path,saved:z.string().regex(/^[0-9]+$/),before:sha.nullable(),after:sha.nullable()})).min(1).max(256),
  parents:z.array(path).max(256),
 })}).optional(),
 atomicRecovery:z.strictObject({preparedDigest:sha,temp:ContractPhysicalIdentity,backup:ContractPhysicalIdentity.optional()}).optional(),
}).superRefine((record,ctx)=>{
 if(record.atomicRecovery){
  const item=record.resources[0],atomic=record.atomicRecovery;
  if(record.recovery||record.resources.length!==1||!item||!atomic.temp.exists||!item.after.exists||
    atomic.temp.path===item.path||atomic.temp.device!==item.after.device||atomic.temp.inode!==item.after.inode||
    atomic.temp.sha256!==item.after.sha256||atomic.temp.size!==item.after.size)
   ctx.addIssue({code:"custom",message:"atomic publication identity or recovery conflict"});
  if(item?.before.exists?(!atomic.backup?.exists||atomic.backup.sha256!==item.before.sha256||atomic.backup.size!==item.before.size):atomic.backup!==undefined)
   ctx.addIssue({code:"custom",message:"atomic recovery lacks matching original backup"});
 }
 if(record.hostMutation){
  const writes=record.effects.filter(item=>["create","mutate","remove","relocate"].includes(item.operation));
  if(!record.atomicRecovery||record.authorizationQuestionIds.length||writes.length!==1||writes[0]?.operation!=="mutate"||writes[0]?.path!==record.hostMutation.path)
   ctx.addIssue({code:"custom",message:"Host mutation provenance requires one atomic exact-file mutation"});
 }else if(!record.authorizationQuestionIds.length)ctx.addIssue({code:"custom",message:"Missing identity authorization"});
 const seen=new Set<string>();
 for(const resource of record.resources){
  if(seen.has(resource.path)||resource.before.path!==resource.path||resource.after.path!==resource.path)
   ctx.addIssue({code:"custom",message:"resource identity path conflict"});
  seen.add(resource.path);
  if(!record.effects.some(item=>["create","mutate","remove","relocate"].includes(item.operation)&&(item.path===resource.path||item.to===resource.path)))
   ctx.addIssue({code:"custom",message:"resource missing exact write effect"});
 }
 if(new Set(record.authorizationQuestionIds).size!==record.authorizationQuestionIds.length)
  ctx.addIssue({code:"custom",message:"duplicate authorization identity"});
 for(const item of record.effects){
  if(["create","mutate","remove","relocate"].includes(item.operation)&&
    (!seen.has(item.path)||(item.to!==undefined&&!seen.has(item.to))))
   ctx.addIssue({code:"custom",message:"write effect lacks complete physical identity"});
 }
 const issue=(message:string)=>ctx.addIssue({code:"custom",message});
 const effectKeys=new Set<string>(),writes=new Map<string,string>();
 const moves=record.effects.filter(item=>item.operation==="relocate");
 for(const item of record.effects){
  const effectKey=JSON.stringify(item);
  if(effectKeys.has(effectKey))issue("duplicate operation effect");
  effectKeys.add(effectKey);
  if(item.operation==="relocate"&&!item.to)issue("relocate requires an exact destination");
 }
 for(const item of moves){
  if(!item.to)continue;
  const source=record.resources.find(resource=>resource.path===item.path);
  const target=record.resources.find(resource=>resource.path===item.to);
  if(item.path===item.to||!source?.before.exists||source.after.exists||
     !target||target.before.exists||!target.after.exists||
     source.before.sha256!==target.after.sha256)issue("invalid relocation physical transition");
  for(const targetPath of [item.path,item.to]){
   if(writes.has(targetPath))issue("overlapping physical write transitions");
   writes.set(targetPath,"relocate");
  }
 }
 for(const item of record.effects){
  if(!["create","mutate","remove"].includes(item.operation))continue;
  const resource=record.resources.find(value=>value.path===item.path);
  const moveDerived=moves.some(move=>
    item.operation==="remove"&&move.path===item.path||
    item.operation==="create"&&move.to===item.path);
  if(writes.has(item.path)&&!moveDerived)issue("conflicting physical write transitions");
  if(!moveDerived)writes.set(item.path,item.operation);
  if(!resource)continue;
  if(item.operation==="create"&&(resource.before.exists||!resource.after.exists))issue("create requires absent preimage and present afterimage");
  if(item.operation==="mutate"&&(!resource.before.exists||!resource.after.exists))issue("mutate requires present before and after identities");
  if(item.operation==="remove"&&(!resource.before.exists||resource.after.exists))issue("remove requires present preimage and absent afterimage");
 }
 if(record.recovery){
  const paths=new Set<string>(),saved=new Set<string>();
  for(const item of record.recovery.manifest.items){
   const resource=record.resources.find(value=>value.path===item.path);
   if(!resource||paths.has(item.path)||saved.has(item.saved)||
      item.before!==(resource.before.exists?resource.before.sha256:null)||
      item.after!==(resource.after.exists?resource.after.sha256:null))
    ctx.addIssue({code:"custom",message:"recovery manifest identity conflict"});
   paths.add(item.path);saved.add(item.saved);
  }
  if(paths.size!==seen.size)ctx.addIssue({code:"custom",message:"recovery manifest is incomplete"});
  const parents=record.recovery.manifest.parents;
  if(new Set(parents).size!==parents.length||parents.some(parent=>parent==="."||
    !record.resources.some(resource=>!resource.before.exists&&resource.path.startsWith(parent+"/"))))
   ctx.addIssue({code:"custom",message:"recovery parent is not a newly created resource ancestor"});
 }
});
/** Prepared records retain recovery material only; they are never read grants or success receipts. */
export const ContractPreparedIdentityRecord=z.strictObject({
 version:z.literal(1),state:z.literal("prepared"),
 sessionId:id,workspaceId:id,contractId:id,originTaskId:id,originAgentId:id,originTurnId:id,
 operationId:id,contractRevision:z.number().int().positive(),
 authorizationQuestionIds:z.array(id).max(64),
 hostMutation:hostMutation.optional(),
 effects:z.array(effect).min(1).max(256),
 resource:z.strictObject({path,before:ContractPhysicalIdentity,temp:ContractPhysicalIdentity,backup:ContractPhysicalIdentity.optional()}),
}).superRefine((record,ctx)=>{
 const issue=(message:string)=>ctx.addIssue({code:"custom",message});
 const {path:target,before,temp,backup}=record.resource;
 if(before.path!==target||!temp.exists||temp.path===target)issue("Prepared temporary identity is incomplete or not independent");
 const writes=record.effects.filter(item=>["create","mutate","remove","relocate"].includes(item.operation));
 if(writes.length!==1||writes[0]!.path!==target||!["create","mutate"].includes(writes[0]!.operation)||writes[0]!.to)
  issue("Prepared publication requires one exact create or mutate effect");
 if(writes[0]?.operation==="create"&&(before.exists||backup!==undefined))issue("Exclusive create requires absent preimage without backup");
 if(writes[0]?.operation==="mutate"&&!before.exists)issue("Mutation requires an existing preimage");
 if(record.hostMutation&&(record.authorizationQuestionIds.length||writes[0]?.operation!=="mutate"||record.hostMutation.path!==target))
  issue("Host mutation provenance requires one exact-file mutation");
 if(before.exists){
  if(!backup?.exists||backup.path===target||backup.path===temp.path||
    backup.sha256!==before.sha256||backup.size!==before.size)issue("Prepared replacement requires a complete matching original backup");
  if(temp.exists&&temp.device===before.device&&temp.inode===before.inode)issue("Temporary file aliases the original");
  if(backup?.exists&&backup.device===before.device&&backup.inode===before.inode)issue("Backup aliases the original");
 }
 if(temp.exists&&backup?.exists&&temp.device===backup.device&&temp.inode===backup.inode)issue("Temporary file aliases the backup");
 if(new Set(record.authorizationQuestionIds).size!==record.authorizationQuestionIds.length)issue("Duplicate authorization identity");
});
export type ContractPreparedIdentityRecord=z.infer<typeof ContractPreparedIdentityRecord>;
export type ContractIdentityRecoveryRecord=z.infer<typeof ContractIdentityRecoveryRecord>;
export interface PendingContractIdentityRecovery {record:ContractIdentityRecoveryRecord;digest:string}
export interface ContractRecoveryOrigin {sessionId:string;originTaskId:string;originAgentId:string;originTurnId:string;contractId:string}
function canonical(value:unknown):string{
 if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
 if(value&&typeof value==="object")return "{"+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+":"+canonical(v)).join(",")+"}";
 return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
function originPrefix(origin:ContractRecoveryOrigin){return PREFIX+digest([origin.sessionId,origin.originTaskId,origin.originAgentId,origin.originTurnId,origin.contractId])+".";}
function key(record:ContractIdentityRecoveryRecord){return originPrefix(record)+digest(record.operationId);}
function decode(value:string):PendingContractIdentityRecovery{
 const raw=JSON.parse(value);
 if(!raw||Object.keys(raw).some(k=>k!=="record"&&k!=="digest"))throw new Error("Corrupt identity recovery envelope");
 const record=ContractIdentityRecoveryRecord.parse(raw.record);
 if(raw.digest!==digest(record))throw new Error("Corrupt identity recovery digest");
 return {record,digest:raw.digest};
}
export interface PendingPreparedContractIdentity {record:ContractPreparedIdentityRecord;digest:string}
const PREPARED_PREFIX="contract.identity.prepared.";
const preparedKey=(record:ContractPreparedIdentityRecord)=>PREPARED_PREFIX+digest([record.sessionId,record.originTaskId,record.originAgentId,record.originTurnId,record.contractId])+"."+digest(record.operationId);
function decodePrepared(value:string):PendingPreparedContractIdentity{
 const raw=JSON.parse(value);
 if(!raw||Object.keys(raw).some(k=>k!=="record"&&k!=="digest"))throw new Error("Corrupt prepared envelope");
 const record=ContractPreparedIdentityRecord.parse(raw.record);
 if(raw.digest!==digest(record))throw new Error("Corrupt prepared digest");
 return {record,digest:raw.digest};
}
function preparedFromCommitted(record:ContractIdentityRecoveryRecord):ContractPreparedIdentityRecord{
 const atomic=record.atomicRecovery,resource=record.resources[0];
 if(!atomic||record.resources.length!==1||!resource)throw new Error("Atomic recovery source is missing");
 const {resources:unusedResources,recovery:unusedBatch,atomicRecovery:unusedAtomic,state:unusedState,...fields}=record;
 const prepared=ContractPreparedIdentityRecord.parse({...fields,state:"prepared",resource:{
  path:resource.path,before:resource.before,temp:atomic.temp,...(atomic.backup?{backup:atomic.backup}:{})}});
 if(digest(prepared)!==atomic.preparedDigest)throw new Error("Committed atomic record differs from its prepared source");
 return prepared;
}
/** Fixed producer only. The opaque credential verifies the actual staged files before this insert. */
export function stagePreparedContractIdentity(db:DatabaseSync,input:unknown,token:AtomicIdentityTransition):PendingPreparedContractIdentity{
 if(db.isTransaction)throw new Error("Prepared publication cannot join an unrelated transaction");
 const record=ContractPreparedIdentityRecord.parse(input);
 assertPreparedAtomicIdentityTransition(token,db,record,"prepare");
 const pending={record,digest:digest(record)};
 const previous=db.prepare("SELECT value FROM meta WHERE key=?").get(preparedKey(record)) as {value:string}|undefined;
 if(previous){
  const existing=decodePrepared(previous.value);
  if(existing.digest!==pending.digest)throw new Error("Prepared operation conflict");
  return existing;
 }
 db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(preparedKey(record),JSON.stringify(pending));
 return pending;
}
/** Read-only recovery diagnostics. No prepared record is a resource grant. */
export function readPreparedContractIdentities(db:DatabaseSync,origin:ContractRecoveryOrigin):PendingPreparedContractIdentity[]{
 const prefix=PREPARED_PREFIX+digest([origin.sessionId,origin.originTaskId,origin.originAgentId,origin.originTurnId,origin.contractId])+".";
 const rows=db.prepare("SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key").all(prefix+"%") as {key:string;value:string}[];
 return rows.map(row=>{const pending=decodePrepared(row.value);if(preparedKey(pending.record)!==row.key)throw new Error("Prepared identity origin or key is corrupt");return pending;});
}
export interface PendingContractIdentityWrite {
 key:string;digest:string;state:"prepared"|"committed-awaiting-identity";
 record:ContractPreparedIdentityRecord|ContractIdentityRecoveryRecord;paths:string[];
}
/** Internal safety diagnostics. Strong-decode before workspace filtering so damaged scope cannot disappear. */
export function pendingContractIdentityWrites(db:DatabaseSync,workspaceId:string):PendingContractIdentityWrite[]{
 const rows=db.prepare("SELECT key,value FROM meta WHERE key GLOB ? OR key GLOB ? ORDER BY key")
  .all(PREPARED_PREFIX+"*",PREFIX+"*") as {key:string;value:string}[];
 const results:PendingContractIdentityWrite[]=[];
 for(const row of rows){
  const prepared=row.key.startsWith(PREPARED_PREFIX);
  const pending=prepared?decodePrepared(row.value):decode(row.value);
  const expectedKey=prepared?preparedKey(pending.record as ContractPreparedIdentityRecord):key(pending.record as ContractIdentityRecoveryRecord);
  if(expectedKey!==row.key)throw new Error("Unresolved identity metadata has an invalid storage scope; writes remain blocked");
  if(pending.record.workspaceId!==workspaceId)continue;
  const paths=pending.record.state==="prepared"?[pending.record.resource.path]:pending.record.resources.map(value=>value.path);
  results.push({key:row.key,digest:pending.digest,state:pending.record.state,record:pending.record,paths});
 }
 return results;
}
/** FS publication already happened. Failure keeps recovery material and never undoes the file. */
export function promotePreparedContractIdentity(db:DatabaseSync,input:PendingPreparedContractIdentity,committedInput:unknown,token:AtomicIdentityTransition):PendingContractIdentityRecovery{
 if(db.isTransaction)throw new Error("Prepared promotion cannot join an unrelated transaction");
 const prepared=decodePrepared(JSON.stringify(input)),record=ContractIdentityRecoveryRecord.parse(committedInput);
 if(canonical(preparedFromCommitted(record))!==canonical(prepared.record))throw new Error("Atomic promotion changed prepared operation");
 assertPreparedAtomicIdentityTransition(token,db,prepared.record,"published",record);
 db.exec("BEGIN IMMEDIATE");
 try{
  recheckPublishedAtomicIdentityAuthorization(token,db,prepared.record,record);
  const existing=db.prepare("SELECT value FROM meta WHERE key=?").get(preparedKey(prepared.record)) as {value:string}|undefined;
  if(!existing){
   const previous=readContractIdentityRecoveries(db,record).find(value=>value.record.operationId===record.operationId);
   if(!previous||previous.digest!==digest(record))throw new Error("Prepared publication metadata is missing");
   db.exec("COMMIT");return previous;
  }
  if(decodePrepared(existing.value).digest!==prepared.digest)throw new Error("Prepared publication metadata changed");
  const pending=stageContractIdentityRecovery(db,record);
  const removed=db.prepare("DELETE FROM meta WHERE key=? AND value=?").run(preparedKey(prepared.record),existing.value);
  if(Number(removed.changes)!==1)throw new Error("Prepared promotion compare-and-delete failed");
  db.exec("COMMIT");return pending;
 }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}
}
/** Recovery metadata is NOT a grant or a success proof. The caller owns the synchronous business transaction.
 * No transaction is started, committed or rolled back here. No filesystem action or event is emitted.
 */
export function stageContractIdentityRecovery(db:DatabaseSync,input:unknown):PendingContractIdentityRecovery{
 if(!db.isTransaction)throw new Error("Identity recovery must join the active business transaction");
 const record=ContractIdentityRecoveryRecord.parse(input);
 const pending={record,digest:digest(record)};
 const existing=db.prepare("SELECT value FROM meta WHERE key=?").get(key(record)) as {value:string}|undefined;
 if(existing){
  const previous=decode(existing.value);
  if(previous.digest!==pending.digest)throw new Error("Identity recovery operation conflict: different committed fields");
  return previous;
 }
 db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(key(record),JSON.stringify(pending));
 return pending;
}
/** Only current-origin records are returned. Corruption is never silently discarded or rebuilt away. */
export function readContractIdentityRecoveries(db:DatabaseSync,origin:ContractRecoveryOrigin):PendingContractIdentityRecovery[]{
 const rows=db.prepare("SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key")
  .all(originPrefix(origin)+"%") as {key:string;value:string}[];
 return rows.map(row=>{
  const pending=decode(row.value);
  if(key(pending.record)!==row.key)throw new Error("Identity recovery storage key or origin is corrupt");
  return pending;
 });
}


/** Internal producer boundary. Only the fixed BackupService COMMIT transition may
 * call this; pending metadata by itself is never sufficient to publish a proof. */
export function appendVerifiedContractIdentity(
 db:DatabaseSync,log:SessionLog,pending:PendingContractIdentityRecovery,
 transition:FileBatchIdentityTransition|AtomicIdentityTransition,
):{receiptSeq:number;digest:string;alreadyRecorded:boolean}{
 if(db.isTransaction)throw new Error("Identity proof must be appended after the business commit");
 const checked=decode(JSON.stringify(pending));
 if(checked.record.atomicRecovery){
  const prepared=preparedFromCommitted(checked.record);
  assertPreparedAtomicIdentityTransition(transition as AtomicIdentityTransition,db,prepared,"published",checked.record);
 }else assertCommittedFileBatchIdentityTransition(transition as FileBatchIdentityTransition,db,checked);
 const record=checked.record;
 const stored=readContractIdentityRecoveries(db,record).find(item=>item.record.operationId===record.operationId);
 if(!stored||stored.digest!==checked.digest)throw new Error("Committed identity recovery metadata is missing or changed");
 const access={db,sessionId:record.sessionId,originAgentId:record.originAgentId,originTurnId:record.originTurnId,contractExpected:true};
 const prior=recordedIdentityReceipts(db,record);
 if(prior.length){
  for(const effect of record.effects)assertContractAccess(access,{...effect,expectedRevision:record.contractRevision});
  if(prior.some(item=>item.pending.digest!==checked.digest))throw new Error("Conflicting identity receipts for one operation");
  return {receiptSeq:prior[0]!.seq,digest:checked.digest,alreadyRecorded:true};
 }
 const questions=new Set<string>();
 for(const effect of record.effects){
  assertContractAccess(access,{...effect,expectedRevision:record.contractRevision});
  if(!["create","mutate","remove","relocate"].includes(effect.operation))continue;
  const approved=lookupApprovedContractIdentity(access,effect);
  if(!approved){
   if(effect.operation==="mutate"&&record.hostMutation&&record.atomicRecovery){
    const host=lookupHostUserMutationAuthority(access,effect);
    const before=record.resources.find(item=>item.path===effect.path)?.before;
    if(!host||canonical(host.provenance)!==canonical(record.hostMutation)||!before?.exists||
      host.identity.device!==before.device||host.identity.inode!==before.inode||
      String(host.identity.size)!==before.size||host.identity.sha256!==before.sha256)
     throw new Error("Committed write does not continue its authenticated user/upload identity");
    continue;
   }
   if(effect.operation!=="create")throw new Error("Committed write has no precise approval identity");
   continue;
  }
  const resource=record.resources.find(item=>item.path===effect.path);
  if(!resource||approved.identity.exists!==resource.before.exists||
    approved.identity.exists&&resource.before.exists&&
    ["device","inode","size","mtime","ctime"].some(field=>
      (approved.identity as unknown as Record<string,unknown>)[field]!== (resource.before as unknown as Record<string,unknown>)[field]))
   throw new Error("Committed operation does not continue its approved resource identity");
  questions.add(approved.questionId);
 }
 if(canonical([...questions].sort())!==canonical([...record.authorizationQuestionIds].sort()))
  throw new Error("Committed identity authorization set differs from its exact write plan");
 const appended=log.append(record.sessionId,record.originAgentId,[{
  type:"contract.identity.advanced",data:checked,
 }]);
 if(appended.length!==1)throw new Error("Committed identity receipt was not persisted");
 return {receiptSeq:appended[0]!.seq,digest:checked.digest,alreadyRecorded:false};
}
function recordedIdentityReceipts(db:DatabaseSync,record:ContractIdentityRecoveryRecord){
 const rows=db.prepare("SELECT seq,data FROM session_log WHERE session_id=? AND type='contract.identity.advanced' AND json_extract(data,'$.record.originTaskId')=? AND json_extract(data,'$.record.originAgentId')=? AND json_extract(data,'$.record.originTurnId')=? AND json_extract(data,'$.record.contractId')=? AND json_extract(data,'$.record.operationId')=? ORDER BY seq")
  .all(record.sessionId,record.originTaskId,record.originAgentId,record.originTurnId,record.contractId,record.operationId) as {seq:number;data:string}[];
 return rows.map(row=>({seq:row.seq,pending:decode(row.data)}));
}
/** Clearing metadata never modifies files or removes backups. The fixed producer
 * cleans redundant storage only after this exact receipt check has succeeded. */
export function clearRecordedContractIdentity(db:DatabaseSync,pending:PendingContractIdentityRecovery):void{
 if(db.isTransaction)throw new Error("Identity cleanup must not join an unrelated transaction");
 const checked=decode(JSON.stringify(pending));
 const receipts=recordedIdentityReceipts(db,checked.record);
 if(!receipts.length||receipts.some(item=>item.pending.digest!==checked.digest))
  throw new Error("Cannot clear pending identity without its exact committed receipt");
 const existing=db.prepare("SELECT value FROM meta WHERE key=?").get(key(checked.record)) as {value:string}|undefined;
 if(!existing)return;
 if(decode(existing.value).digest!==checked.digest)throw new Error("Pending identity changed before cleanup");
 const removed=db.prepare("DELETE FROM meta WHERE key=? AND value=?").run(key(checked.record),existing.value);
 if(Number(removed.changes)!==1){
  const remaining=db.prepare("SELECT value FROM meta WHERE key=?").get(key(checked.record)) as {value:string}|undefined;
  if(remaining)throw new Error("Pending identity changed during compare-and-delete cleanup; preserve recovery backups");
 }
}


export type ContractIdentityAnchor =
 | {path:string;exists:false}
 | {path:string;exists:true;device:string;inode:string;size:string;sha256?:string;mtime?:string;ctime?:string};
/** Read-only receipt projection. It never consults pending metadata as authority.
 * The caller retains its logical read grant and must verify returned bytes on the same FD. */
export function advanceContractReadIdentity(
 db:DatabaseSync,origin:ContractRecoveryOrigin,anchor:ContractIdentityAnchor,afterSeq=0,authorizationQuestionId?:string,
):z.infer<typeof ContractPhysicalIdentity>|undefined{
 if(!Number.isSafeInteger(afterSeq)||afterSeq<0)throw new Error("Invalid host identity anchor sequence");
 const rows=db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.identity.advanced' AND json_extract(data,'$.record.originTaskId')=? AND json_extract(data,'$.record.originAgentId')=? AND json_extract(data,'$.record.originTurnId')=? AND json_extract(data,'$.record.contractId')=? AND seq>? ORDER BY seq")
  .all(origin.sessionId,origin.originTaskId,origin.originAgentId,origin.originTurnId,origin.contractId,afterSeq) as {data:string}[];
 let current:ContractIdentityAnchor=anchor,advanced=false;
 const operations=new Map<string,string>(),branches=new Map<string,string>();
 const matches=(before:z.infer<typeof ContractPhysicalIdentity>,expected:ContractIdentityAnchor)=>{
  if(before.path!==expected.path||before.exists!==expected.exists)return false;
  if(!before.exists||!expected.exists)return true;
  return Object.entries(expected).every(([field,value])=>value===undefined||
   (before as unknown as Record<string,unknown>)[field]===value);
 };
 for(const row of rows){
  const pending=decode(row.data),record=pending.record;
  if(record.sessionId!==origin.sessionId||record.contractId!==origin.contractId||
     record.originTaskId!==origin.originTaskId||record.originAgentId!==origin.originAgentId||
     record.originTurnId!==origin.originTurnId)throw new Error("Identity successor origin mismatch");
  if(authorizationQuestionId!==undefined&&!record.authorizationQuestionIds.includes(authorizationQuestionId))continue;
  const prior=operations.get(record.operationId);
  if(prior!==undefined){
   if(prior!==pending.digest)throw new Error("Conflicting identity operation receipts");
   continue;
  }
  operations.set(record.operationId,pending.digest);
  const resource=record.resources.find(value=>value.path===anchor.path);
  if(!resource)continue;
  const beforeKey=canonical(resource.before),afterKey=canonical(resource.after);
  const branch=branches.get(beforeKey);
  if(branch!==undefined&&branch!==afterKey)throw new Error("Branched identity successor chain");
  branches.set(beforeKey,afterKey);
  if(!matches(resource.before,current))throw new Error("Discontinuous identity successor chain");
  current=resource.after;advanced=true;
 }
 return advanced?ContractPhysicalIdentity.parse(current):undefined;
}


/** Recovery safety latch only, never read authority or a success proof.
 * Validate all relevant identity envelopes before deciding a legacy batch may undo.
 * Corrupt records are preserved and stop automatic recovery. */
export function hasCommittedContractIdentityBatch(db:DatabaseSync,fileBatchId:string):boolean{
 let found=false;
 const pendingRows=db.prepare("SELECT key,value FROM meta WHERE key LIKE ?").all(PREFIX+"%") as {key:string;value:string}[];
 for(const row of pendingRows){
  const pending=decode(row.value);
  if(key(pending.record)!==row.key)throw new Error("Corrupt identity recovery key blocks automatic undo");
  if(pending.record.recovery?.fileBatchId===fileBatchId)found=true;
 }
 const receipts=db.prepare("SELECT data FROM session_log WHERE type='contract.identity.advanced' ORDER BY session_id,seq").all() as {data:string}[];
 for(const row of receipts){
  const pending=decode(row.data);
  if(pending.record.recovery?.fileBatchId===fileBatchId)found=true;
 }
 return found;
}
