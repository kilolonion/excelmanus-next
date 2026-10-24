import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  kernelProjections,
  openDb,
  SessionLog,
  type ToolContext,
} from "@excelmanus/kernel";
import { SandboxPool } from "@excelmanus/sandbox";
import { ChangeOp, workbookModule } from "@excelmanus/workbook";
import { expect, test, vi } from "vitest";
import { HARNESS_CHANGE_OP_INPUTS } from "../../modules/workbook/test/fixtures/harness-change-ops.ts";
import { createHarnessCoordinator } from "../src/harness-coordinator.ts";
import { installHarnessFacades } from "../src/harness-tools.ts";
import { runScriptTool } from "../src/script.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-capabilities-"));
  const db = openDb(join(root, "db.sqlite"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES('w','test',?,?)").run(
    root,
    new Date().toISOString(),
  );
  const module = workbookModule(db);
  for (const migration of module.migrations ?? []) db.exec(migration.sql);
  const documents = module.service;
  const log = new SessionLog(db, { projections: kernelProjections() });
  log.append("s", "main", [{ type: "turn.started", data: { turnId: "t" } }]);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: root,
    sessionId: "s",
    agentId: "main",
    turnId: "t",
    toolCallId: "setup",
    role: "main",
    signal: AbortSignal.timeout(60_000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "w", workspaceRoot: root, sessionId: "s", agentId: "main",
    }),
    requestApproval: async () => ({ decision: "approved" }),
  };
  const tools = new Map(module.tools!.map((tool) => [tool.name, tool]));
  const setup = await tools.get("workbook_edit")!.execute({
    path: "target.xlsx",
    create: true,
    sheetNames: ["Data", "Extra"],
    ops: [{ op: "cells.set", range: "Data!A1:B3", values: [["id", "amount"], [1, 2], [2, 4]] }],
  }, ctx);
  expect(setup.status, JSON.stringify(setup)).toBe("ok");
  writeFileSync(join(root, "fixture.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=",
    "base64",
  ));
  const sandbox = new SandboxPool({ size: 1 });
  tools.set("run_script", runScriptTool({ sandbox, documents, tools, db }));
  const coordinator = createHarnessCoordinator({ db, log, documents, tools });
  for (const [name, tool] of tools) tools.set(name, coordinator.wrapTool(tool));
  installHarnessFacades({ tools, log, documents, coordinator });
  let sequence = 0;
  async function execute(name: string, args: unknown) {
    const tool = tools.get(name)!;
    const toolCallId = `capability-${sequence++}`;
    const parsed = tool.input.parse(args);
    log.append("s", "main", [{ type: "tool.intent", data: {
      stepId: "step", toolCallId, toolName: name, args, targets: [], replay: "unsafe",
    } }]);
    const result = await tool.execute(parsed, { ...ctx, toolCallId });
    log.append("s", "main", [{ type: "tool.result", data: {
      toolCallId, toolName: name, status: result.status, result,
    } }]);
    return result;
  }
  return {
    root, db, documents, tools, execute,
    hash: () => createHash("sha256").update(readFileSync(join(root, "target.xlsx"))).digest("hex"),
    async close() {
      await sandbox.close();
      await documents.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("all 47 native inputs reach the same submit seam through direct and real QuickJS SDK paths", async () => {
  const f = await fixture();
  try {
    const inputs = HARNESS_CHANGE_OP_INPUTS;
    const expected = inputs.map((input) => ChangeOp.parse(input));
    expect(new Set(expected.map((input) => input.op))).toEqual(
      new Set(ChangeOp.options.map((option) => option.shape.op.value)),
    );
    expect(expected).toHaveLength(47);
    const before = f.hash();
    const stop = "capability submit seam reached; native execution intentionally not performed";
    // This proves parsing and routing, not object preparation, native execution or preservation.
    const submit = vi.spyOn(f.documents, "submit").mockResolvedValue({
      ok: false, code: "INVALID_ARGUMENT", message: stop,
    });
    for (const [index, input] of inputs.entries()) {
      const result = await f.execute("workbook_edit", { path: "target.xlsx", ops: [input] });
      expect(result, input.op).toMatchObject({ status: "error", error: { message: stop } });
      expect(submit.mock.calls[index]?.[2].ops, input.op).toEqual([expected[index]]);
      expect(submit.mock.calls[index]?.[2].source.kind, input.op).toBe("agent");
    }
    expect(submit).toHaveBeenCalledTimes(47);
    const sdk = await f.execute("run_script", {
      code: `const ops = ${JSON.stringify(inputs)}; for (const op of ops) { await wb.edit({path: "target.xlsx", ops: [op]}); } return ops.length;`,
    });
    expect(sdk).toMatchObject({ status: "error", error: { message: stop } });
    expect(submit).toHaveBeenCalledTimes(48);
    expect(submit.mock.calls[47]?.[2]).toMatchObject({ source: { kind: "script" }, dryRun: true });
    expect(submit.mock.calls[47]?.[2].ops).toEqual(expected);
    expect(f.hash()).toBe(before);
    expect(f.tools.get("workbook_analyze")?.modelVisible).toBe(false);
    expect(f.tools.get("workbook_query")?.modelVisible).toBe(true);
    submit.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 60_000);

test("representative native data, formula, format and structure edits actually publish on both paths", async () => {
  const f = await fixture();
  try {
    const before = f.hash();
    const direct = await f.execute("workbook_edit", { path: "target.xlsx", ops: [
      { op: "cells.set", range: "Data!C1:C3", values: [["doubled"], ["=B2*2"], ["=B3*2"]] },
      { op: "style.set", range: "Data!A1:C1", bold: true },
      { op: "freeze", sheet: "Data", rows: 1, cols: 0 },
    ] });
    expect(direct.status, JSON.stringify(direct)).toBe("ok");
    const sdk = await f.execute("run_script", { code: `
      await wb.read({path: "target.xlsx", mode: "range", range: "Data!A1:C3"});
      await wb.edit({path: "target.xlsx", ops: [
        {op: "cells.set", range: "Data!B2", values: [[7]]},
        {op: "style.set", range: "Data!B2", numFmt: "0.00"},
        {op: "axis.size", sheet: "Data", axis: "cols", at: 2, count: 1, mode: "pixels", value: 140},
        {op: "sheet.rename", sheet: "Extra", name: "Summary"},
        {op: "note.set", sheet: "Data", ref: "B2", text: "SDK update"},
        {op: "recalculate"}
      ]});
      return "updated";
    ` });
    expect(sdk.status, JSON.stringify(sdk)).toBe("ok");
    const read = await f.execute("workbook_read", { path: "target.xlsx", mode: "range", range: "Data!A1:C3" });
    expect(read).toMatchObject({ status: "ok", data: {
      values: [["id", "amount", "doubled"], [1, 7, 14], [2, 4, 8]],
      sourceFile: { pendingWrite: false },
    } });
    const overview = await f.execute("workbook_read", { path: "target.xlsx", mode: "overview" });
    expect(JSON.stringify(overview.data)).toContain("Summary");
    expect(f.hash()).not.toBe(before);
  } finally {
    await f.close();
  }
}, 60_000);


test("native print publication retains the existing defined-name structural preservation guard", async () => {
  const f = await fixture();
  try {
    const direct = await f.execute("workbook_edit", { path: "target.xlsx", ops: [
      { op: "print.set", sheet: "Data", printArea: "A1:B3" },
    ] });
    expect(direct.status, JSON.stringify(direct)).toBe("ok");
    const printedHash = f.hash();
    const sdk = await f.execute("run_script", { code: `
      await wb.edit({path: "target.xlsx", ops: [
        {op: "sheet.rename", sheet: "Extra", name: "Summary"}
      ]});
    ` });
    expect(sdk).toMatchObject({ status: "error", error: { code: "UNSUPPORTED_FEATURE" } });
    expect(sdk.error?.message).toContain("definedNames");
    expect(f.hash()).toBe(printedHash);
    const overview = await f.execute("workbook_read", { path: "target.xlsx", mode: "overview" });
    expect(JSON.stringify(overview.data)).toContain("Extra");
    expect(JSON.stringify(overview.data)).not.toContain("Summary");
  } finally {
    await f.close();
  }
}, 60_000);

test("native chart and shape operations publish through both direct and real SDK paths", async () => {
  const f = await fixture();
  try {
    const direct = await f.execute("workbook_edit", { path: "target.xlsx", ops: [
      { op: "shape.add", sheet: "Data", type: "rect", id: "shape1" },
      { op: "chart.add", sheet: "Data", id: "chart1", type: "column", title: "Amounts", range: "Data!A1:B3" },
    ] });
    expect(direct.status, JSON.stringify(direct)).toBe("ok");
    const added = await f.execute("workbook_read", { path: "target.xlsx", mode: "objects" });
    expect(added).toMatchObject({ status: "ok", data: {
      objects: expect.arrayContaining([expect.objectContaining({
        sheet: "Data",
        shapes: expect.arrayContaining([expect.objectContaining({ id: "shape1" })]),
        charts: expect.arrayContaining([expect.objectContaining({ id: "chart1", title: "Amounts" })]),
      })]),
    } });
    const addedHash = f.hash();
    const sdk = await f.execute("run_script", { code: `
      await wb.edit({path: "target.xlsx", ops: [
        {op: "shape.delete", sheet: "Data", id: "shape1"},
        {op: "chart.update", sheet: "Data", id: "chart1", title: "Updated amounts"}
      ]});
    ` });
    expect(sdk.status, JSON.stringify(sdk)).toBe("ok");
    const updated = await f.execute("workbook_read", { path: "target.xlsx", mode: "objects" });
    expect(updated).toMatchObject({ status: "ok", data: {
      objects: expect.arrayContaining([expect.objectContaining({
        sheet: "Data", shapes: [],
        charts: expect.arrayContaining([expect.objectContaining({ id: "chart1", title: "Updated amounts" })]),
      })]),
      sourceFile: { pendingWrite: false },
    } });
    expect(f.hash()).not.toBe(addedHash);
  } finally {
    await f.close();
  }
}, 60_000);
