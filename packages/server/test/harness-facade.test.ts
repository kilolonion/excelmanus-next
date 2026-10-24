import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, BackupService, bindToolAccess, createReadTable, KERNEL_MIGRATIONS, kernelProjections, openDb, QuestionCoordinator, runWithToolAccess, SessionLog, type ToolContext } from "@excelmanus/kernel";
import { type HarnessDeliveryState, type ToolResult, numericEvidence, numericRefId } from "@excelmanus/protocol";
import { workbookModule } from "@excelmanus/workbook";
import { expect, test, vi } from "vitest";
import { interactionTools } from "../src/interactions.ts";
import { finalizeNumeric } from "../src/numeric-finalizer.ts";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "harness-facade-"));
  const db = openDb(join(dir, "db.sqlite"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  db.prepare("INSERT INTO workspaces (id,name,path,created_at) VALUES (?,'test',?,?)").run("w", dir, new Date().toISOString());
  const module = workbookModule(db);
  for (const migration of module.migrations ?? []) db.exec(migration.sql);
  const documents = module.service;
  const log = new SessionLog(db, { projections: kernelProjections() });
  const ctx: ToolContext = { workspaceId: "w", workspaceRoot: dir, sessionId: "s", agentId: "main", toolCallId: "setup", turnId: "turn", role: "main", signal: AbortSignal.timeout(60_000), reads: createReadTable(), backups: new BackupService(db).bind({ workspaceId: "w", workspaceRoot: dir, sessionId: "s", agentId: "main" }) };
  log.append("s", "main", [{ type: "turn.started", data: { turnId: "turn" } }]);
  const tools = new Map(module.tools!.map(tool => [tool.name, tool]));
  async function execute(name: string, args: unknown, id: string) {
    const tool = tools.get(name)!;
    log.append("s", "main", [{ type: "tool.intent", data: { stepId: "step", toolCallId: id, toolName: name, args, targets: [], replay: "safe" } }]);
    const result = await tool.execute(args, { ...ctx, toolCallId: id });
    log.append("s", "main", [{ type: "tool.result", data: { toolCallId: id, toolName: name, status: result.status, result } }]);
    return result;
  }
  writeFileSync(join(dir, "source.csv"), "label,value\nalpha,3\nbeta,5\n");
  return { dir, db, documents, log, ctx, tools, execute, async close() { await documents.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("present advertises nonterminal payload only while retaining the historical parser", async () => {
  const f = await fixture();
  try {
    const present = interactionTools(f.log, new QuestionCoordinator(f.db, f.log), f.documents).find(t => t.name === "present")!;
    expect(JSON.stringify(present.inputJsonSchema)).not.toContain('"finalize"');
    expect(present.input.safeParse({ finalize: { status: "incomplete", sources: [] } }).success).toBe(true);
  } finally { await f.close(); }
});

test("query alias emits the same authentic numeric catalog without changing source identity", async () => {
  const f = await fixture();
  try {
    const result = await f.execute("workbook_analyze", { path: "source.csv", mode: "sql", sql: "SELECT SUM(value) AS total FROM data" }, "sql");
    expect(result.status).toBe("ok");
    const query = numericEvidence("sql", "workbook_query", result);
    expect(query).toEqual(numericEvidence("sql", "workbook_analyze", result));
    expect(query?.sources.length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test("summary layout fallback never downgrades verified business evidence", async () => {
  const f = await fixture();
  try {
    await f.execute("workbook_read", { path: "source.csv", mode: "range", range: "A1:B3" }, "read");
    const result = await finalizeNumeric(f.log, f.documents, { status: "complete", presentation: "summary", sources: [{ refId: numericRefId({ toolCallId: "read", pointer: "/data/values/1/1" }) }] }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationUsed: "evidence", presentationSatisfied: false } });
  } finally { await f.close(); }
});

test("delivery source preflight runs before a sourceStatus call could cold-recover pending writes", async () => {
  const f = await fixture();
  try {
    await f.execute("workbook_read", { path: "source.csv", mode: "range", range: "A1:B3" }, "read");
    const calls: string[] = [];
    vi.spyOn(f.documents, "assertSavedReadOpen").mockImplementation(() => { calls.push("guard"); throw new Error("pending source, no recovery allowed"); });
    const original = f.documents.sourceStatus.bind(f.documents);
    vi.spyOn(f.documents, "sourceStatus").mockImplementation(async (...args) => { calls.push("sourceStatus"); return original(...args); });
    const result = await finalizeNumeric(f.log, f.documents, { status: "complete", sources: [{ refId: numericRefId({ toolCallId: "read", pointer: "/data/values" }) }] }, f.ctx);
    expect(result).toMatchObject({ status: "error" });
    expect(calls).toEqual(["guard"]);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

const emptyState = (): HarnessDeliveryState => ({ taskId: "task", required: false, artifacts: [], checks: [], unverifiedObligations: [], allowedOutcomes: ["completed", "findings", "partial", "blocked"] });

test("deliver accepts only typed handles, never free terminal data or laundered explanation text", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => emptyState() });
    expect(tool.input.safeParse({ action: "finalize", outcome: "completed" }).success).toBe(true);
    for (const content of [{ message: "all verified 999" }, { value: 999 }, { label: "profit" }, { unit: "USD" }, { pointer: "/data/value" }, { explanations: [{ kind: "limitation", code: "all passed 999" }] }, { explanations: [{ kind: "method", factSetId: "id", text: "certified" }] }]) {
      expect(tool.input.safeParse({ action: "finalize", outcome: "completed", ...content }).success).toBe(false);
    }
    const unseen = await tool.execute({ action: "finalize", outcome: "completed", factSetIds: ["invented"] }, f.ctx);
    expect(unseen.status).toBe("error");
  } finally { await f.close(); }
});

test("whole-task unresolved output obligations cannot be hidden by omitting handles or selecting findings", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const state: HarnessDeliveryState = { ...emptyState(), required: true, unverifiedObligations: ["model says everything passed 999"], allowedOutcomes: ["partial", "blocked"] };
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    for (const outcome of ["completed", "findings"]) expect((await tool.execute({ action: "finalize", outcome }, f.ctx)).status).toBe("error");
    const partial = await tool.execute({ action: "finalize", outcome: "partial" }, f.ctx);
    expect(partial).toMatchObject({ status: "ok", data: { outcome: "partial", finalizationStatus: "incomplete" } });
    expect((partial.data as { finalText: string }).finalText).not.toContain("model says everything passed 999");
  } finally { await f.close(); }
});

test("visible current fact sets finalize without exposing pointers or accepting stale sources", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => emptyState() });
    f.tools.set("deliver", tool);
    await f.execute("workbook_read", { path: "source.csv", mode: "range", range: "A1:B3" }, "read");
    const inspect = await f.execute("deliver", { action: "inspect" }, "inspect");
    const factSets = (inspect.data as { factSets: { id: string }[] }).factSets;
    expect(factSets.length).toBeGreaterThan(0);
    expect(JSON.stringify(factSets)).not.toContain('"pointer"');
    expect(JSON.stringify(factSets)).not.toContain('"refId"');
    const args = { action: "finalize", outcome: "completed", factSetIds: [factSets[0]!.id] };
    const result = await tool.execute(args, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", outcome: "completed" } });
    expect((result.data as { finalText: string }).finalText).toContain("3");
    writeFileSync(join(f.dir, "source.csv"), "label,value\nalpha,999\nbeta,5\n");
    expect((await tool.execute(args, f.ctx)).status).toBe("error");
  } finally { await f.close(); }
});

test("fact-set IDs are not bearer tokens before inspect persistence or after original read compaction", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => emptyState() });
    f.tools.set("deliver", tool);
    await f.execute("workbook_read", { path: "source.csv", mode: "range", range: "A1:B3" }, "read");
    const hidden = await tool.execute({ action: "inspect" }, f.ctx);
    const id = (hidden.data as { factSets: { id: string }[] }).factSets[0]!.id;
    const args = { action: "finalize", outcome: "completed", factSetIds: [id] };
    expect((await tool.execute(args, f.ctx)).status).toBe("error");
    await f.execute("deliver", { action: "inspect" }, "inspect");
    expect((await tool.execute(args, { ...f.ctx, agentId: "child" })).status).toBe("error");
    f.db.prepare("UPDATE agent_context SET superseded=1 WHERE json_extract(item,'$.toolCallId')='read'").run();
    expect((await tool.execute(args, f.ctx)).status).toBe("error");
  } finally { await f.close(); }
});

test("facts invalidate on secondary SQL source changes and on changes during final state resolution", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    writeFileSync(join(f.dir, "other.csv"), "factor\n2\n");
    await f.execute("workbook_analyze", { path: "source.csv", mode: "sql", sources: [{ name: "extra", path: "other.csv", range: "A1:A2" }], sql: "SELECT SUM(value) * MAX(factor) AS total FROM data CROSS JOIN extra" }, "query");
    let calls = 0;
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => { calls += 1; if (calls === 4) writeFileSync(join(f.dir, "other.csv"), "factor\n999\n"); return emptyState(); } });
    f.tools.set("deliver", tool);
    const inspect = await f.execute("deliver", { action: "inspect" }, "inspect");
    const id = (inspect.data as { factSets: { id: string }[] }).factSets[0]!.id;
    const args = { action: "finalize", outcome: "completed", factSetIds: [id] };
    expect((await tool.execute(args, f.ctx)).status).toBe("error");
    expect((await tool.execute(args, f.ctx)).status).toBe("error");
  } finally { await f.close(); }
});

test("large complete fact sets do not become business-incomplete because of display budgets", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    writeFileSync(join(f.dir, "large.csv"), "value\n" + Array.from({ length: 249 }, (_, i) => String(i)).join("\n") + "\n");
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => emptyState() });
    f.tools.set("deliver", tool);
    await f.execute("workbook_read", { path: "large.csv", mode: "range", range: "A1:A250" }, "large");
    const inspect = await f.execute("deliver", { action: "inspect" }, "inspect");
    const fact = (inspect.data as { factSets: { id: string; field: string }[] }).factSets.find(item => item.field === "values")!;
    const result = await tool.execute({ action: "finalize", outcome: "completed", factSetIds: [fact.id] }, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete" } });
    expect((result.data as { finalText: string }).finalText).toContain("248");
  } finally { await f.close(); }
});

test("hidden legacy present.finalize cannot bypass the task coordinator", async () => {
  const { installHarnessFacades } = await import("../src/harness-tools.ts");
  const f = await fixture();
  try {
    for (const tool of interactionTools(f.log, new QuestionCoordinator(f.db, f.log), f.documents)) f.tools.set(tool.name, tool);
    installHarnessFacades({ tools: f.tools, log: f.log, documents: f.documents, coordinator: {
      registerOrResolve: async () => { throw new Error("not used"); }, check: async () => ({ status: "ok" }),
      deliveryState: async () => ({ ...emptyState(), required: true, allowedOutcomes: ["partial", "blocked"], unverifiedObligations: ["unfixed output"] }),
    } });
    expect(f.tools.get("workbook_analyze")?.modelVisible).toBe(false);
    expect(f.tools.get("todo")?.modelVisible).toBe(false);
    await f.execute("workbook_read", { path: "source.csv", mode: "range", range: "A1:B3" }, "read");
    const result = await f.tools.get("present")!.execute({ finalize: { status: "complete", sources: [{ refId: numericRefId({ toolCallId: "read", pointer: "/data/values" }) }] } }, f.ctx);
    expect(result).toMatchObject({ status: "error" });
    expect(f.log.readAfter("s", 0, 100).filter(row => row.type === "ui.present")).toHaveLength(0);
  } finally { await f.close(); }
});

test("unverified raw findings are not exposed after a late source or access change", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const state: HarnessDeliveryState = { ...emptyState(), required: true, allowedOutcomes: ["partial", "blocked"], checks: [{ id: "host-receipt", taskId: "task", planId: "plan", planVersion: 1, obligationId: "model claims completely certified", definitionHash: "hash", purpose: "required_output", status: "unverified", assurance: "declared_expression", bindings: [], findings: [{ code: "unverified", message: "model claims passed", actual: "PRIVATE-OLD-VALUE", expected: "PRIVATE-EXPECTED" }], coveredDomains: [], uncoveredFields: [], failedCount: 987654, unverifiedCount: 123456, findingsTruncated: false }] };
    let calls = 0;
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => { calls += 1; if (calls === 2) { writeFileSync(join(f.dir, "source.csv"), "changed\n"); vi.spyOn(f.documents, "assertSavedReadOpen").mockImplementation(() => { throw new Error("revoked access"); }); } return state; } });
    const result = await tool.execute({ action: "finalize", outcome: "partial" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalizationStatus: "incomplete", checks: [{ id: "host-receipt", status: "unverified", dataSuppressed: true }] } });
    for (const forbidden of ["PRIVATE-OLD-VALUE", "PRIVATE-EXPECTED", "987654", "123456", "model claims"]) expect(JSON.stringify(result)).not.toContain(forbidden);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

test.each(["bytes", "permission"])("inspect revalidates checks after awaited numeric facts: %s", async change => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const text = "value\n789\n";
    writeFileSync(join(f.dir, "check.csv"), text);
    await f.execute("workbook_read", { path: "source.csv", mode: "range", range: "A1:B3" }, "read");
    const state: HarnessDeliveryState = { ...emptyState(), checks: [{ id: "check", taskId: "task", planId: "plan", planVersion: 1, obligationId: "model claims Total profit is 999999", definitionHash: "hash", purpose: "diagnostic", status: "failed", assurance: "source_derived", bindings: [{ path: "check.csv", sha256: createHash("sha256").update(text).digest("hex"), authorizationKey: "read" }], findings: [{ code: "mismatch", message: "model claims success", location: { domainId: "model claims profit", path: "check.csv", sheet: "Data", worksheetRow: 2 }, actual: "SECRET-CHECK-VALUE" }], coveredDomains: [], uncoveredFields: [], failedCount: 1, unverifiedCount: 0, findingsTruncated: false }] };
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    const original = f.documents.sourceStatus.bind(f.documents);
    vi.spyOn(f.documents, "sourceStatus").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (change === "bytes") writeFileSync(join(f.dir, "check.csv"), "changed\n");
      else {
        const guard = f.documents.assertSavedReadOpen.bind(f.documents);
        vi.spyOn(f.documents, "assertSavedReadOpen").mockImplementation((...input) => { if (input[2].path === "check.csv") throw new Error("revoked access"); return guard(...input); });
      }
      return result;
    });
    const result = await tool.execute({ action: "inspect" }, f.ctx);
    expect(result).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("SECRET-CHECK-VALUE");
  } finally { vi.restoreAllMocks(); await f.close(); }
});

test("whole-task check status is mandatory but raw findings need an inspected selected handle", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const state: HarnessDeliveryState = { ...emptyState(), checks: [{ id: "host-check", taskId: "task", planId: "plan", planVersion: 1, obligationId: "model says fully certified 999", definitionHash: "hash", purpose: "diagnostic", status: "failed", assurance: "source_derived", bindings: [{ path: "source.csv", sha256: createHash("sha256").update("label,value\nalpha,3\nbeta,5\n").digest("hex"), authorizationKey: "read" }], findings: [{ code: "mismatch", message: "model says good", location: { domainId: "model says profit is 999", path: "source.csv", sheet: "Data", worksheetRow: 2 }, actual: "RAW-OBSERVATION", expected: 7 }], coveredDomains: ["model says profit"], uncoveredFields: [], failedCount: 1, unverifiedCount: 0, findingsTruncated: false }] };
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    f.tools.set("deliver", tool);
    const unselected = await tool.execute({ action: "finalize", outcome: "findings" }, f.ctx);
    expect(unselected).toMatchObject({ status: "ok", data: { checks: [{ status: "failed" }] } });
    expect(JSON.stringify(unselected)).not.toContain("RAW-OBSERVATION");
    expect((await tool.execute({ action: "finalize", outcome: "findings", checkIds: ["host-check"] }, f.ctx)).status).toBe("error");
    await f.execute("deliver", { action: "inspect" }, "inspect");
    const selected = await tool.execute({ action: "finalize", outcome: "findings", checkIds: ["host-check"] }, f.ctx);
    expect(selected).toMatchObject({ status: "ok" });
    expect(JSON.stringify(selected)).toContain("RAW-OBSERVATION");
    expect(JSON.stringify(selected)).not.toContain("model says");
  } finally { await f.close(); }
});

test("facades preserve native image bytes and never promote PNGs to numeric fact sets", async () => {
  const { installHarnessFacades } = await import("../src/harness-tools.ts");
  const f = await fixture();
  try {
    const present = interactionTools(f.log, new QuestionCoordinator(f.db, f.log), f.documents).find(tool => tool.name === "present")!;
    const native: ToolResult = { status: "ok", data: { capture: true }, images: [{ mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" }] };
    const capture = { ...present, name: "workbook_capture", execute: async () => native };
    f.tools.set("workbook_capture", capture);
    f.tools.set("present", { ...present, execute: async () => native });
    installHarnessFacades({ tools: f.tools, log: f.log, documents: f.documents, coordinator: {
      registerOrResolve: async () => { throw new Error("unused"); }, check: async () => ({ status: "ok" }), deliveryState: async () => emptyState(),
    } });
    expect(f.tools.get("workbook_capture")).toBe(capture);
    expect(await f.tools.get("workbook_capture")!.execute({}, f.ctx)).toBe(native);
    expect(await f.tools.get("present")!.execute({ kind: "text", text: "preview" }, f.ctx)).toBe(native);
    await f.execute("workbook_capture", {}, "capture");
    expect(f.log.readAfter("s", 0, 100).find(row => row.type === "tool.result")?.data.result).toEqual(native);
    const inspected = await f.tools.get("deliver")!.execute({ action: "inspect" }, f.ctx);
    expect(inspected).toMatchObject({ status: "ok", data: { factSets: [] } });
  } finally { await f.close(); }
});

test("delivery projects artifact bindings and uncovered aliases without certifying model prose", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const binding = { path: "source.csv", sha256: createHash("sha256").update("label,value\nalpha,3\nbeta,5\n").digest("hex"), domainId: "model says certified domain", authorizationKey: "model says allowed" };
    const state: HarnessDeliveryState = { ...emptyState(), required: true, allowedOutcomes: ["partial", "blocked"], artifacts: [{ id: "host-artifact", taskId: "task", toolCallId: "host-call", path: "source.csv", effect: "data", execution: "succeeded", persistence: "saved", sha256: binding.sha256, footprint: ["model says complete coverage"], validation: "unverified", planId: "host-plan", planVersion: 1, bindings: [binding], dependencyGaps: ["model says no dependencies"] }], checks: [{ id: "host-check", taskId: "task", planId: "host-plan", planVersion: 1, obligationId: "model says business proof", definitionHash: "hash", purpose: "required_output", status: "failed", assurance: "source_derived", bindings: [binding], findings: [{ code: "mismatch", message: "model says done", actual: 3, expected: 5 }], coveredDomains: ["model says all rows"], uncoveredFields: ["model says validated profit"], failedCount: 1, unverifiedCount: 1, findingsTruncated: false }] };
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    f.tools.set("deliver", tool);
    const inspect = await f.execute("deliver", { action: "inspect" }, "inspect");
    expect(inspect).toMatchObject({ status: "ok", data: { artifacts: [{ id: "host-artifact", dependencyGapCount: 1 }], checks: [{ uncoveredFieldCount: 1 }] } });
    expect(JSON.stringify(inspect)).not.toContain("model says");
    const result = await tool.execute({ action: "finalize", outcome: "partial", artifactIds: ["host-artifact"], checkIds: ["host-check"] }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { artifacts: [{ id: "host-artifact", dependencyGapCount: 1 }], checks: [{ uncoveredFieldCount: 1 }] } });
    expect(JSON.stringify(result)).not.toContain("model says");
    expect((result.data as { finalText: string }).finalText).toContain("未覆盖字段数=1");
    expect((result.data as { finalText: string }).finalText).toContain("依赖缺口=1");
  } finally { await f.close(); }
});


test("host move absence is verified without reopening the source and still enforces current access", async () => {
  const { assertDeliveryBindings } = await import("../src/numeric-finalizer.ts");
  const f = await fixture();
  try {
    const binding = { path: "source.csv", sha256: createHash("sha256").update("label,value\nalpha,3\nbeta,5\n").digest("hex"), expectedAbsent: true as const };
    expect(() => assertDeliveryBindings(f.documents, [binding], f.ctx)).toThrow();
    rmSync(join(f.dir, "source.csv"));
    const guard = vi.spyOn(f.documents, "assertSavedReadOpen").mockImplementation(() => { throw new Error("must not open or recover a moved source"); });
    expect(() => assertDeliveryBindings(f.documents, [binding], f.ctx)).not.toThrow();
    expect(guard).not.toHaveBeenCalled();
    const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
    const state: HarnessDeliveryState = { ...emptyState(), checks: [{ id: "host-transfer-check", taskId: "task", planId: "host.byte_transfer", planVersion: 1, obligationId: "host.byte_transfer", definitionHash: "hash", purpose: "required_output", status: "passed", assurance: "structural", bindings: [{ ...binding, authorizationKey: "current" }], findings: [], coveredDomains: [], uncoveredFields: [], failedCount: 0, unverifiedCount: 0, findingsTruncated: false }] };
    const inspect = await harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state }).execute({ action: "inspect" }, f.ctx);
    expect(inspect).toMatchObject({ status: "ok", data: { checks: [{ bindings: [{ expectedAbsent: true, historicalInputSha256: binding.sha256 }] }] } });
    expect(JSON.stringify(inspect)).not.toContain('"sha256":');
    expect(guard).not.toHaveBeenCalled();
    f.log.append("s", "main", [{ type: "turn.access.updated", data: { turnId: "turn", accessBinding: { originAgentId: "main", originTurnId: "turn", sourceDispatchIds: [], ruleVersion: 1, decision: { kind: "restricted", root: "allowed" }, accessDeliveryRequired: true } } }]);
    const access = bindToolAccess({ db: f.db, log: f.log, workspaceRoot: f.dir, sessionId: "s", agentId: "main", turnId: "turn", toolCallId: "move-deliver" });
    expect(() => runWithToolAccess(access, () => assertDeliveryBindings(f.documents, [binding], f.ctx))).toThrow();
    expect(guard).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await f.close(); }
});

test("expected values certify source provenance only for actual typed source cells", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const sourceLocation = { domainId: "declared-id", path: "source.csv", sheet: "Data", worksheetRow: 2, column: "B" };
    const state: HarnessDeliveryState = { ...emptyState(), checks: [{ id: "host-check", taskId: "task", planId: "host-plan", planVersion: 1, obligationId: "check", definitionHash: "hash", purpose: "diagnostic", status: "failed", assurance: "source_derived", bindings: [{ path: "source.csv", sha256: createHash("sha256").update("label,value\nalpha,3\nbeta,5\n").digest("hex"), authorizationKey: "current" }], findings: [
      { code: "LINEAGE_MISSING", message: "missing declaration period", expected: { count: 1, period: "Revenue=9999" } },
      { code: "LOOKUP_VALUE_MISMATCH", message: "declared blank policy", actual: 9, expected: "model blank placeholder" },
      { code: "LOOKUP_VALUE_MISMATCH", message: "matched source", sourceLocation, actual: 9, expected: 3 },
      { code: "LINEAGE_ANCHOR_MISMATCH", message: "actual source anchor", sourceLocation, actual: 9, expected: 3 },
    ], coveredDomains: [], uncoveredFields: [], failedCount: 4, unverifiedCount: 0, findingsTruncated: false }] };
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    f.tools.set("deliver", tool);
    const inspect = await f.execute("deliver", { action: "inspect" }, "inspect");
    const expected = ["declared_check_parameter", "declared_check_parameter", "source", "source"];
    const bases = (result: ToolResult) => (result.data as { checks: { findings: { expectedBasis: string }[] }[] }).checks[0]!.findings.map(finding => finding.expectedBasis);
    expect(inspect.status).toBe("ok");
    expect(bases(inspect)).toEqual(expected);
    const result = await tool.execute({ action: "finalize", outcome: "findings", checkIds: ["host-check"] }, f.ctx);
    expect(result.status).toBe("ok");
    expect(bases(result)).toEqual(expected);
  } finally { await f.close(); }
});

test.each(["checks", "plan"])("declared-scope proof boundary cannot be omitted from delivery: %s", async mode => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const state = emptyState();
    if (mode === "plan") state.plan = { id: "host-plan", version: 1, taskId: "task", hash: "hash", createdAt: new Date().toISOString(), sources: [], outputs: [], checks: [], bindings: [], unverifiedObligations: [] };
    else state.checks = [{ id: "host-check", taskId: "task", planId: "host-plan", planVersion: 1, obligationId: "check", definitionHash: "hash", purpose: "diagnostic", status: "unverified", assurance: "unsupported", bindings: [], findings: [], coveredDomains: [], uncoveredFields: [], failedCount: 0, unverifiedCount: 1, findingsTruncated: false }];
    const result = await harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state }).execute({ action: "finalize", outcome: "partial" }, f.ctx);
    expect(result.status).toBe("ok");
    expect((result.data as { finalText: string }).finalText).toContain("检查只覆盖已声明且实际读取的来源和字段，不证明所有自然语言要求均已被声明");
  } finally { await f.close(); }
});

test("format artifacts always disclose structural presentation assurance rather than business correctness", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const sha256 = createHash("sha256").update("label,value\nalpha,3\nbeta,5\n").digest("hex");
    const state: HarnessDeliveryState = { ...emptyState(), required: true, artifacts: [{ id: "host-format", taskId: "task", toolCallId: "format-call", path: "source.csv", effect: "format", execution: "succeeded", persistence: "saved", validation: "passed", sha256, footprint: [], bindings: [{ path: "source.csv", sha256, authorizationKey: "read" }] }] };
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    const inspect = await tool.execute({ action: "inspect" }, f.ctx);
    const result = await tool.execute({ action: "finalize", outcome: "completed" }, f.ctx);
    expect(result.status).toBe("ok");
    expect((result.data as { finalText: string }).finalText).toContain("格式类验证仅证明已持久化的结构与呈现，不证明业务规则、图表含义、批注内容真实性或既有数值正确性");
    for (const output of [inspect, result]) expect(output).toMatchObject({ status: "ok", data: { artifacts: [{ validation: "passed", validationScope: "persisted_structure_and_presentation_only" }] } });
  } finally { await f.close(); }
});

test("byte transfer proof never certifies source business correctness", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const sha256 = createHash("sha256").update("label,value\nalpha,3\nbeta,5\n").digest("hex");
    const state: HarnessDeliveryState = { ...emptyState(), checks: [{ id: "host-transfer", taskId: "task", planId: "host.byte_transfer", planVersion: 1, obligationId: "host.byte_transfer", definitionHash: "hash", purpose: "required_output", status: "passed", assurance: "structural", bindings: [{ path: "source.csv", sha256, authorizationKey: "read" }], findings: [], coveredDomains: [], uncoveredFields: [], failedCount: 0, unverifiedCount: 0, findingsTruncated: false }] };
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    const inspect = await tool.execute({ action: "inspect" }, f.ctx);
    const result = await tool.execute({ action: "finalize", outcome: "completed" }, f.ctx);
    expect(result.status).toBe("ok");
    expect((result.data as { finalText: string }).finalText).toContain("字节传输验证只证明目标保存的字节与移动或复制前的来源相同，不证明来源内容或整个工作簿的业务正确性");
    for (const output of [inspect, result]) expect(output).toMatchObject({ status: "ok", data: { checks: [{ validationScope: "byte_identical_transfer_only" }] } });
  } finally { await f.close(); }
});

test("check facade advertises typed aggregates and raw-origin partition scopes without promising unsupported proof", async () => {
  const { installHarnessFacades } = await import("../src/harness-tools.ts");
  const f = await fixture();
  try {
    installHarnessFacades({ tools: f.tools, log: f.log, documents: f.documents, coordinator: {
      registerOrResolve: async () => { throw new Error("unused"); }, check: async () => ({ status: "ok" }), deliveryState: async () => emptyState(),
    } });
    const check = f.tools.get("workbook_check")!;
    for (const term of ["typed_aggregate", "eventScope", "sourceId", "partial"]) expect(check.description).toContain(term);
    expect(JSON.stringify(check.inputJsonSchema)).toContain("typed_aggregate");
  } finally { await f.close(); }
});

test("delivery and legacy finalize propagate AbortError and TimeoutError without rejection laundering", async () => {
  const { harnessDeliveryTool, finalizeLegacyHarness } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const invocations: Array<{ error: Error; promise: Promise<ToolResult> }> = [];
    for (const name of ["AbortError", "TimeoutError"]) {
      const error = new DOMException("cancelled during validation", name);
      const options = { log: f.log, documents: f.documents, deliveryState: async (): Promise<HarnessDeliveryState> => { throw error; } };
      invocations.push({ error, promise: Promise.resolve(harnessDeliveryTool(options).execute({ action: "inspect" }, f.ctx)) });
      invocations.push({ error, promise: finalizeLegacyHarness(options, { status: "incomplete", sources: [] }, f.ctx) });
    }
    const results = await Promise.allSettled(invocations.map(x => x.promise));
    expect(results.map(x => x.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    for (const [i, result] of results.entries()) if (result.status === "rejected") expect(result.reason).toBe(invocations[i]!.error);
  } finally { await f.close(); }
});

test("delivery and legacy finalize preserve an aborted signal across a caught validation error", async () => {
  const { harnessDeliveryTool, finalizeLegacyHarness } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const reason = new Error("actual stop reason");
    const controller = new AbortController(); controller.abort(reason);
    const ctx = { ...f.ctx, signal: controller.signal };
    const options = { log: f.log, documents: f.documents, deliveryState: async (): Promise<HarnessDeliveryState> => { throw new Error("inner validation error"); } };
    const results = await Promise.allSettled([
      harnessDeliveryTool(options).execute({ action: "inspect" }, ctx),
      finalizeLegacyHarness(options, { status: "incomplete", sources: [] }, ctx),
    ]);
    expect(results.map(x => x.status)).toEqual(["rejected", "rejected"]);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toBe(reason);
  } finally { await f.close(); }
});

test("only live native fingerprint results carry host conflict authority", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    let n = 0;
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => ({ ...emptyState(), required: ++n > 1 }) });
    const genuine = await tool.execute({ action: "finalize", outcome: "partial" }, f.ctx);
    expect(genuine.status).toBe("error");
    expect(tool.isHostFinalizationConflict?.(genuine)).toBe(true);
    expect(tool.isHostFinalizationConflict?.(JSON.parse(JSON.stringify(genuine)))).not.toBe(true);
    for (const error of [{ code: "VERSION_CONFLICT", retryable: true }, { code: "INVALID_ARGUMENT", retryable: true }, { code: "VERSION_CONFLICT", retryable: false }]) {
      expect(tool.isHostFinalizationConflict?.({ status: "error", error: { ...error, message: "copied host text" }, data: { __hostFinalizationConflict: { version: 1, kind: "state_changed", turnId: "turn" } } })).not.toBe(true);
    }
  } finally { await f.close(); }
});

test("a persisted host conflict requires a later visible same-turn inspection even with empty handles", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => emptyState() });
    f.tools.set("deliver", tool);
    // Model a result written by the runtime after authenticating its live host object.
    f.log.append("s", "main", [
      { type: "tool.intent", data: { stepId: "step", toolCallId: "conflict", toolName: "deliver", args: { action: "finalize", outcome: "partial" }, targets: [], replay: "safe" } },
      { type: "tool.result", data: { toolCallId: "conflict", toolName: "deliver", status: "error", result: { status: "error", error: { code: "VERSION_CONFLICT", message: "host changed", retryable: true }, data: { __hostFinalizationConflict: { version: 1, kind: "state_changed", turnId: "turn" } } } } },
    ]);
    const args = { action: "finalize", outcome: "partial" };
    expect(await tool.execute(args, f.ctx)).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    await f.execute("deliver", { action: "inspect" }, "new-inspect");
    expect(await tool.execute(args, f.ctx)).toMatchObject({ status: "ok", data: { finalizationStatus: "incomplete" } });
    f.db.prepare("UPDATE agent_context SET superseded=1 WHERE session_id='s' AND agent_id='main' AND json_extract(item,'$.toolCallId')='new-inspect'").run();
    expect(await tool.execute(args, f.ctx)).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
  } finally { await f.close(); }
});

test("fresh inspection is agent and turn scoped and its lookup avoids forty thousand audit rows", async () => {
  const { harnessDeliveryTool } = await import("../src/harness-delivery.ts");
  const f = await fixture();
  try {
    const state = emptyState();
    const tool = harnessDeliveryTool({ log: f.log, documents: f.documents, deliveryState: async () => state });
    f.tools.set("deliver", tool);
    const conflict = { status: "error" as const, error: { code: "VERSION_CONFLICT", message: "host changed", retryable: true }, data: { __hostFinalizationConflict: { version: 1, kind: "state_changed", turnId: "turn" } } };
    f.log.append("s", "main", [{ type: "tool.result", data: { toolCallId: "conflict", toolName: "deliver", status: "error", result: conflict } }]);
    const start = f.log.headSeq("s"), insert = f.db.prepare("INSERT INTO session_log VALUES (?, ?, ?, ?, ?, ?)");
    // Scale only the immutable audit history, which does not add model-context rows.
    f.db.exec("BEGIN");
    for (let i = 0; i < 40_000; i++) insert.run("s", start + i + 1, "main", "access.fact", JSON.stringify({ operationId: "scale-" + i, turnId: "turn", originAgentId: "main", originTurnId: "turn", toolCallId: "scale", kind: "file-bytes", path: "source.csv", outcome: "succeeded" }), "2026-10-24T00:00:00Z");
    f.db.exec("COMMIT");
    const other = await tool.execute({ action: "inspect" }, { ...f.ctx, agentId: "other", toolCallId: "other-inspect" });
    f.log.append("s", "other", [{ type: "tool.result", data: { toolCallId: "other-inspect", toolName: "deliver", status: other.status, result: other } }]);
    const spy = vi.spyOn(f.db, "prepare");
    expect(await tool.execute({ action: "finalize", outcome: "partial" }, f.ctx)).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    const sqls = spy.mock.calls.map(([sql]) => sql); spy.mockRestore();
    const turnSql = sqls.find(sql => sql.startsWith("SELECT seq,data FROM session_log"));
    const contextSql = sqls.find(sql => sql.startsWith("SELECT c.from_seq,c.superseded,c.item,l.data"));
    expect(turnSql).toBeDefined(); expect(contextSql).toBeDefined();
    if (!turnSql || !contextSql) throw new Error("missing actual fresh-inspect queries");
    const turnPlan = f.db.prepare("EXPLAIN QUERY PLAN " + turnSql).all("s", "main").map(row => String(row.detail));
    const contextPlan = f.db.prepare("EXPLAIN QUERY PLAN " + contextSql).all("s", "main", 1, "main").map(row => String(row.detail));
    expect(turnPlan.some(detail => detail.includes("USING COVERING INDEX session_log_turn_access_records"))).toBe(true);
    expect(contextPlan.some(detail => detail.includes("SEARCH c USING PRIMARY KEY"))).toBe(true);
    expect(contextPlan.some(detail => detail.includes("SEARCH l USING PRIMARY KEY"))).toBe(true);
    expect(contextPlan.some(detail => /SCAN l|TEMP B-TREE/.test(detail))).toBe(false);
    expect(f.db.prepare("SELECT count(*) n FROM session_log WHERE type='access.fact'").get()?.n).toBe(40_000);
    expect(f.db.prepare(contextSql).all("s", "main", 1, "main")).toHaveLength(1);
    state.required = true; state.allowedOutcomes = ["partial", "blocked"]; state.unverifiedObligations = ["unverified fixture checks"];
    state.checks = Array.from({ length: 200 }, (_, i) => ({ id: "check-" + i, taskId: "task", planId: "plan", planVersion: 1, obligationId: "rule-" + i, definitionHash: "hash", purpose: "required_output", status: "unverified", assurance: "declared_expression", bindings: [], findings: [], coveredDomains: [], uncoveredFields: [], failedCount: 0, unverifiedCount: 1, findingsTruncated: false }));
    const inspected = await f.execute("deliver", { action: "inspect" }, "main-inspect");
    expect(JSON.stringify(inspected).length).toBeGreaterThan(16_000);
    // Exercise the actual SessionLog capToolOutput projection, not a handmade shortened object.
    const row = f.db.prepare("SELECT idx,item FROM agent_context WHERE session_id='s' AND agent_id='main' AND json_extract(item,'$.toolCallId')='main-inspect'").get()!;
    const item = JSON.parse(String(row.item));
    expect(item.output.truncated).toBeDefined(); expect(item.output.data.action).toBeUndefined();
    expect(typeof item.output.data.preview).toBe("string");
    expect(await tool.execute({ action: "finalize", outcome: "partial" }, f.ctx)).toMatchObject({ status: "ok", data: { finalizationStatus: "incomplete" } });
    // Observing a new capped inspect is not proof of any hidden handle's full contents.
    expect(await tool.execute({ action: "finalize", outcome: "partial", checkIds: ["check-0"] }, f.ctx)).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: "later-turn" } }]);
    const later = await tool.execute({ action: "inspect" }, { ...f.ctx, turnId: "later-turn", toolCallId: "later-inspect" });
    f.log.append("s", "main", [{ type: "tool.result", data: { toolCallId: "later-inspect", toolName: "deliver", status: later.status, result: later } }]);
    expect(await tool.execute({ action: "finalize", outcome: "partial" }, f.ctx)).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
  } finally { vi.restoreAllMocks(); await f.close(); }
});
