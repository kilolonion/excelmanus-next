import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDerivedWorkbookMutation } from "@excelmanus/core";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { CommandType } from "@univerjs/core";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { bootUniver, createBook } from "../src/engine.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

for (const rejection of ["none", "merge", "shared", "reference"] as const) {
  test(`editor ${rejection} refusal leaves sort, Undo/Redo, and normal editing usable`, async () => {
    const snapshot = importCsv(
      new TextEncoder().encode("key,value,double\nb,20,\na,10,\n"),
      "Data.csv",
    ).snapshot;
    const sid = snapshot.sheetOrder[0] ?? "";
    const safe = snapshot.sheets[sid];
    if (!safe?.cellData?.[1] || !safe.cellData[2]) throw new Error("Missing fixture");
    safe.cellData[1][2] = { f: "=B2*2", v: 40, t: 2 };
    safe.cellData[2][2] = { f: "=B3*2", v: 20, t: 2 };
    const bad = structuredClone(safe);
    bad.id = "bad";
    bad.name = "Bad";
    if (rejection === "merge")
      bad.mergeData = [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }];
    if (rejection === "shared") {
      bad.cellData = { ...bad.cellData, 3: { 2: { si: "partial" } } };
      bad.cellData[1] = { ...bad.cellData[1], 2: { f: "=B2*2", si: "partial", v: 40, t: 2 } };
    }
    if (rejection === "reference")
      bad.cellData = {
        ...bad.cellData,
        2: { ...bad.cellData?.[2], 2: { f: "=B1+1", v: 1, t: 2 } },
      };
    snapshot.sheets.bad = bad;
    snapshot.sheetOrder.push("bad");
    const root = mkdtempSync(join(tmpdir(), "sort-editor-forwarding-"));
    const db = openDb(join(root, "db.sqlite"), [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      BACKUPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ]);
    const svc = new DocumentService(db);
    writeFileSync(join(root, "book.xlsx"), minimalXlsx(snapshot));
    const boot = bootUniver();
    try {
      const book = createBook(boot, snapshot);
      const { meta } = await svc.open("ws", root, "book.xlsx");
      const server = await svc.snapshot(meta.id, root);
      const internals = boot.univerAPI as unknown as {
        _univerInstanceService: { focusUnit(id: string): void };
        _commandService: {
          _commandExecutionStack: Array<{ id: string }>;
          syncExecuteCommand(id: string, params: object): boolean;
        };
      };
      internals._univerInstanceService.focusUnit(book.unitId);
      await boot.waitCalc(3000, true);
      await boot.executeCommand("nil"); // Install after workbook initialization, before the GUI sync path.
      const authored: Array<{ id: string; params: unknown }> = [];
      const calculations: Array<{ derived: boolean; trigger?: unknown }> = [];
      let revision = 0;
      const persist = async (expected: { f?: string; v: number }) => {
        expect(authored.length).toBeGreaterThan(0);
        const result = await svc.submit(meta.id, root, {
          baseRev: revision,
          source: { kind: "user", id: "editor" },
          mutations: authored.splice(0).map((m) => ({
            ...m,
            params: { ...(m.params as object), unitId: server.snapshot.id },
          })),
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        const saved = await svc.snapshot(meta.id, root);
        expect(saved.meta.rev).toBe(++revision);
        const cell = saved.snapshot.sheets[sid]?.cellData?.[1]?.[2];
        expect(cell).toMatchObject(expected);
        expect(cell?.f).toBe(expected.f);
      };
      boot.onCommandExecuted((command, options) => {
        if (command.type !== CommandType.MUTATION) return;
        const derived = isDerivedWorkbookMutation(command, options);
        if ((options as { applyFormulaCalculationResult?: boolean })?.applyFormulaCalculationResult)
          calculations.push({
            derived,
            trigger: (command.params as { trigger?: unknown })?.trigger,
          });
        if (!options?.fromCollab && !derived)
          authored.push({ id: command.id, params: structuredClone(command.params) });
      });
      const params = (sheet: string) => ({
        unitId: book.unitId,
        subUnitId: sheet,
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        hasTitle: true,
        orderRules: [{ colIndex: 0, type: "asc" }],
      });
      if (rejection !== "none") {
        const before = book.workbook.save().sheets.bad;
        expect(
          internals._commandService.syncExecuteCommand("sheet.command.sort-range", params("bad")),
        ).toBe(false);
        expect(book.workbook.save().sheets.bad).toEqual(before);
        expect(authored).toEqual([]);
        expect(internals._commandService._commandExecutionStack).toEqual([]);
      }
      expect(
        internals._commandService.syncExecuteCommand("sheet.command.sort-range", params(sid)),
      ).toBe(true);
      expect(await boot.waitCalc(3000, true)).toBe(true);
      expect(book.workbook.save().sheets[sid]?.cellData?.[1]?.[2]).toMatchObject({
        f: "=B2*2",
        v: 20,
      });
      await persist({ f: "=B2*2", v: 20 });
      expect(await boot.executeCommand("univer.command.undo")).toBe(true);
      expect(await boot.waitCalc(3000, true)).toBe(true);
      expect(book.workbook.save().sheets[sid]?.cellData?.[1]?.[2]).toMatchObject({
        f: "=B2*2",
        v: 40,
      });
      await persist({ f: "=B2*2", v: 40 });
      expect(await boot.executeCommand("univer.command.redo")).toBe(true);
      expect(await boot.waitCalc(3000, true)).toBe(true);
      expect(book.workbook.save().sheets[sid]?.cellData?.[1]?.[2]).toMatchObject({
        f: "=B2*2",
        v: 20,
      });
      await persist({ f: "=B2*2", v: 20 });
      expect(
        await boot.executeCommand("sheet.command.set-range-values", {
          unitId: book.unitId,
          subUnitId: sid,
          range: { startRow: 1, endRow: 1, startColumn: 2, endColumn: 2 },
          value: { v: 123 },
        }),
      ).toBe(true);
      expect(await boot.waitCalc(3000, true)).toBe(true);
      expect(book.workbook.save().sheets[sid]?.cellData?.[1]?.[2]).toMatchObject({ v: 123 });
      expect(book.workbook.save().sheets[sid]?.cellData?.[1]?.[2]?.f).toBeUndefined();
      expect(
        authored.some(
          (m) =>
            m.id === "sheet.mutation.set-range-values" &&
            (m.params as { trigger?: string }).trigger === "sheet.command.set-range-values",
        ),
      ).toBe(true);
      await persist({ v: 123 });
      await svc.checkpoint(meta.id, root);
      const downloaded = importXlsx(readFileSync(join(root, "book.xlsx")), "book.xlsx").snapshot;
      expect(downloaded.sheets[sid]?.cellData?.[1]?.[2]).toMatchObject({ v: 123 });
      expect(downloaded.sheets[sid]?.cellData?.[1]?.[2]?.f).toBeUndefined();
      expect(authored).toEqual([]);
      expect(calculations.length).toBeGreaterThan(0);
      expect(calculations.every((event) => event.derived)).toBe(true);
      expect(internals._commandService._commandExecutionStack).toEqual([]);
    } finally {
      await boot.dispose();
      await svc.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("trusted calculation options override a stale trigger, but public params and onlyLocal do not", () => {
  const mutation = {
    id: "sheet.mutation.set-range-values",
    params: {
      trigger: "sheet.command.sort-range",
      cellValue: { 1: { 2: { v: 20, t: 2 } } },
      applyFormulaCalculationResult: true,
      options: { applyFormulaCalculationResult: true },
    },
  };
  expect(isDerivedWorkbookMutation(mutation, { applyFormulaCalculationResult: true })).toBe(true);
  expect(isDerivedWorkbookMutation(mutation)).toBe(false);
  expect(isDerivedWorkbookMutation(mutation, { onlyLocal: true })).toBe(false);
  expect(isDerivedWorkbookMutation(mutation, { applyFormulaCalculationResult: false })).toBe(false);
  const rejected = {
    id: "sheet.mutation.reorder-range",
    params: { excelmanusSortRejected: true, options: { excelmanusSortRejected: true } },
  };
  expect(isDerivedWorkbookMutation(rejected)).toBe(false);
  expect(isDerivedWorkbookMutation(rejected, { excelmanusSortRejected: true })).toBe(true);
  expect(isDerivedWorkbookMutation(mutation, { excelmanusSortRejected: true })).toBe(false);
});

test("a rejected raw reorder does not poison reused runtime options for the next success", async () => {
  const snapshot = importCsv(
    new TextEncoder().encode("key,value\nb,20\na,10\n"),
    "Data.csv",
  ).snapshot;
  const sid = snapshot.sheetOrder[0] ?? "";
  const sheet = snapshot.sheets[sid];
  if (!sheet) throw new Error("Missing fixture");
  sheet.mergeData = [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }];
  const boot = bootUniver();
  try {
    const book = createBook(boot, snapshot);
    await boot.executeCommand("nil");
    const options = { fromCollab: false, excelmanusSortRejected: false };
    const authored: unknown[] = [];
    boot.onCommandExecuted((command, runtime) => {
      if (
        command.id === "sheet.mutation.reorder-range" &&
        !isDerivedWorkbookMutation(command, runtime)
      )
        authored.push(command);
    });
    const reorder = (startColumn: number) =>
      boot.executeCommand(
        "sheet.mutation.reorder-range",
        {
          unitId: book.unitId,
          subUnitId: sid,
          order: { 1: 2, 2: 1 },
          range: { startRow: 1, endRow: 2, startColumn, endColumn: 1 },
        },
        options,
      );
    expect(await reorder(0)).toBe(false);
    expect(options.excelmanusSortRejected).toBe(true);
    expect(authored).toEqual([]);
    expect(await reorder(1)).toBe(true);
    expect(options.excelmanusSortRejected).toBe(false);
    expect(authored).toHaveLength(1);
    expect(book.workbook.save().sheets[sid]?.cellData?.[1]?.[1]?.v).toBe(10);
  } finally {
    await boot.dispose();
  }
});
