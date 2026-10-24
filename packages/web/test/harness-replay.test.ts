import { ServerMessage } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { initialSessionState, reduceSession, visibleTimeline } from "../src/lib/session/reducer.ts";
const rec=(seq:number,type:string,data:Record<string,unknown>)=>ServerMessage.parse({type:"rec",topic:"session:x",seq,record:{seq,sessionId:"x",agentId:"main",type,data,createdAt:"2026-10-22T00:00:00Z"}});
test("additive harness records replay without changing legacy conversation or duplicating timeline",()=>{
 let state=reduceSession(initialSessionState(),rec(1,"turn.started",{turnId:"t"}));
 state=reduceSession(state,rec(2,"turn.completed",{turnId:"t"}));
 const before=visibleTimeline(state,"main");
 const events=[
 {kind:"plan",plan:{id:"p",version:1,taskId:"x:main:t",hash:"h",createdAt:"2026-10-22T00:00:00Z",sources:[],outputs:[],checks:[],unverifiedObligations:[],bindings:[]}},
 {kind:"artifact",artifact:{id:"a",taskId:"x:main:t",toolCallId:"call",path:"out.xlsx",effect:"data",execution:"succeeded",persistence:"saved",footprint:["Sheet1!A1"],validation:"unverified",bindings:[],dependencyGaps:["ACTUAL_READ_SCOPE_UNSUPPORTED"]}},
 {kind:"check",check:{id:"c",taskId:"x:main:t",planId:"p",planVersion:1,obligationId:"o",definitionHash:"d",purpose:"required_output",status:"unverified",assurance:"unsupported",bindings:[],findings:[],coveredDomains:[],coveredCells:[],coveredEffectIds:[],repairedEffectIds:[],uncoveredFields:[],failedCount:0,unverifiedCount:1,findingsTruncated:false}}
 ];
 for(const [index,event]of events.entries()){const message=rec(index+3,"harness.event",event);state=reduceSession(state,message);expect(reduceSession(state,message)).toBe(state);}
 expect(state.cursor).toBe(5);expect(visibleTimeline(state,"main")).toEqual(before);
});
