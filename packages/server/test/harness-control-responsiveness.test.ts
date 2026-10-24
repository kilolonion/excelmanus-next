import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { currentToolAccess, harnessState, SessionLog, type ModelGateway, type StepRequest } from "@excelmanus/kernel";
import { createApiClient, type StepEvent } from "@excelmanus/protocol";
import { DocumentService } from "@excelmanus/workbook";
import { expect, test, vi } from "vitest";
import { startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const call = (id: string, toolName: string, args: unknown): StepEvent[] => [
  { kind: "tool.call", toolCallId: id, toolName, args, rawArgs: JSON.stringify(args) },
  { kind: "finish", reason: "tool-calls" },
];
const values = [["file", "row", "id", "customer"], ["work/raw.csv", 2, "A", "Alice"], ["work/raw.csv", 3, "B", "Bob"]];
const raw = { path: "work/raw.csv", sheet: "Sheet1", range: "A1:B3", headerRows: [1] };
const output = { path: "work/result.xlsx", sheet: "Sheet1", range: "A1:D3", headerRows: [1] };
function declaration(version: number, previousPlanId?: string) {
  const count = [2, 3, 4, 6, 4][version - 1]!;
  return {
    ...(previousPlanId ? { previousPlanId } : {}),
    sources: [{ ...raw, id: "raw" }, { ...raw, id: "raw-alias" }],
    outputs: Array.from({ length: count }, (_, i) => ({ ...output, id: "out" + i })),
    checks: Array.from({ length: [3, 4, 6, 5, 5][version - 1]! }, (_, i) => ({
      kind: "row_coverage", obligationId: "rows-" + version + "-" + i, requirement: "Declared raw row and identity coverage", purpose: "required_output",
      sourceIds: [i % 2 ? "raw-alias" : "raw"], target: "out" + (i % count),
      lineage: { sourceReferenceColumn: "file", sourceReference: "path", sourceRowColumn: "row", anchors: [{ sourceColumn: "id", targetColumn: "id" }, { sourceColumn: "customer", targetColumn: "customer" }] },
    })),
    unverifiedObligations: [],
  };
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runControl(mode: "check" | "two-saved-script-effects" | "check-completes" | "deliver") {
    const writeMode = mode === "two-saved-script-effects";
    const cancel = mode !== "check-completes";
    const dir = mkdtempSync(join(tmpdir(), "harness-control-scale-"));
    let db: DatabaseSync | undefined;
    let sessionId = "";
    let calls = 0;
    let seeded = false;
    let targetStarted = false;
    let unexpectedProvider = false;
    let triggerAt = 0;
    let requestAt = 0;
    let responseAt = 0;
    let stopStatus: unknown;
    let resultBeforeStopResponse = false;
    let responseError: unknown;
    let stopPromise: Promise<void> | undefined;
    let priorReceiptIds: string[] = [];
    const targetId = "active-cancel-target";
    const rows = (type: string) => (db!.prepare("SELECT seq,data FROM session_log WHERE session_id=? AND type=? ORDER BY seq").all(sessionId, type) as { seq: number; data: string }[]).map(r => ({ seq: r.seq, data: JSON.parse(r.data) }));
    function previous(request: StepRequest) {
      const result = request.history.findLast(x => x.kind === "toolResult");
      if (!result || result.kind !== "toolResult") throw Error("missing real previous receipt");
      const out = result.output as { status: string; data?: { planId?: string; planVersion?: number; harness?: { checks: { planId: string; planVersion: number }[] } } };
      expect(out.status, JSON.stringify(out)).toBe("ok");
      const latest = out.data?.harness?.checks.at(-1);
      return { planId: out.data?.planId ?? latest?.planId, version: out.data?.planVersion ?? latest?.planVersion };
    }
    // One immutable plan ID is obtained from the visible initial-write receipt.
    // Successful replacements keep that ID; large subsequent receipts may be projected.
    let planId = "";
    const gateway: ModelGateway = { async *step(request) {
      const n = ++calls;
      let events: StepEvent[];
      if (n === 1) events = call("read-raw", "workbook_read", { path: "work/raw.csv", mode: "range", range: "Sheet1!A1:B3" });
      else if (n === 2) { previous(request); events = call("initial-write", "workbook_edit", { path: "work/result.xlsx", create: true, ops: [{ op: "cells.set", range: "Sheet1!A1", values }], verification: declaration(1) }); }
      else if (n <= 6) {
        const p = previous(request); if (p.planId) planId = p.planId; if (!planId) throw Error("missing original host plan handle");
        events = call("version-" + (n - 1), "workbook_check", { verification: declaration(n - 1, planId) });
      } else if (writeMode && n === 7) {
        previous(request); events = call("fresh-target", "workbook_read", { path: "work/result.xlsx", mode: "range", range: "Sheet1!A1:D3" });
      } else if (n === (writeMode ? 8 : 7)) {
        previous(request);
        const plans = rows("harness.event").filter(x => x.data.kind === "plan");
        expect(plans.map(x => x.data.plan.version)).toEqual([1, 2, 3, 4, 5]);
        expect(plans.every(x => x.data.plan.sources.length === 2)).toBe(true);
        expect(rows("turn.started")[0]?.data.accessBinding.decision).toEqual({ kind: "restricted", root: "work" });
        // A synthetic load at least as large as the observed incident, not an A1 replay.
        const state = harnessState(db!, sessionId, plans.at(-1)!.data.plan.taskId);
        expect(state.checks.length).toBeGreaterThanOrEqual(27);
        expect(state.checks.reduce((sum, c) => sum + c.bindings.length, 0)).toBeGreaterThanOrEqual(162);
        priorReceiptIds = rows("harness.event").filter(x => x.data.kind === "check").map(x => x.data.check.id);
        const template = rows("access.fact").find(x => x.data.outcome === "succeeded")!.data;
        const log = new SessionLog(db!);
        // Synthetic, individually identified history. The real access path remains unmodified.
        log.append(sessionId, "main", Array.from({ length: 40_000 }, (_, i) => ({ type: "access.fact", data: { ...template, operationId: "scale-history-" + i, toolCallId: "synthetic-history", purpose: "synthetic scale fixture" } })));
        expect(rows("access.fact").filter(x => x.data.toolCallId === "synthetic-history")).toHaveLength(40_000);
        seeded = true;
        targetStarted = true;
        const verification = { planId, version: 5 };
        events = mode === "deliver" ? call(targetId, "deliver", { action: "inspect" }) : !writeMode ? call(targetId, "workbook_check", { verification }) : call(targetId, "run_script", {
          verification,
          code: `await wb.edit(${JSON.stringify({ path: "work/result.xlsx", ops: [{ op: "cells.set", range: "Sheet1!A1", values }] })}); await wb.edit(${JSON.stringify({ path: "work/second.xlsx", create: true, ops: [{ op: "cells.set", range: "Sheet1!A1", values }] })}); return "both published";`,
        });
      } else {
        unexpectedProvider = true;
        events = [{ kind: "text.delta", text: "unexpected provider after stop target" }, { kind: "finish", reason: "stop" }];
      }
      for (const event of events) yield event;
    } };
    const server = await startServer({ dataDir: dir, gateway, log: () => {} });
    const api = createApiClient(server.url, server.token);
    const original = DocumentService.prototype.sourceStatus;
    const spy = vi.spyOn(DocumentService.prototype, "sourceStatus").mockImplementation(function (this: DocumentService, ...args) {
      const access = currentToolAccess();
      if (targetStarted && !triggerAt && access?.toolCallId === targetId) {
        const events = rows("harness.event");
        const ready = mode === "deliver" || (!writeMode
          ? events.some(x => x.data.kind === "check" && !priorReceiptIds.includes(x.data.check.id))
          : events.some(x => x.data.kind === "artifact" && x.data.artifact.toolCallId === targetId));
        if (ready) {
          expect(rows("tool.intent").some(x => x.data.toolCallId === targetId)).toBe(true);
          expect(rows("tool.result").some(x => x.data.toolCallId === targetId)).toBe(false);
          triggerAt = Date.now();
          // Only schedule genuine HTTP. Do not await, alter, delay or replace sourceStatus.
          stopPromise = new Promise<void>(resolve => setTimeout(() => {
            requestAt = Date.now();
            Promise.all([fetch(server.url + "/api/v1/health", { signal: AbortSignal.timeout(3000) }).then(r => expect(r.status).toBe(200)), cancel ? api.stopAgent(sessionId, "main") : Promise.resolve({ ok: true, stopped: false })])
              .then(([, stopped]) => { stopStatus = stopped; responseAt = Date.now(); resultBeforeStopResponse = rows("tool.result").some(x => x.data.toolCallId === targetId && x.data.status === "ok"); })
              .catch(error => { responseError = error; }).finally(resolve);
          }, 0));
        }
      }
      return original.apply(this, args);
    });
    try {
      await createTestProfile(api, { name: "fake", provider: "custom-openai-compatible", model: "fake", baseUrl: "https://mock.invalid/v1", apiKey: "test" });
      const { session } = await api.createSession({ permissionMode: "auto" }); sessionId = session.id;
      db = new DatabaseSync(join(dir, "excelmanus.db"));
      mkdirSync(join(server.workspaceRoot, "work"));
      writeFileSync(join(server.workspaceRoot, "work/raw.csv"), "id,customer\nA,Alice\nB,Bob\n");
      const sourceBefore = sha(readFileSync(join(server.workspaceRoot, "work/raw.csv")));
      await api.sendMessage(sessionId, "main", { clientMessageId: "scale", text: "仅访问 work 目录，不访问其他目录。读取 work/raw.csv 并生成 work/result.xlsx 和 work/second.xlsx，保留来源行和客户身份，保存后检查。" });
      const until = Date.now() + (cancel ? 20000 : 55000);
      while (!stopPromise && !rows("turn.failed").length && Date.now() < until) await sleep(10);
      const diagnostic = JSON.stringify({ calls, results: rows("tool.result").map(r => ({ seq: r.seq, toolName: r.data.toolName, status: r.data.status, error: r.data.result?.error })), failed: rows("turn.failed"), plans: rows("harness.event").filter(r => r.data.kind === "plan").map(r => r.data.plan.version) });
      expect(seeded, diagnostic).toBe(true); expect(triggerAt, diagnostic).toBeGreaterThan(0);
      await stopPromise;
      expect(responseError).toBeUndefined();
      if (cancel) expect(stopStatus).toMatchObject({ ok: true, stopped: true });
      expect(responseAt - triggerAt).toBeLessThan(1500);
      expect(requestAt).toBeGreaterThanOrEqual(triggerAt);
      expect(resultBeforeStopResponse).toBe(false);
      while (!(cancel ? rows("turn.interrupted").length : rows("tool.result").some(x => x.data.toolCallId === targetId)) && Date.now() < until) await sleep(10);
      const result = rows("tool.result").find(x => x.data.toolCallId === targetId);
      if (!cancel) {
        expect(result?.data).toMatchObject({ status: "ok" });
        const intent = db.prepare("SELECT created_at FROM session_log WHERE session_id=? AND type=\'tool.intent\' AND json_extract(data,\'$.toolCallId\')=?").get(sessionId,targetId) as {created_at:string};
        const ended = db.prepare("SELECT created_at FROM session_log WHERE session_id=? AND seq=?").get(sessionId,result!.seq) as {created_at:string};
        const durationMs=Date.parse(ended.created_at)-Date.parse(intent.created_at);
        expect(durationMs).toBeGreaterThanOrEqual(0);
        expect(durationMs).toBeLessThan(60000);
        const checks = new Map(rows("harness.event").filter(x => x.data.kind === "check" && !priorReceiptIds.includes(x.data.check.id)).map(x => [x.data.check.id, x.data.check]));
        expect(checks.size).toBeGreaterThan(0); expect([...checks.values()].every(c => c.status === "passed")).toBe(true);
        process.stderr.write("HARNESS_SCALE_COMPLETION "+JSON.stringify({startedAt:intent.created_at,endedAt:ended.created_at,durationMs,healthResponseMs:responseAt-triggerAt,historyFacts:40000,planVersions:5,passedNewChecks:checks.size})+"\n");
        expect(sha(readFileSync(join(server.workspaceRoot, "work/raw.csv")))).toBe(sourceBefore);
        return;
      }
      expect(result?.data).toMatchObject({ status: "error", result: { error: { code: "CANCELLED" } } });
      expect(rows("turn.interrupted")).toHaveLength(1);
      expect(rows("turn.completed")).toHaveLength(0);
      expect(unexpectedProvider).toBe(false);
      const events = rows("harness.event");
      const newChecks = new Map(events.filter(x => x.data.kind === "check" && !priorReceiptIds.includes(x.data.check.id)).map(x => [x.data.check.id, x.data.check]));
      for (const check of newChecks.values()) {
        expect(check.status).toBe("unverified");
        expect(check.coveredEffectIds ?? []).toEqual([]); expect(check.coveredCells ?? []).toEqual([]); expect(check.findings).toEqual([]);
      }
      if (mode === "check") expect(newChecks.size).toBeGreaterThan(0);
      if (writeMode) {
        const artifacts = events.filter(x => x.data.kind === "artifact" && x.data.artifact.toolCallId === targetId).map(x => x.data.artifact);
        expect(artifacts.map(x => x.path).sort()).toEqual(["work/result.xlsx", "work/second.xlsx"]);
        for (const artifact of artifacts) {
          expect(artifact).toMatchObject({ persistence: "saved", execution: "succeeded" });
          const saved = db.prepare("SELECT head_rev,checkpoint_rev,checkpoint_hash FROM documents WHERE id=?").get(artifact.docId) as { head_rev: number; checkpoint_rev: number; checkpoint_hash: string };
          expect(saved.head_rev).toBe(saved.checkpoint_rev); expect(saved.checkpoint_hash).toBe(sha(readFileSync(join(server.workspaceRoot, artifact.path))));
          expect((db.prepare("SELECT count(*) n FROM doc_ops WHERE session_id=? AND tool_call_id=? AND doc_id=?").get(sessionId, targetId, artifact.docId) as { n: number }).n).toBe(1);
        }
      }
      expect(sha(readFileSync(join(server.workspaceRoot, "work/raw.csv")))).toBe(sourceBefore);
    } finally {
      spy.mockRestore();
      await server.close(); db?.close(); rmSync(dir, { recursive: true, force: true });
    }
}

test.each(["check", "two-saved-script-effects", "deliver"] as const)(
  "40k facts and five real plans allow HTTP stop during active %s without claiming completion",
  runControl,
  30000,
);
test("40k facts and five real plans finish a real check within its original budget while HTTP responds", () => runControl("check-completes"), 60000);
