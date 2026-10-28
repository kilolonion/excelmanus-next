import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import { resolveWorkspacePath, type Projection } from "@excelmanus/kernel";
import { ContractRef } from "@excelmanus/protocol";
import { z } from "zod";

const Receipt = z.strictObject({
 id:z.string(),ownerId:z.string(),workspaceId:z.string(),path:z.string(),
 sha256:z.string().regex(/^[0-9a-f]{64}$/),size:z.number().int().nonnegative(),
 device:z.string(),inode:z.string(),issuedAt:z.number(),expiresAt:z.number(),
 originTaskId:z.string().optional(),
});
type Receipt = z.infer<typeof Receipt>;
const key=(id:string)=>"contract.upload."+id;
const digest=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
function load(db:DatabaseSync,id:string):Receipt {
 const row=db.prepare("SELECT value FROM meta WHERE key=?").get(key(id)) as {value:string}|undefined;
 if(!row)throw new Error("Unknown upload receipt");
 return Receipt.parse(JSON.parse(row.value));
}
/** Called only after authenticated, exclusively-created upload bytes have been published. */
export function issueUploadReceipt(db:DatabaseSync,input:{
 ownerId:string;workspaceId:string;workspaceRoot:string;path:string;bytes:Uint8Array;
}):Receipt {
 const {abs,rel}=resolveWorkspacePath(input.workspaceRoot,input.path);
 const fd=openSync(abs,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const st=fstatSync(fd);
  if(!st.isFile()||st.nlink!==1||st.size!==input.bytes.length)throw new Error("Uploaded file changed before receipt");
  const stored=readFileSync(fd);
  if(digest(stored)!==digest(input.bytes))throw new Error("Uploaded bytes changed before receipt");
  const now=Date.now();
  const receipt:Receipt={id:newId("upl"),ownerId:input.ownerId,workspaceId:input.workspaceId,path:rel,
   sha256:digest(stored),size:st.size,device:String(st.dev),inode:String(st.ino),
   issuedAt:now,expiresAt:now+24*3600_000};
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(key(receipt.id),JSON.stringify(receipt));
  return receipt;
 }finally{closeSync(fd);}
}
/** No ownership mutation here. The following journal projection claims in the dispatch transaction. */
export function prepareUploadBinding(db:DatabaseSync,input:{
 ownerId:string;workspaceId:string;workspaceRoot:string;sessionId:string;ref:ContractRef;ids:readonly string[];
}){
 const prior=db.prepare("SELECT data FROM session_log WHERE session_id=? AND type='contract.baseline' AND json_extract(data,'$.contractId')=? ORDER BY seq DESC LIMIT 1")
  .get(input.sessionId,input.ref.contractId) as {data:string}|undefined;
 const inputs:Receipt[]=prior ? (JSON.parse(prior.data).inputs as unknown[]).map(row=>Receipt.parse(row)) : [];
 const ids=[...new Set(input.ids)];
 if(ids.length!==input.ids.length)throw new Error("Duplicate upload receipts");
 for(const id of ids){
  const receipt=load(db,id);
  if(receipt.ownerId!==input.ownerId)throw new Error("Upload receipt belongs to another authenticated device");
  if(receipt.workspaceId!==input.workspaceId)throw new Error("Upload receipt belongs to another workspace");
  if(receipt.originTaskId!==undefined&&receipt.originTaskId!==input.ref.originTaskId)
   throw new Error("Upload receipt cannot be replayed across tasks");
  if(receipt.originTaskId===undefined&&receipt.expiresAt<=Date.now())throw new Error("Upload receipt expired before binding");
  const {abs}=resolveWorkspacePath(input.workspaceRoot,receipt.path);
  const fd=openSync(abs,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
   const before=fstatSync(fd); const bytes=readFileSync(fd); const after=fstatSync(fd);
   const atPath=lstatSync(abs);
   if(!before.isFile()||before.nlink!==1||after.nlink!==1||!atPath.isFile()||atPath.nlink!==1||
      atPath.dev!==after.dev||atPath.ino!==after.ino||
      String(before.dev)!==receipt.device||String(before.ino)!==receipt.inode||
      before.size!==receipt.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||
      digest(bytes)!==receipt.sha256)throw new Error("Uploaded input identity or bytes changed");
  }finally{closeSync(fd);}
  if(!inputs.some(entry=>entry.id===id))inputs.push({...receipt,originTaskId:input.ref.originTaskId});
 }
 return {...input.ref,ownerId:input.ownerId,workspaceId:input.workspaceId,claimIds:ids,inputs};
}
export function uploadBindingProjection():Projection{
 return {
  name:"contract-upload-bindings",
  tables: ["meta"],
  apply(db,record){
   if(record.type!=="contract.baseline")return;
   const data=record.data as {ownerId?:unknown;workspaceId?:unknown;claimIds?:unknown;inputs?:unknown;originTaskId?:unknown};
   const ref=ContractRef.parse({contractId:record.data.contractId,originTaskId:record.data.originTaskId,
    originAgentId:record.data.originAgentId,originTurnId:record.data.originTurnId});
   const ids=z.array(z.string()).max(64).parse(data.claimIds);
   const inputs=z.array(Receipt).parse(data.inputs);
   for(const id of ids){
    const receipt=load(db,id);
    if(receipt.ownerId!==data.ownerId||receipt.workspaceId!==data.workspaceId||
       receipt.originTaskId!==undefined&&receipt.originTaskId!==ref.originTaskId||
       receipt.originTaskId===undefined&&receipt.expiresAt<=Date.now())
     throw new Error("Upload ownership changed before dispatch commit");
    const bound=inputs.find(entry=>entry.id===id);
    if(!bound||bound.sha256!==receipt.sha256||bound.path!==receipt.path||bound.inode!==receipt.inode)
     throw new Error("Upload manifest does not match issued receipt");
    db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify({...receipt,originTaskId:ref.originTaskId}),key(id));
   }
  },
  clear(){ /* Claimed receipts cannot be reassigned by deleting a conversation. */ },
 };
}
