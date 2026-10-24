import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { setImmediate as yieldToControlPlane } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { indexToCol, parseRange } from "@excelmanus/core";
import { assertToolAccess, classifyWorkbookEffect, harnessCheckDefinitionHash, harnessEvents, harnessState, harnessTaskId, literalReplacementRanges, pathVersion, resolveWorkspacePath, sha256, stableHarnessHash, turnAccessBinding, withFileAccessSync, type SessionLog, type ToolContext, type ToolDefinition } from "@excelmanus/kernel";
import { HarnessPlan, VerificationInput, numericReadSources, type HarnessArtifactReceipt, type HarnessBinding, type HarnessCheckReceipt, type HarnessDeliveryState, type HarnessEvent, type SourceCheckDeclaration, type ToolResult } from "@excelmanus/protocol";
import { extractSourceCheckDomain, runSourceChecks, type DocumentService, type SheetDomain } from "@excelmanus/workbook";
import { z } from "zod";
import { assertDeliveryBindings } from "./numeric-finalizer.ts";
type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Json:{};
const array=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const deny=(message:string):ToolResult=>({status:"error",error:{code:"INVALID_ARGUMENT",message,retryable:false}});
const id=(prefix:string)=>prefix+"_"+randomUUID();
const workbookPath=(p:string)=>/\.(xlsx|xlsm|xls|csv|tsv)$/i.test(p);
const savedEffects=new Set(["workbook_edit","workbook_analyze","workbook_export","run_script","files","write","edit"]);
function contained(outer:string,inner:string):boolean{try{const a=parseRange(outer),b=parseRange(inner);return (!a.sheet||!b.sheet||a.sheet===b.sheet)&&a.startRow<=b.startRow&&a.endRow>=b.endRow&&a.startCol<=b.startCol&&a.endCol>=b.endCol;}catch{return false}}
function physicalContainment(outer:string,inner:string):boolean{try{const a=parseRange(outer),b=parseRange(inner);return Boolean(a.sheet&&b.sheet&&a.sheet===b.sheet&&contained(outer,inner));}catch{return false}}
function strip(input:unknown):Json{const {verification:_v,...args}=obj(input);return args}
export function createHarnessCoordinator(deps:{db:DatabaseSync;log:SessionLog;documents:DocumentService;tools:Map<string,ToolDefinition>}){
 const {db,log,documents}=deps;
 const legacyAnalyze=deps.tools.get("workbook_analyze");
 function rethrowCancellation(error:unknown,ctx:ToolContext):void{ctx.signal.throwIfAborted();if(error instanceof Error&&(error.name==="AbortError"||error.name==="TimeoutError"))throw error;}
 async function cooperate(ctx:ToolContext):Promise<void>{ctx.signal.throwIfAborted();await yieldToControlPlane();ctx.signal.throwIfAborted();}
 async function bindingsCurrent(bindings:HarnessBinding[],ctx:ToolContext):Promise<boolean>{let current=true;for(const b of bindings){await cooperate(ctx);if(!(await isCurrent(b,ctx)))current=false;ctx.signal.throwIfAborted();}return current;}
 function task(ctx:ToolContext){const turnId=ctx.turnId??"legacy";const binding=ctx.access?.binding()??turnAccessBinding(db,ctx.sessionId,ctx.agentId,turnId);return harnessTaskId({...ctx,turnId,...(binding?{originAgentId:binding.originAgentId,originTurnId:binding.originTurnId}:{})});}
 function auth(ctx:ToolContext){const binding=ctx.access?.binding()??turnAccessBinding(db,ctx.sessionId,ctx.agentId,ctx.turnId??"legacy");return stableHarnessHash(binding?{originAgentId:binding.originAgentId,originTurnId:binding.originTurnId,decision:binding.decision}:{legacy:true,sessionId:ctx.sessionId});}
 function append(ctx:ToolContext,event:HarnessEvent){log.append(ctx.sessionId,ctx.agentId,[{type:"harness.event",data:event}]);}
 function currentPlan(ctx:ToolContext){return harnessState(db,ctx.sessionId,task(ctx)).plan;}
 function normalizedReads(raw:unknown):Json[]{const r=obj(raw),parts=numericReadSources(r);return parts?parts.map(p=>({...p,...(typeof r.sheet==="string"?{sheet:r.sheet}:{} )})):[{...r,unsupportedRead:true}];}
 function readsOf(result:ToolResult,toolName:string):Json[]{
  const data=obj(result.data),reads:Json[]=[];
  const direct=numericReadSources({...data,toolName,docRevs:result.docRevs??data.docRevs});if(direct)reads.push(...direct as unknown as Json[]);
  for(const raw of array(obj(data.provenance).reads))reads.push(...normalizedReads(raw));
  return reads;
 }
 function visibleReads(ctx:ToolContext):Json[]{
  const rows=db.prepare("SELECT c.item,l.data FROM agent_context c JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.superseded=0 AND l.agent_id=? AND l.type='tool.result'").all(ctx.sessionId,ctx.agentId,ctx.agentId) as {item:string;data:string}[];
  const reads:Json[]=[];
  for(const row of rows){try{const visible=obj(JSON.parse(row.item)),record=obj(JSON.parse(row.data));const result=obj(record.result) as ToolResult,output=obj(visible.output) as ToolResult;if(record.status!=="ok"||result.status!=="ok"||output.status!=="ok"||visible.isError===true||visible.toolName!==record.toolName)continue;
   const actual=readsOf(result,String(record.toolName)),shown=readsOf(output,String(record.toolName));
   if(stableHarnessHash(actual)===stableHarnessHash(shown))reads.push(...actual);
  }catch{/* invalid historical receipts are not evidence */}}
  return reads;
 }
 async function binding(path:string,ctx:ToolContext,domain?:{id:string;sheet:string;range:string},rawBytesOnly=false):Promise<HarnessBinding>{
  assertToolAccess(path,ctx.workspaceRoot);const p=resolveWorkspacePath(ctx.workspaceRoot,path);
  if(workbookPath(p.rel))documents.assertSavedReadOpen(ctx.workspaceId,ctx.workspaceRoot,{path:p.rel});
  if(workbookPath(p.rel)&&!rawBytesOnly){
   const {meta}=await documents.open(ctx.workspaceId,ctx.workspaceRoot,p.rel);
   const state=await documents.sourceStatus(meta.id,ctx.workspaceRoot);
   const current=documents.meta(meta.id);
   if(!current||current.externalConflict||current.checkpointError||current.checkpointRev!==current.rev||state.pendingWrite||state.calculation==="computed-in-memory-not-persisted")throw new Error("PENDING_OR_UNPERSISTED_SOURCE");
   return{path:p.rel,docId:meta.id,rev:meta.rev,savedRev:meta.rev,sha256:state.currentSha256,authorizationKey:auth(ctx),...(domain?{domainId:domain.id,sheet:domain.sheet,range:domain.range}:{})};
  }
  const bytes=withFileAccessSync({kind:"file-bytes",path:p.abs,purpose:"harness-saved-read"},()=>readFileSync(p.abs));
  return{path:p.rel,sha256:sha256(bytes),authorizationKey:auth(ctx),...(domain?{domainId:domain.id,sheet:domain.sheet,range:domain.range}:{})};
 }
 async function byteProducerBinding(path:string,ctx:ToolContext){const canonical=resolveWorkspacePath(ctx.workspaceRoot,path).rel;const registered=db.prepare("SELECT id FROM documents WHERE workspace_id=? AND path=?").get(ctx.workspaceId,canonical);return binding(canonical,ctx,undefined,!registered);}
 async function isCurrent(b:HarnessBinding,ctx:ToolContext){try{if(b.authorizationKey!==auth(ctx))return false;if(b.expectedAbsent){assertToolAccess(b.path,ctx.workspaceRoot);const p=resolveWorkspacePath(ctx.workspaceRoot,b.path);try{withFileAccessSync({kind:"file-metadata",path:p.abs,purpose:"harness-move-source-absence"},()=>lstatSync(p.abs));return false;}catch(e){return obj(e).code==="ENOENT";}}const now=await binding(b.path,ctx,undefined,!b.docId);return now.sha256===b.sha256&&now.rev===b.rev&&now.savedRev===b.savedRev;}catch(error){rethrowCancellation(error,ctx);return false}}
 function artifactHistory(ctx:ToolContext):HarnessArtifactReceipt[]{const byId=new Map<string,HarnessArtifactReceipt>();for(const e of harnessEvents(db,ctx.sessionId,task(ctx)))if(e.kind==="artifact")byId.set(e.artifact.id,e.artifact);return [...byId.values()];}
 async function scopedContains(docId:string|undefined,outer:{range:string;sheet?:string},inner:{range:string;sheet?:string},ctx:ToolContext):Promise<boolean>{
  if(!docId)return false;
  try{const {snapshot}=await documents.snapshot(docId,ctx.workspaceRoot);
   const resolve=(scope:{range:string;sheet?:string})=>{const range=parseRange(scope.range),selectors=[scope.sheet,range.sheet].filter((v):v is string=>typeof v==="string"&&v.length>0);if(!selectors.length)return;
    const matches=selectors.map(selector=>Object.entries(snapshot.sheets).filter(([id,sheet])=>id===selector||sheet.id===selector||sheet.name===selector));
    if(matches.some(m=>m.length!==1)||matches.some(m=>m[0]![0]!==matches[0]![0]![0]))return;
    return{...range,sheet:matches[0]![0]![0]};};
   const a=resolve(outer),b=resolve(inner);return!!a&&!!b&&a.sheet===b.sheet&&a.startRow<=b.startRow&&a.endRow>=b.endRow&&a.startCol<=b.startCol&&a.endCol>=b.endCol;
  }catch(error){rethrowCancellation(error,ctx);return false}
 }
 async function captureDependencies(reads:Json[],ctx:ToolContext,dependencies:HarnessBinding[],gaps:string[]){
  for(const read of reads)try{const path=resolveWorkspacePath(ctx.workspaceRoot,String(read.path??"")).rel,file=obj(read.sourceFile);let captured:HarnessBinding;
   if(read.toolName==="files.readText"&&typeof read.sha256==="string"){captured={path,sha256:read.sha256,authorizationKey:auth(ctx)};gaps.push("ACTUAL_READ_SCOPE_UNSUPPORTED");try{const now=await binding(path,ctx,undefined,true);if(read.staged||now.sha256!==read.sha256)gaps.push("ACTUAL_READ_DEPENDENCY_STALE");}catch{gaps.push("ACTUAL_READ_DEPENDENCY_UNBOUND");}}
   else{if(read.unsupportedRead||typeof read.docId!=="string"||typeof read.rev!=="number"||typeof file.currentSha256!=="string")throw new Error("unsupported read");captured={path,docId:read.docId,rev:read.rev,savedRev:read.rev,sha256:file.currentSha256,authorizationKey:auth(ctx),...(typeof obj(read.scope).range==="string"?{range:String(obj(read.scope).range)}:{}),...(typeof read.sheet==="string"?{sheet:read.sheet}:{})};}
   if(!dependencies.some(d=>stableHarnessHash(d)===stableHarnessHash(captured)))dependencies.push(captured);
  }catch{gaps.push("ACTUAL_READ_DEPENDENCY_UNBOUND");}
 }
 async function registerOrResolve(input:VerificationInput,ctx:ToolContext):Promise<HarnessPlan>{
  const parsed=VerificationInput.parse(input),taskId=task(ctx);
  if("planId"in parsed){const found=harnessEvents(db,ctx.sessionId,taskId).find(e=>e.kind==="plan"&&e.plan.id===parsed.planId&&e.plan.version===parsed.version);if(found?.kind!=="plan")throw new Error("计划不存在于当前用户任务");return found.plan;}
  const old=parsed.previousPlanId?harnessEvents(db,ctx.sessionId,taskId).filter(e=>e.kind==="plan"&&e.plan.id===parsed.previousPlanId).at(-1):undefined;
  if(parsed.previousPlanId&&old?.kind!=="plan")throw new Error("不能替换其他任务或未知计划");
  const sources=parsed.sources.map(d=>({...d,path:resolveWorkspacePath(ctx.workspaceRoot,d.path).rel}));
  const outputs=parsed.outputs.map(d=>({...d,path:resolveWorkspacePath(ctx.workspaceRoot,d.path).rel}));
  const ids=[...sources,...outputs].map(d=>d.id);if(new Set(ids).size!==ids.length)throw new Error("来源和输出域标识必须唯一");
  const checks=parsed.checks.map(c=>({...c,purpose:outputs.some(o=>o.id===c.target)?"required_output" as const:c.purpose}));
  const seen=visibleReads(ctx),bindings:HarnessBinding[]=[];
  for(const s of sources){await cooperate(ctx);const b=await binding(s.path,ctx,s);
   let admitted=false;for(const r of seen){if(r.path!==b.path||r.docId!==b.docId||r.rev!==b.rev||obj(r.sourceFile).currentSha256!==b.sha256)continue;if(obj(r.scope).kind==="document"||await scopedContains(b.docId,{range:String(obj(r.scope).range??r.range??""),sheet:typeof r.sheet==="string"?r.sheet:undefined},s,ctx)){admitted=true;break}}
   if(!admitted)throw new Error("来源必须先在当前可见、真实且当前的读取回执中出现："+s.path);
   bindings.push(b);
  }
  const plan=HarnessPlan.parse({...parsed,sources,outputs,checks,id:old?.kind==="plan"?old.plan.id:id("hplan"),version:old?.kind==="plan"?old.plan.version+1:1,taskId,hash:stableHarnessHash({sources,outputs,checks,unverifiedObligations:parsed.unverifiedObligations}),bindings,createdAt:new Date().toISOString()});
  append(ctx,{kind:"plan",plan});return plan;
 }
 async function domain(declaration:HarnessPlan["sources"][number],ctx:ToolContext){const b=await binding(declaration.path,ctx,declaration);if(!b.docId)throw new Error("WORKBOOK_DOMAIN_REQUIRED");const {snapshot}=await documents.snapshot(b.docId,ctx.workspaceRoot);const extracted=extractSourceCheckDomain(snapshot,{...declaration,path:b.path});return{...extracted,binding:b};}
 function cellKey(path:string,sheet:string,row:number,col:number){return JSON.stringify([path,sheet,row,col]);}
 function checkedCells(outputs:SheetDomain[],checks:HarnessCheckReceipt[]):Set<string>{
  const cells=new Set<string>();
  for(const receipt of checks){if(receipt.status!=="passed"||receipt.purpose!=="required_output")continue;
   for(const proof of receipt.coveredCells??[]){const domain=outputs.find(d=>d.id===proof.domainId&&d.complete);if(!domain)continue;
    const column=domain.columnNames.indexOf(proof.column);if(column<0)continue;const range=parseRange(domain.range);
    for(const row of proof.worksheetRows)if(Number.isSafeInteger(row)&&row>=range.startRow&&row<=range.endRow)cells.add(cellKey(domain.path,domain.sheet,row,range.startCol+column));
   }
  }
  return cells;
 }
 function footprintsCovered(effect:HarnessArtifactReceipt,_plan:HarnessPlan,outputs:SheetDomain[],checks:HarnessCheckReceipt[]):boolean{
  if(effect.effect==="external"||!effect.footprint.length||effect.footprint.includes("*"))return false;
  const domains=outputs.filter(o=>o.path===effect.path&&o.complete);
  if(!domains.length||checks.some(c=>c.purpose==="required_output"&&c.status!=="passed"))return false;
  const cells=checkedCells(domains,checks);let count=0;
  return effect.footprint.every(fp=>{
   let r:ReturnType<typeof parseRange>;try{r=parseRange(fp)}catch{return false}
   if(!r.sheet)return false;
   for(let row=r.startRow;row<=r.endRow;row++)for(let col=r.startCol;col<=r.endCol;col++){
    if(++count>200000||!cells.has(cellKey(effect.path,r.sheet,row,col)))return false;
   }
   return true;
  });
 }
 async function check(plan:HarnessPlan,ctx:ToolContext,additionalReads:Json[]=[]):Promise<ToolResult>{
  const receipts:HarnessCheckReceipt[]=[];
  try{
  await cooperate(ctx);
  if(plan.taskId!==task(ctx))return deny("验证计划不属于当前用户请求");
  const sources:SheetDomain[]=[],outputs:SheetDomain[]=[],bindings:HarnessBinding[]=[],limitations:string[]=[];
  const priorEffects=harnessEvents(db,ctx.sessionId,plan.taskId).filter((e):e is Extract<HarnessEvent,{kind:"artifact"}>=>e.kind==="artifact");
  for(const source of plan.sources){if(plan.outputs.some(output=>output.path===source.path))limitations.push("IN_PLACE_SOURCE_VERSION_UNAVAILABLE:"+source.id);if(priorEffects.some(e=>e.artifact.path===source.path&&e.artifact.effect!=="format"&&e.artifact.persistence!=="not_written"))limitations.push("SOURCE_NOT_INDEPENDENT_TASK_ARTIFACT:"+source.id);}
  for(const declaration of [...plan.sources,...plan.outputs]){await cooperate(ctx);try{const x=await domain(declaration,ctx);bindings.push(x.binding);limitations.push(...x.limitations.map(code=>declaration.id+":"+code));(plan.outputs.some(o=>o.id===declaration.id)?outputs:sources).push(x.domain);
   const original=plan.bindings.find(b=>b.domainId===declaration.id);if(original&&!(await isCurrent(original,ctx)))limitations.push("SOURCE_CHANGED:"+declaration.id);
  }catch(error){rethrowCancellation(error,ctx);limitations.push("DOMAIN_NOT_SAVED_OR_AUTHORIZED:"+declaration.id);}}
  // Real script/query dependencies are compared before any output can be certified.
  for(const read of additionalReads){await cooperate(ctx);const path=String(read.path??"");if(!path||read.unsupportedRead){limitations.push("UNBOUND_READ_DEPENDENCY");continue}
   try{const b=await binding(path,ctx);if(!bindings.some(x=>x.path===b.path))bindings.push(b);
    let declared=false;if(obj(read.scope).kind!=="document")for(const d of [...plan.sources,...plan.outputs])if(d.path===b.path&&await scopedContains(b.docId,d,{range:String(obj(read.scope).range??read.range??""),sheet:typeof read.sheet==="string"?read.sheet:undefined},ctx)){declared=true;break}
    if(!declared)limitations.push("UNBOUND_READ_SCOPE:"+path);
    if(read.rev!==undefined&&read.rev!==b.rev)limitations.push("READ_REVISION_CHANGED:"+path);
   }catch(error){rethrowCancellation(error,ctx);limitations.push("READ_NOT_CURRENT:"+path);}
  }
  await cooperate(ctx);
  const computed=runSourceChecks({checks:plan.checks,sources,outputs});
  for(let index=0;index<plan.checks.length;index++){
   await cooperate(ctx);
   const declaration=plan.checks[index]!,pure=computed[index]!;
   let status:HarnessCheckReceipt["status"]=pure.status,assurance:HarnessCheckReceipt["assurance"]=pure.assurance,findings=pure.findings,failedCount=pure.failedCount,unverifiedCount=pure.unverifiedCount,coveredCells=pure.coveredCells??[];
   if(declaration.kind==="legacy_rules"||declaration.kind==="source_alignment"){
    const target=[...plan.outputs,...plan.sources].find(d=>d.id===declaration.target);
    if(target&&legacyAnalyze&&!limitations.length){
     try{const config=obj(declaration.config);if(config.saveTo!==undefined||config.docId!==undefined||config.path!==undefined||config.sources!==undefined||config.right!==undefined)throw new Error("HOST_OWNS_CHECK_IDENTITIES");
      const declaredSources=declaration.sourceIds.map(sourceId=>{const s=plan.sources.find(d=>d.id===sourceId);if(!s)throw new Error("UNBOUND_CHECK_SOURCE");return{name:s.id,path:s.path,sheet:s.sheet,range:s.range};});
      const rectangle=parseRange(target.range);let targetRange=target.range;
      if(declaration.kind==="source_alignment"){if(target.headerRows.length!==1||target.headerRows[0]!==rectangle.startRow||rectangle.endRow<=rectangle.startRow)throw new Error("ALIGNMENT_HEADER_BODY_LAYOUT_UNSUPPORTED");targetRange=indexToCol(rectangle.startCol)+(rectangle.startRow+1)+":"+indexToCol(rectangle.endCol)+rectangle.endRow;}
      const args={...(declaration.kind==="legacy_rules"?{checks:config.checks}:{alignment:{...obj(config.alignment),headerRow:target.headerRows[0]}}),sources:declaredSources,path:target.path,sheet:target.sheet,range:targetRange,mode:declaration.kind==="legacy_rules"?"check":"source_alignment"};
      const result=await legacyAnalyze.execute(legacyAnalyze.input.parse(args),ctx),data=obj(result.data),validation=obj(data.verification??data.validation);
      const rules=array(data.rules??data.checks??data.results??validation.checks);
      const known=rules.length>0&&rules.every(r=>typeof obj(r).passed==="boolean");
      status=result.status!=="ok"?"unverified":known?rules.every(r=>obj(r).passed===true)?"passed":"failed":validation.status==="verified"?"passed":validation.status==="failed"?"failed":"unverified";
      assurance=declaration.kind==="legacy_rules"?"declared_expression":"source_derived";failedCount=status==="failed"?Math.max(1,rules.filter(r=>obj(r).passed===false).length):0;unverifiedCount=status==="unverified"?1:0;
      findings=status==="passed"?[]:[{code:status==="failed"?"DECLARED_CHECK_FAILED":"DECLARED_CHECK_UNVERIFIED",message:"现有只读校验适配器没有给出完整通过。"}];
      if(status==="passed"&&declaration.kind==="source_alignment"){const d=outputs.find(d=>d.id===target.id);const selectors=new Set<string>();for(const binding of array(obj(config.alignment).bindings)){const b=obj(binding);for(const field of ["referenceColumn","rowColumn","sameColumnAs","yearReferenceColumn","monthReferenceColumn","valueReferenceColumn"])if(typeof b[field]==="string")selectors.add(b[field] as string);for(const key of array(b.keys))if(typeof obj(key).targetColumn==="string")selectors.add(obj(key).targetColumn as string);}
       coveredCells=d?array(validation.coveredColumns).filter((c):c is string=>typeof c==="string"&&!selectors.has(c)).map(column=>({domainId:d.id,column,worksheetRows:d.rows.filter(r=>!d.headerRows.includes(r.worksheetRow)).map(r=>r.worksheetRow)})):[];
      }
     }catch(error){rethrowCancellation(error,ctx);status="unverified";unverifiedCount=1;}
    }
   }
   if(limitations.length){status="unverified";unverifiedCount+=limitations.length;findings=[...findings,...limitations.map(code=>({code,message:"宿主保存、读取或绑定边界未满足。"}))];}
   receipts.push({id:id("hcheck"),taskId:plan.taskId,planId:plan.id,planVersion:plan.version,obligationId:declaration.obligationId,definitionHash:harnessCheckDefinitionHash(plan,declaration),purpose:plan.outputs.some(o=>o.id===declaration.target)?"required_output":declaration.purpose,status,assurance,bindings,findings,coveredDomains:pure.coveredDomains,coveredCells:status==="passed"?coveredCells:[],uncoveredFields:pure.uncoveredFields,failedCount,unverifiedCount,findingsTruncated:pure.findingsTruncated});
  }
  const bodyCells=checkedCells(outputs,receipts);
  for(const output of outputs){if(!output.complete||output.headerRows.length!==1)continue;
   const rectangle=parseRange(output.range),bodyRows=output.rows.filter(r=>!output.headerRows.includes(r.worksheetRow));
   const columns=output.columnNames.filter((column,index)=>bodyRows.length>0&&bodyRows.every(row=>bodyCells.has(cellKey(output.path,output.sheet,row.worksheetRow,rectangle.startCol+index))));
   if(columns.length)receipts.push({id:id("hcheck"),taskId:plan.taskId,planId:plan.id,planVersion:plan.version,obligationId:"host.header."+output.id,definitionHash:stableHarnessHash({kind:"saved_header_structure",output:plan.outputs.find(d=>d.id===output.id)}),purpose:"required_output",status:"passed",assurance:"structural",bindings,findings:[],coveredDomains:[output.id],coveredCells:columns.map(column=>({domainId:output.id,column,worksheetRows:output.headerRows})),uncoveredFields:output.columnNames.filter(c=>!columns.includes(c)),failedCount:0,unverifiedCount:0,findingsTruncated:false});
  }
  const covered:string[]=[],repaired:string[]=[],history=artifactHistory(ctx);
  for(const effect of history){
   await cooperate(ctx);
   const dependencies=effect.bindings.filter(b=>b.path!==effect.path);
   if(effect.persistence!=="saved"||effect.execution!=="succeeded"||effect.dependencyGaps?.length||!footprintsCovered(effect,plan,outputs,receipts))continue;
   let allDependenciesBound=true;for(const b of dependencies){let bound=false;for(const s of plan.sources)if(s.path===b.path&&(!b.range||await scopedContains(b.docId,s,{range:b.range,sheet:b.sheet},ctx))){bound=true;break}if(!bound){allDependenciesBound=false;break}}if(!allDependenciesBound)continue;
   if(!(await bindingsCurrent(dependencies,ctx)))continue;
   covered.push(effect.id);
   for(const dependency of dependencies)if(!bindings.some(b=>stableHarnessHash(b)===stableHarnessHash(dependency)))bindings.push(dependency);
  }
  for(let i=0;i<history.length;i++){const old=history[i]!;if(covered.includes(old.id)||!old.footprint.length||old.footprint.includes("*"))continue;
   if(history.slice(i+1).some(replacement=>replacement.path===old.path&&replacement.effect==="data"&&covered.includes(replacement.id)&&old.footprint.every(range=>replacement.replacesDataRanges?.some(full=>physicalContainment(full,range))))){covered.push(old.id);repaired.push(old.id);}
  }
  // The second full dependency sweep closes source changes during asynchronous extraction.
  const allCurrent=await bindingsCurrent(bindings,ctx);
  for(const receipt of receipts){if(!allCurrent){receipt.status="stale";receipt.coveredEffectIds=[];receipt.repairedEffectIds=[];}else if(receipt.status==="passed"&&receipt.purpose==="required_output"){receipt.coveredEffectIds=covered;receipt.repairedEffectIds=repaired;}append(ctx,{kind:"check",check:receipt});}
  await deliveryState(ctx);
  const state=finalCurrentState(ctx);
  return{status:"ok",data:{planId:plan.id,planVersion:plan.version,checks:state.checks,artifacts:state.artifacts,unverifiedObligations:state.unverifiedObligations,scope:"declared domains only; not full natural-language requirement coverage"}};
  }catch(error){
   if(ctx.signal.aborted||(error instanceof Error&&(error.name==="AbortError"||error.name==="TimeoutError"))){
    // Only receipts from this unfinished attempt lose certification. Earlier evidence is retained.
    for(const receipt of receipts)append(ctx,{kind:"check",check:{...receipt,status:"unverified",findings:[],coveredDomains:[],coveredCells:[],coveredEffectIds:[],repairedEffectIds:[],failedCount:0,unverifiedCount:Math.max(1,receipt.unverifiedCount),findingsTruncated:false}});
   }
   throw error;
  }
 }
 function finalCurrentState(ctx:ToolContext):HarnessDeliveryState{
  ctx.signal.throwIfAborted();
  const current=(bindings:HarnessBinding[]):boolean=>{
   if(bindings.some(binding=>binding.authorizationKey!==auth(ctx)))return false;
   try{assertDeliveryBindings(documents,bindings,ctx);ctx.signal.throwIfAborted();return true;}catch(error){rethrowCancellation(error,ctx);return false;}
  };
  const state=harnessState(db,ctx.sessionId,task(ctx));
  for(const check of state.checks){
   if(check.status!=="stale"&&current(check.bindings))continue;
   if(check.status==="stale"&&!check.findings.length&&!check.coveredDomains.length&&!check.coveredCells?.length&&!check.coveredEffectIds?.length&&!check.repairedEffectIds?.length)continue;
   append(ctx,{kind:"check",check:{...check,status:"stale",findings:[],coveredDomains:[],coveredCells:[],coveredEffectIds:[],repairedEffectIds:[],failedCount:0,unverifiedCount:1,findingsTruncated:false}});
  }
  for(const artifact of artifactHistory(ctx)){
   if(artifact.persistence==="not_written"||artifact.dependencyGaps?.includes("ACTUAL_READ_DEPENDENCY_STALE"))continue;
   if(!current(artifact.bindings.filter(binding=>binding.path!==artifact.path)))
    append(ctx,{kind:"artifact",artifact:{...artifact,dependencyGaps:[...(artifact.dependencyGaps??[]),"ACTUAL_READ_DEPENDENCY_STALE"]}});
  }
  // Re-read latest receipts so validation never overwrites a newly retained dependency gap.
  for(const artifact of harnessState(db,ctx.sessionId,task(ctx)).artifacts){
   if(artifact.persistence!=="saved"||artifact.validation==="stale"||!artifact.bindings.length)continue;
   if(!current(artifact.bindings))append(ctx,{kind:"artifact",artifact:{...artifact,validation:"stale"}});
  }
  ctx.signal.throwIfAborted();
  return harnessState(db,ctx.sessionId,task(ctx));
 }
 async function deliveryState(ctx:ToolContext):Promise<HarnessDeliveryState>{
  const state=harnessState(db,ctx.sessionId,task(ctx));
  for(const c of state.checks){if(c.status==="stale")continue;if(!(await bindingsCurrent(c.bindings,ctx)))append(ctx,{kind:"check",check:{...c,status:"stale",coveredEffectIds:[]}});}
  // Preserve actual inputs of EVERY effect even after a later metadata receipt replaces its card.
  for(const a of artifactHistory(ctx)){if(a.persistence==="not_written"||a.dependencyGaps?.includes("ACTUAL_READ_DEPENDENCY_STALE"))continue;const dependencies=a.bindings.filter(b=>b.path!==a.path);if(!(await bindingsCurrent(dependencies,ctx)))append(ctx,{kind:"artifact",artifact:{...a,dependencyGaps:[...(a.dependencyGaps??[]),"ACTUAL_READ_DEPENDENCY_STALE"]}});}
  for(const a of state.artifacts){if(a.persistence!=="saved"||!a.bindings.length)continue;if(!(await bindingsCurrent(a.bindings,ctx)))append(ctx,{kind:"artifact",artifact:{...a,validation:"stale"}});}
  return finalCurrentState(ctx);
 }
 async function recordEffect(input:NonNullable<ToolContext["reportArtifactEffect"]> extends (e:infer E)=>unknown?E:never,ctx:ToolContext,plan?:HarnessPlan,dependencies:HarnessBinding[]=[],dependencyGaps:string[]=[]):Promise<HarnessArtifactReceipt>{
  dependencies=[...dependencies,...(input.assetInputs??[]).map(asset=>({path:resolveWorkspacePath(ctx.workspaceRoot,asset.path).rel,sha256:asset.sha256,authorizationKey:auth(ctx)}))];
  const receipt:HarnessArtifactReceipt={id:id("hartifact"),taskId:task(ctx),toolCallId:ctx.toolCallId,path:input.path,effect:input.effect,execution:input.execution,persistence:input.persistence??"unknown",footprint:input.footprint??["*"],validation:"unverified",bindings:[],...(input.docId?{docId:input.docId}:{}),...(input.revision!==undefined?{revision:input.revision}:{}),...(plan?{planId:plan.id,planVersion:plan.version}:{})};
  receipt.path=input.effect==="external"?input.path:resolveWorkspacePath(ctx.workspaceRoot,input.path).rel;
  if(input.replacesDataRanges?.length)receipt.replacesDataRanges=input.replacesDataRanges;
  receipt.bindings=dependencies;receipt.dependencyGaps=dependencyGaps;
  if(receipt.persistence!=="not_written"&&input.effect!=="external"){
   try{if(input.docId&&receipt.execution==="succeeded")await documents.checkpoint(input.docId,ctx.workspaceRoot);const b=await (receipt.effect==="text"?binding(input.path,ctx,undefined,true):!input.docId&&["copy","move","export"].includes(receipt.effect)?byteProducerBinding(input.path,ctx):binding(input.path,ctx));receipt.bindings=[b,...dependencies.filter(d=>stableHarnessHash(d)!==stableHarnessHash(b))];receipt.docId=b.docId;receipt.revision=b.rev;receipt.sha256=b.sha256;receipt.persistence="saved";if(receipt.effect==="format"&&!dependencyGaps.length&&receipt.execution==="succeeded")receipt.validation="passed";}
   catch{receipt.persistence=input.docId?(receipt.execution==="succeeded"?"save_failed":"pending_save"):"unknown";}
  }
  append(ctx,{kind:"artifact",artifact:receipt});return receipt;
 }
 function wrapTool(tool:ToolDefinition):ToolDefinition{
  const external=tool.name.startsWith("mcp__");
  const registered=savedEffects.has(tool.name)||external;if(!registered)return tool;
  const schema=z.unknown().transform((v,c)=>{const parsed=tool.input.safeParse(strip(v));const verification=obj(v).verification;if(!parsed.success){for(const issue of parsed.error.issues)c.addIssue({code:"custom",message:issue.message,path:issue.path});return z.NEVER;}const checked=verification===undefined?undefined:VerificationInput.safeParse(verification);if(checked&&!checked.success){for(const issue of checked.error.issues)c.addIssue({code:"custom",message:issue.message,path:["verification",...issue.path]});return z.NEVER;}return {...obj(parsed.data),...(checked?.success?{verification:checked.data}:{})};});
  const nativeJson=tool.inputJsonSchema??z.toJSONSchema(tool.input,{io:"input"});
  function extend(s:Json):Json{return{...s,...(s.properties?{properties:{...obj(s.properties),verification:z.toJSONSchema(VerificationInput,{io:"input"})}}:{}),...(Array.isArray(s.anyOf)?{anyOf:s.anyOf.map(v=>extend(obj(v)))}:{}),...(Array.isArray(s.oneOf)?{oneOf:s.oneOf.map(v=>extend(obj(v)))}:{})};}
  return{...tool,input:schema,inputJsonSchema:extend(obj(nativeJson)),
   effect:typeof tool.effect==="function"?(args)=>typeof tool.effect==="function"?tool.effect(strip(args) as never):tool.effect:tool.effect,
   replay:typeof tool.replay==="function"?(args)=>typeof tool.replay==="function"?tool.replay(strip(args) as never):tool.replay:tool.replay,
   targets:(args,scope)=>tool.targets(strip(args),scope),
   ...(tool.activity?{activity:(args:unknown)=>tool.activity!(strip(args))}:{}),
   ...(tool.intentMeta?{intentMeta:(args:unknown,ctx:ToolContext)=>tool.intentMeta!(strip(args),ctx)}:{}),
   recover(info){
    const args=strip(info.args),effect=typeof tool.effect==="function"?tool.effect(args as never):tool.effect;
    let result:ToolResult|undefined,thrown:unknown;
    try{result=tool.recover?.({...info,args});}catch(e){thrown=e;}
    if(effect!=="read"&&result?.status!=="not_executed"){
     // Recovery only observes durable commit metadata. It never opens/checkpoints/replays a document.
     const lastTurn=info.turnId??(db.prepare("SELECT json_extract(data,'$.turnId') AS turnId FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' ORDER BY seq DESC LIMIT 1").get(info.sessionId,info.agentId) as {turnId:string}|undefined)?.turnId??"legacy";
     const origin=info.access?.binding()??turnAccessBinding(db,info.sessionId,info.agentId,lastTurn);
     const taskId=harnessTaskId({...info,turnId:lastTurn,...(origin?{originAgentId:origin.originAgentId,originTurnId:origin.originTurnId}:{})});
     const known=new Map<string,{docId?:string;revision?:number}>();
     const committed=db.prepare("SELECT d.path,o.doc_id,MAX(o.rev) AS rev FROM doc_ops o JOIN documents d ON d.id=o.doc_id WHERE o.session_id=? AND o.tool_call_id=? GROUP BY o.doc_id").all(info.sessionId,info.toolCallId) as {path:string;doc_id:string;rev:number}[];
     for(const row of committed)known.set(row.path,{docId:row.doc_id,revision:row.rev});
     for(const path of array(obj(result?.data).textsChanged))if(typeof path==="string")known.set(path,{});
     const unknown=Boolean(thrown)||result?.status==="uncertain"||!tool.recover;
     if(external&&unknown)known.set("external/"+tool.name,{});
     if(unknown&&!external){for(const path of [args.path,args.to,...array(args.ops).flatMap(o=>[obj(o).to])])if(typeof path==="string")known.set(path,known.get(path)??{});}
     if(unknown&&!known.size)known.set("unresolved/"+tool.name,{});
     const intentSeq=info.intentSeq??(db.prepare("SELECT seq FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 1").get(info.sessionId,info.agentId,info.toolCallId) as {seq:number}|undefined)?.seq??0;
     for(const [path,meta]of known){if(db.prepare("SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND type='harness.event' AND json_extract(data,'$.kind')='artifact' AND json_extract(data,'$.artifact.taskId')=? AND json_extract(data,'$.artifact.toolCallId')=? AND json_extract(data,'$.artifact.path')=? LIMIT 1").get(info.sessionId,info.agentId,intentSeq,taskId,info.toolCallId,path))continue;
      const artifact:HarnessArtifactReceipt={id:"hartifact_recovery_"+stableHarnessHash({sessionId:info.sessionId,toolCallId:info.toolCallId,intentSeq,path}),taskId,toolCallId:info.toolCallId,path,...meta,effect:external||path.startsWith("unresolved/")?"external":workbookPath(path)?"data":"text",execution:"uncertain",persistence:"unknown",footprint:["*"],validation:"unverified",bindings:[],dependencyGaps:["RECOVERY_SAVE_AND_READSET_NOT_CONFIRMED"]};
      log.append(info.sessionId,info.agentId,[{type:"harness.event",data:{kind:"artifact",artifact}}]);
     }
    }
    if(thrown)throw thrown;
    return result;
   },
   async execute(input,ctx){
   const args=strip(input),verification=obj(input).verification;
   let plan:HarnessPlan|undefined;
   try{plan=verification?await registerOrResolve(VerificationInput.parse(verification),ctx):currentPlan(ctx);}catch(e){rethrowCancellation(e,ctx);return deny(e instanceof Error?e.message:"计划无效");}
   const reports:Parameters<NonNullable<ToolContext["reportArtifactEffect"]>>[0][]=[],dependencies:HarnessBinding[]=[],dependencyGaps:string[]=[];
   const sourcePaths:string[]=[];
   if(tool.name==="workbook_edit")for(const operation of array(args.ops)){const op=obj(operation);if(op.op==="image.add"&&typeof op.path==="string")sourcePaths.push(op.path);}
   if(["workbook_analyze","workbook_export"].includes(tool.name)){
    try{sourcePaths.push(documents.editTarget(ctx.workspaceId,ctx.workspaceRoot,args));}catch{dependencyGaps.push("SOURCE_IDENTITY_UNRESOLVED");}
    for(const s of array(args.sources))try{sourcePaths.push(documents.editTarget(ctx.workspaceId,ctx.workspaceRoot,obj(s)));}catch{dependencyGaps.push("SOURCE_IDENTITY_UNRESOLVED");}
   }
   if(tool.name==="files")for(const v of array(args.ops)){const op=obj(v);if(op.op==="copy"||op.op==="move")sourcePaths.push(String(op.path));}
   for(const path of [...new Set(sourcePaths)])try{dependencies.push(tool.name==="files"?await byteProducerBinding(path,ctx):await binding(path,ctx));}catch{dependencyGaps.push("SOURCE_NOT_SAVED_OR_AUTHORIZED");}
   const observed=new Map<string,{sha:string|null;rev:number|undefined;docId:string|undefined}>();
   const observe=(path:string)=>{const p=resolveWorkspacePath(ctx.workspaceRoot,path);const row=db.prepare("SELECT id,head_rev FROM documents WHERE workspace_id=? AND path=?").get(ctx.workspaceId,p.rel) as {id:string;head_rev:number}|undefined;return{path:p.rel,sha:pathVersion(p.abs),rev:row?.head_rev,docId:row?.id};};
   if(!external&&tool.name!=="run_script")for(const path of tool.targets(args,ctx))try{const current=observe(path);observed.set(current.path,current);}catch{/* Original tool keeps authority over invalid targets. */}
   await cooperate(ctx);
   const next={...ctx,reportArtifactEffect:async(effect:Parameters<NonNullable<ToolContext["reportArtifactEffect"]>>[0])=>{reports.push(effect)}};
   let result:ToolResult;try{result=await tool.execute(args,next);}catch(e){
    if(external&&(typeof tool.effect==="function"?tool.effect(args as never):tool.effect)!=="read")reports.push({path:"external/"+tool.name,effect:"external",execution:"uncertain",persistence:"unknown",footprint:["*"]});
    for(const [path,old]of observed)try{const now=observe(path);if((old.sha!==now.sha||old.rev!==now.rev)&&!reports.some(r=>r.path===path))reports.push({path,docId:now.docId,effect:"data",execution:"uncertain",persistence:"unknown",footprint:["*"]});}catch{reports.push({path,effect:"data",execution:"uncertain",persistence:"unknown",footprint:["*"]});}
    await captureDependencies(reports.flatMap(report=>(report.readDependencies??[]).flatMap(normalizedReads)),ctx,dependencies,dependencyGaps);
    for(const report of reports)await recordEffect({...report,execution:report.execution==="failed"?"failed":"uncertain",persistence:report.persistence==="not_written"?"not_written":"unknown"},ctx,plan,dependencies,dependencyGaps);
    throw e;
   }
   const data=obj(result.data),changes=obj(result.changes),dry=args.dryRun===true||args.mode==="preview";
   if(!dry&&tool.name==="workbook_edit"&&(result.status==="ok"||result.status==="uncertain")){
    const path=typeof data.path==="string"?data.path:documents.editTarget(ctx.workspaceId,ctx.workspaceRoot,args),docId=typeof data.docId==="string"?data.docId:typeof args.docId==="string"?args.docId:undefined;
    const footprint=array(obj(data.changes).ranges??changes.ranges).map(String);
    reports.push({path,...(docId?{docId}:{}),effect:classifyWorkbookEffect(array(args.ops)),execution:result.status==="ok"?"succeeded":"uncertain",footprint,replacesDataRanges:literalReplacementRanges(array(args.ops),footprint)});
   }
   if(!dry&&tool.name==="workbook_analyze"&&args.saveTo&&result.status==="ok"){
    const saved=obj(data.saved),to=obj(args.saveTo);const path=String(saved.path??to.path??data.path??args.path??"");
    if(path)reports.push({path,docId:typeof saved.docId==="string"?saved.docId:undefined,effect:"data",execution:"succeeded",footprint:typeof saved.range==="string"?[String(to.sheet)+"!"+saved.range]:["*"]});
   }
   if(!dry&&tool.name==="run_script"&&reports.length===0&&array(data.published).length){
    // Compatibility for historical/current SDK publication receipts until every producer reports directly.
    for(const p of array(data.published)){const a=obj(p);reports.push({path:String(a.path),docId:typeof a.docId==="string"?a.docId:undefined,revision:typeof a.rev==="number"?a.rev:undefined,effect:a.kind==="text"?"text":"data",execution:result.status==="ok"?"succeeded":"uncertain",footprint:array(obj(a.changes).ranges).map(String)});}
   }
   if(!dry&&["write","edit"].includes(tool.name)&&result.status==="ok")reports.push({path:String(data.path??args.path),effect:"text",execution:"succeeded",footprint:["*"]});
   if(!dry&&tool.name==="files"&&["ok","uncertain"].includes(result.status))for(const op of array(args.ops)){const a=obj(op);if(a.op==="copy"||a.op==="move")reports.push({path:String(a.to),effect:a.op,execution:result.status==="ok"?"succeeded":"uncertain",footprint:["*"]});}
   if(!dry&&tool.name==="workbook_export"&&["ok","uncertain"].includes(result.status))for(const path of array(changes.paths))reports.push({path:String(path),effect:"export",execution:result.status==="ok"?"succeeded":"uncertain",footprint:["*"]});
   if(external&&(typeof tool.effect==="function"?tool.effect(args as never):tool.effect)!=="read"&&result.status!=="not_executed")reports.push({path:"external/"+tool.name,effect:"external",execution:result.status==="ok"?"succeeded":"uncertain",persistence:"unknown",footprint:["*"]});
   if(!dry&&result.status!=="ok")for(const [path,old]of observed)try{const now=observe(path);if((old.sha!==now.sha||old.rev!==now.rev)&&!reports.some(r=>r.path===path))reports.push({path,docId:now.docId,effect:tool.name==="files"?"move":tool.name==="write"||tool.name==="edit"?"text":"data",execution:"partial",persistence:"unknown",footprint:["*"]});}catch{reports.push({path,effect:"data",execution:"uncertain",persistence:"unknown",footprint:["*"]});}
   await captureDependencies([...readsOf(result,tool.name),...reports.flatMap(report=>(report.readDependencies??[]).flatMap(normalizedReads))],ctx,dependencies,dependencyGaps);
   const artifacts:HarnessArtifactReceipt[]=[];for(const report of reports){
    let transfer:HarnessBinding|undefined;
    if(tool.name==="files"&&report.execution==="succeeded")for(const raw of array(args.ops)){const op=obj(raw);if((op.op==="copy"||op.op==="move")&&resolveWorkspacePath(ctx.workspaceRoot,String(op.to)).rel===resolveWorkspacePath(ctx.workspaceRoot,report.path).rel){const from=resolveWorkspacePath(ctx.workspaceRoot,String(op.path)).rel;transfer=dependencies.find(d=>d.path===from);if(transfer&&op.op==="move")transfer.expectedAbsent=true;}}
    const artifact=await recordEffect({...report,footprint:report.footprint?.length?report.footprint:["*"]},ctx,plan,dependencies,dependencyGaps);artifacts.push(artifact);
    if(transfer&&artifact.persistence==="saved"&&artifact.sha256===transfer.sha256&&!dependencyGaps.length){
     append(ctx,{kind:"check",check:{id:id("hcheck"),taskId:task(ctx),planId:"host.byte_transfer",planVersion:1,obligationId:"host.byte_transfer."+artifact.id,definitionHash:stableHarnessHash({source:transfer,target:artifact.path,sha256:artifact.sha256}),purpose:"required_output",status:"passed",assurance:"structural",bindings:artifact.bindings,findings:[],coveredDomains:[],uncoveredFields:[],coveredEffectIds:[artifact.id],failedCount:0,unverifiedCount:0,findingsTruncated:false}});
    }
   }
   // All actual reports must be recorded before a stop can end post-save verification.
   if(artifacts.length)await cooperate(ctx);
   if(artifacts.length&&plan)await check(plan,ctx,readsOf(result,tool.name));
   if(artifacts.length){await deliveryState(ctx);const state=finalCurrentState(ctx);result={...result,data:{...data,harness:{taskId:state.taskId,artifacts:state.artifacts,checks:state.checks,unverifiedObligations:state.unverifiedObligations,allowedOutcomes:state.allowedOutcomes}}};}
   return result;
  }};
 }
 return{registerOrResolve,check,deliveryState,wrapTool};
}
