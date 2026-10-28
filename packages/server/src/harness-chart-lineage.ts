import type { DatabaseSync } from "node:sqlite";
import { harnessEvents, harnessTaskId, turnAccessBinding, type ToolContext } from "@excelmanus/kernel";
import { OBJECT_LAYER_MUTATION, WorkbookObjects } from "@excelmanus/protocol";

const object=(value:unknown):Record<string,unknown> => value && typeof value==="object" ? value as Record<string,unknown> : {};
const array=(value:unknown):unknown[] => Array.isArray(value)?value:[];
/** Read trusted mutation inverses, not model descriptions or self-consistent current IDs. */
export function assertOriginalChartLineage(db:DatabaseSync,ctx:ToolContext,input:{
 path:string;docId:string;sheetId:string;chartId:string;
}):void {
 const binding=ctx.access?.binding() ?? turnAccessBinding(db,ctx.sessionId,ctx.agentId,ctx.turnId ?? "legacy");
 const taskId=harnessTaskId({sessionId:ctx.sessionId,agentId:ctx.agentId,turnId:ctx.turnId ?? "legacy",...binding});
 const start=db.prepare("SELECT created_at FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND json_extract(data,'$.turnId')=? ORDER BY seq LIMIT 1")
  .get(ctx.sessionId,binding?.originAgentId ?? ctx.agentId,binding?.originTurnId ?? ctx.turnId ?? "legacy") as {created_at:string}|undefined;
 if(!start) throw Error("无法证明当前任务开始前的原图表对象身份，original chart-only 不支持");
 const rows=db.prepare("SELECT rev,tool_call_id,mutations,inverse FROM doc_ops WHERE doc_id=? AND created_at>=? ORDER BY rev")
  .all(input.docId,start.created_at) as {rev:number;tool_call_id:string|null;mutations:string;inverse:string|null}[];
 const effects=harnessEvents(db,ctx.sessionId,taskId).filter(e=>e.kind==="artifact").map(e=>e.artifact)
  .filter(effect=>effect.path===input.path && effect.persistence!=="not_written");
 for(const effect of effects) {
  if(!["data","format","structure"].includes(effect.effect) ||
     effect.execution!=="succeeded" || effect.persistence!=="saved" ||
     !rows.some(row=>row.tool_call_id===effect.toolCallId))
   throw Error("该文件在本任务存在无法追溯原对象的创建、替换或传输，不能冒称原图表");
 }
 for(const row of rows) {
  const mutations=array(JSON.parse(row.mutations)).map(object);
  const inverseData=row.inverse ? object(JSON.parse(row.inverse)) : {};
  const inverse=array(inverseData.mutations).map(object);
  let present:boolean|undefined;
  let previousDefinition:unknown;
  for(const mutation of mutations) {
   const params=object(mutation.params);
   if(mutation.id!==OBJECT_LAYER_MUTATION) {
    if(JSON.stringify(params).includes('"excelmanusObjects"')) throw Error("工作表对象整体替换无法证明原图表身份");
    continue;
   }
   if(params.subUnitId!==input.sheetId) continue;
   if(present===undefined) {
    const previous=inverse.find(item=>item.id===OBJECT_LAYER_MUTATION && object(item.params).subUnitId===input.sheetId);
    const beforeObjects = previous ? object(previous.params).objects :
      object(object(object(object(inverseData.snapshot).sheets)[input.sheetId]).custom).excelmanusObjects;
    if(!beforeObjects) throw Error("对象修改缺少可信原状态逆操作，不能证明原图表身份");
    previousDefinition=WorkbookObjects.parse(beforeObjects).charts.find(chart=>chart.id===input.chartId);
    present=previousDefinition!==undefined;
   }
   const nextDefinition=WorkbookObjects.parse(params.objects).charts.find(chart=>chart.id===input.chartId);
   const next=nextDefinition!==undefined;
   if(present!==next) throw Error("指定图表在本任务被新增或删除重建，不是保留的原对象");
   if(JSON.stringify(previousDefinition)!==JSON.stringify(nextDefinition))
     throw Error("目标原图表定义在本任务已修改，本轮不支持冒称冻结原图捕获");
   present=next;
   previousDefinition=nextDefinition;
  }
 }
}
