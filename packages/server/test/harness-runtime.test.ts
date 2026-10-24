import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelGateway,StepRequest } from "@excelmanus/kernel";
import { createApiClient,type LogRecord,type StepEvent } from "@excelmanus/protocol";
import { afterEach,expect,test } from "vitest";
import { startServer,type RunningServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";
const opened:{server:RunningServer;dir:string}[]=[];
afterEach(async()=>{for(const {server,dir}of opened.splice(0)){await server.close();rmSync(dir,{recursive:true,force:true})}});
const call=(id:string,toolName:string,args:unknown):StepEvent[]=>[{kind:"tool.call",toolCallId:id,toolName,args,rawArgs:JSON.stringify(args)},{kind:"finish",reason:"tool-calls"}];
const text=(text:string):StepEvent[]=>[{kind:"text.delta",text},{kind:"finish",reason:"stop"}];
async function boot(handler:(r:StepRequest,n:number)=>StepEvent[]|Promise<StepEvent[]>){
 const dir=mkdtempSync(join(tmpdir(),"harness-runtime-"));let n=0;
 const gateway:ModelGateway={async*step(r){for(const e of await handler(r,++n))yield e;}};
 const server=await startServer({dataDir:dir,gateway,log:()=>{}});opened.push({server,dir});
 const api=createApiClient(server.url,server.token);await createTestProfile(api,{name:"fake",provider:"custom-openai-compatible",model:"fake",baseUrl:"https://mock.invalid/v1",apiKey:"test"});
 const {session}=await api.createSession({});
 return{server,api,session,async run(message="在工作区新建文字表 result.xlsx 后交付。"){await api.sendMessage(session.id,"main",{clientMessageId:"m",text:message});const until=Date.now()+10000;for(;;){const rows=(await api.getSessionLog(session.id,{limit:1000})).items;if(rows.some(r=>["turn.completed","turn.failed"].includes(r.type)))return rows;if(Date.now()>until)throw Error("runtime timeout:"+rows.map(r=>r.type).join(","));await new Promise(r=>setTimeout(r,10));}}};
}
const literal={path:"result.xlsx",create:true,ops:[{op:"cells.set",range:"A1:B2",values:[["key","label"],["A","alpha"]]}]};
test("real runtime blocks free prose after nonnumeric data effect and allows truthful partial delivery",async()=>{
 const seen:string[][]=[];const t=await boot((r,n)=>{seen.push(r.tools?.map(t=>t.name)??[]);return n===1?call("w","workbook_edit",literal):n===2?text("全部业务已核验通过999"):call("d","deliver",{action:"finalize",outcome:"partial"});});
 const rows=await t.run();expect(seen[0]).toContain("workbook_query");expect(seen[0]).toContain("workbook_check");expect(seen[0]).toContain("deliver");expect(seen[0]).not.toContain("workbook_analyze");expect(seen[0]).not.toContain("todo");
 const effects=rows.filter(r=>r.type==="harness.event"&&r.data.kind==="artifact");expect(effects.length).toBeGreaterThan(0);
 expect(rows.some(r=>r.type==="model.output"&&r.data.withheldText==="全部业务已核验通过999")).toBe(true);
 expect(rows.some(r=>r.type==="model.output"&&r.data.text==="全部业务已核验通过999")).toBe(false);
 expect(rows.filter(r=>r.type==="model.output"&&r.data.sourceToolCallId).at(-1)?.data.deliveryStatus).toBe("incomplete");
});
test("hidden legacy analyze saveTo cannot escape effect receipts or required checks",async()=>{
 const t=await boot((_r,n)=>n===1?call("legacy","workbook_analyze",{path:"raw.csv",mode:"sql",sql:"SELECT * FROM data",saveTo:{path:"result.xlsx",sheet:"Result"}}):n===2?call("launder","present",{finalize:{status:"complete",sources:[]}}):call("partial","deliver",{action:"finalize",outcome:"partial"}));
 writeFileSync(join(t.server.workspaceRoot,"raw.csv"),"key,label\nA,alpha\n");const before=readFileSync(join(t.server.workspaceRoot,"raw.csv"));const rows=await t.run("读取工作区 raw.csv，查询结果另存 result.xlsx 后交付。");
 expect(rows.filter(r=>r.type==="harness.event"&&r.data.kind==="artifact").some(r=>(r.data.artifact as {path:string}).path==="result.xlsx")).toBe(true);
 expect(rows.find(r=>r.type==="tool.result"&&r.data.toolCallId==="launder")?.data.status).toBe("error");
 expect(readFileSync(join(t.server.workspaceRoot,"raw.csv"))).toEqual(before);
});
test("real SDK buffered edit publication enters same saved/unverified lifecycle",async()=>{
 const code='await wb.edit('+JSON.stringify(literal)+'); return "script completed";';
 const t=await boot((_r,n)=>n===1?call("sdk","run_script",{code}):call("d","deliver",{action:"finalize",outcome:"partial"}));const rows=await t.run();
 const result=rows.find(r=>r.type==="tool.result"&&r.data.toolCallId==="sdk");expect(result?.data.status,JSON.stringify(result?.data)).toBe("ok");
 expect(rows.some(r=>r.type==="harness.event"&&r.data.kind==="artifact"&&(r.data.artifact as {persistence:string}).persistence==="saved")).toBe(true);
});
test("basic read-only nonnumeric workbook conversation does not require terminal delivery",async()=>{
 const t=await boot((_r,n)=>n===1?call("r","workbook_read",{path:"raw.csv",mode:"range",range:"A1:A2"}):text("已读到标签列。"));writeFileSync(join(t.server.workspaceRoot,"raw.csv"),"label\nalpha\n");const rows=await t.run("读取工作区 raw.csv 的文本标签。");
 expect(rows.some(r=>r.type==="model.output"&&r.data.text==="已读到标签列。")).toBe(true);expect(rows.some(r=>r.type==="harness.event")).toBe(false);
});

test("two real child commits during finalization permit fresh inspection rather than consuming invalid-argument budget", async () => {
  const numeric = await import("../src/numeric-finalizer.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const { vi } = await import("vitest");
  const dir = mkdtempSync(join(tmpdir(), "harness-concurrent-finalize-"));
  const release = new Map<number, () => void>();
  const gates = new Map([1, 2].map(n => [n, new Promise<void>(resolve => release.set(n, resolve))]));
  const childSteps = new Map<number, number>();
  let phase = 0;
  const gateway: ModelGateway = { async *step(request) {
    let events: StepEvent[];
    const child = request.system?.includes("角色的子代理") ? Number(request.system.match(/race-child-(\d)\.xlsx/)?.[1]) : 0;
    if (child) {
      const step = (childSteps.get(child) ?? 0) + 1; childSteps.set(child, step);
      if (step === 1) {
        await gates.get(child);
        events = call("race-child-write-" + child, "workbook_edit", { path: "race-child-" + child + ".xlsx", create: true, ops: [{ op: "cells.set", range: "A1", values: [["child-" + child]] }] });
      } else events = call("race-child-done-" + child, "deliver", { action: "finalize", outcome: "partial" });
    } else {
      const step = ++phase;
      if (step === 1) events = call("race-initial", "workbook_edit", literal);
      else if (step <= 3) {
        const child = step - 1;
        events = call("race-spawn-" + child, "agent_spawn", { name: "race-" + child, role: "worker", task: "创建 race-child-" + child + ".xlsx 后交付 partial。", files: ["race-child-" + child + ".xlsx"] });
      } else if (step % 2 === 0) events = call("race-inspect-" + step, "deliver", { action: "inspect" });
      else {
        const previous = request.history.findLast(x => x.kind === "toolResult");
        const value = previous?.kind === "toolResult" ? previous.output as { status?: string; data?: { action?: string; artifacts?: Array<{ id: string }> } } : undefined;
        expect(value).toMatchObject({ status: "ok", data: { action: "inspect" } });
        events = call("race-final-" + ((step - 3) / 2), "deliver", { action: "finalize", outcome: "partial", artifactIds: value!.data!.artifacts!.map(a => a.id) });
      }
    }
    for (const event of events) yield event;
  } };
  const server = await startServer({ dataDir: dir, gateway, maxConcurrentSubAgents: 2, log: () => {} });
  opened.push({ server, dir });
  const api = createApiClient(server.url, server.token);
  await createTestProfile(api, { name: "fake", provider: "custom-openai-compatible", model: "fake", baseUrl: "https://mock.invalid/v1", apiKey: "test" });
  const { session } = await api.createSession({ permissionMode: "auto" });
  const db = new DatabaseSync(join(dir, "excelmanus.db"), { readOnly: true });
  const records = () => (db.prepare("SELECT seq,agent_id,type,data FROM session_log WHERE session_id=? ORDER BY seq").all(session.id) as { seq: number; agent_id: string; type: string; data: string }[]).map(r => ({ ...r, data: JSON.parse(r.data) }));
  const released = new Set<number>();
  const actual = numeric.verifiedDeliveryFile;
  const spy = vi.spyOn(numeric, "verifiedDeliveryFile").mockImplementation(async (...args) => {
    const file = await actual(...args);
    const ctx = args[3], n = ctx.toolCallId === "race-final-1" ? 1 : ctx.toolCallId === "race-final-2" ? 2 : 0;
    if (ctx.agentId === "main" && n && !released.has(n)) {
      released.add(n);
      release.get(n)!();
      const until = Date.now() + 5000;
      while (!records().some(r => r.type === "tool.result" && r.data.toolCallId === "race-child-write-" + n) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      const written = records().find(r => r.type === "tool.result" && r.data.toolCallId === "race-child-write-" + n);
      expect(written?.data.status).toBe("ok");
      expect(records().some(r => r.type === "harness.event" && r.data.kind === "artifact" && r.data.artifact.toolCallId === "race-child-write-" + n && r.data.artifact.persistence === "saved")).toBe(true);
    }
    return file;
  });
  try {
    await api.sendMessage(session.id, "main", { clientMessageId: "race", text: "在工作区创建 result.xlsx，并让两个子代理分别创建 race-child-1.xlsx 和 race-child-2.xlsx。未经业务核验，只交付 partial。" });
    const until = Date.now() + 15000;
    while (!records().some(r => r.agent_id === "main" && ["turn.completed", "turn.failed"].includes(r.type)) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const rows = records();
    expect([...released].sort()).toEqual([1, 2]);
    for (const n of [1, 2]) {
      const row = rows.find(r => r.type === "tool.result" && r.data.toolCallId === "race-final-" + n);
      expect(row?.data.status, JSON.stringify(row)).toBe("error");
      expect(row?.data.result.error).toMatchObject({ code: "VERSION_CONFLICT", retryable: true });
      expect(row?.data.result.data.__hostFinalizationConflict).toMatchObject({ version: 1, kind: "state_changed" });
      const inspect = rows.find(r => r.type === "tool.result" && r.data.toolCallId === "race-inspect-" + (2 * n + 2));
      expect(inspect?.data).toMatchObject({ status: "ok", result: { data: { action: "inspect" } } });
      expect(inspect!.seq).toBeLessThan(row!.seq);
      expect(row?.data.result.error.message).toBe("交付核验期间来源、文件、权限或检查状态改变，请重新检查交付目录。");
      expect(row?.data.result.data?.finalText).toBeUndefined();
      expect(rows.some(r => r.type === "model.output" && r.data.sourceToolCallId === "race-final-" + n)).toBe(false);
    }
    const final = rows.find(r => r.type === "tool.result" && r.data.toolCallId === "race-final-3");
    expect(final?.data).toMatchObject({ status: "ok", result: { data: { finalizationStatus: "incomplete" } } });
    const lastInspect = rows.find(r => r.type === "tool.result" && r.data.toolCallId === "race-inspect-8");
    expect(lastInspect?.data).toMatchObject({ status: "ok", result: { data: { action: "inspect" } } });
    expect(lastInspect!.seq).toBeLessThan(final!.seq);
    expect(final!.data.result.data.artifacts.map((a: { path: string }) => a.path).sort()).toEqual(["race-child-1.xlsx", "race-child-2.xlsx", "result.xlsx"]);
    expect(rows.some(r => r.agent_id === "main" && r.type === "turn.failed")).toBe(false);
    for (const path of ["result.xlsx", "race-child-1.xlsx", "race-child-2.xlsx"]) expect(readFileSync(join(server.workspaceRoot, path)).length).toBeGreaterThan(0);
  } finally { for (const resolve of release.values()) resolve(); spy.mockRestore(); db.close(); }
}, 30000);
