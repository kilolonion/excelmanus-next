import {
  type ArrayFormula,
  arraysOf,
  effectiveArrays,
  fixedArrayCellFormula,
} from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { bootUniver } from "../src/engine.ts";
import { importXlsx } from "../src/xlsx.ts";

const a: ArrayFormula = {
  id: "fixed",
  mode: "fixed",
  formula: "=A1:B2*2",
  range: { startRow: 0, endRow: 1, startColumn: 3, endColumn: 4 },
};
test("固定数组按整块计算、写回原始公式，禁止单格破坏", async () => {
  const snap = importCsv(new TextEncoder().encode("1,2\n3,4"), "a.csv").snapshot,
    sid = snap.sheetOrder[0]!,
    sheet = snap.sheets[sid]!;
  sheet.rowCount = 100;
  sheet.columnCount = 20;
  sheet.custom = { excelmanusArrays: [a] };
  for (let r = 0; r < 2; r++)
    for (let c = 3; c < 5; c++) sheet.cellData![r]![c] = { f: fixedArrayCellFormula(a, r, c) };
  const b = bootUniver();
  try {
    const wb = b.univerAPI.createWorkbook(snap);
    await b.waitCalc(4000);
    const saved = wb.save();
    expect(saved.sheets[sid]?.cellData?.[1]?.[4]?.v).toBe(8);
    const reopened = importXlsx(minimalXlsx(saved), "a.xlsx");
    expect(arraysOf(reopened.snapshot.sheets[sid])[0]?.formula).toBe(a.formula);
    expect(reopened.snapshot.sheets[sid]?.cellData?.[1]?.[4]?.f).toBe(
      fixedArrayCellFormula(a, 1, 4),
    );
    const changed = structuredClone(reopened.snapshot);
    changed.sheets[sid]!.cellData![1]![4] = { v: 10 };
    expect(() => exportXlsx(reopened, changed)).toThrow("不能修改数组公式的一部分");
  } finally {
    await b.dispose();
  }
});

test("动态数组保存实际溢出范围、缓存与元数据，重开并缩小", async () => {
  const snap = importCsv(new TextEncoder().encode("1,2\n3,4"), "a.csv").snapshot,
    sid = snap.sheetOrder[0]!;
  snap.sheets[sid]!.rowCount = 100;
  snap.sheets[sid]!.columnCount = 20;
  snap.sheets[sid]!.cellData![0]![3] = { f: "=SEQUENCE(3,2)" };
  const b = bootUniver();
  try {
    const wb = b.univerAPI.createWorkbook(snap);
    await b.waitCalc(4000);
    const saved = wb.save();
    const restored = bootUniver();
    try {
      const live = restored.univerAPI.createWorkbook(saved);
      expect(effectiveArrays(live.save(), sid)[0]?.range).toMatchObject({
        endRow: 2,
        endColumn: 4,
      });
    } finally {
      await restored.dispose();
    }
    const first = importXlsx(minimalXlsx(saved), "a.xlsx");
    const def = arraysOf(first.snapshot.sheets[sid])[0];
    expect(def).toMatchObject({ mode: "dynamic", range: { endRow: 2, endColumn: 4 } });
    expect(first.preservation!.parts["xl/metadata.xml"]).toBeDefined();
    const b2 = bootUniver();
    try {
      const w = b2.univerAPI.createWorkbook(first.snapshot);
      await b2.waitCalc(4000);
      await b2.executeCommand("sheet.mutation.set-range-values", {
        unitId: w.getId(),
        subUnitId: sid,
        cellValue: { 0: { 3: { f: "=SEQUENCE(2,1)" } } },
        trigger: "test",
      });
      await b2.waitCalc(4000);
      const reopened = importXlsx(exportXlsx(first, w.save()), "a.xlsx");
      expect(arraysOf(reopened.snapshot.sheets[sid])[0]).toMatchObject({
        mode: "dynamic",
        range: { endRow: 1, endColumn: 3 },
      });
      const xml = new TextDecoder().decode(
        reopened.preservation!.parts["xl/worksheets/sheet1.xml"],
      );
      expect(xml).not.toMatch(/<c r="E3"[^>]*>[^<]*<v>6<\/v>/);
    } finally {
      await b2.dispose();
    }
  } finally {
    await b.dispose();
  }
});

test("数组编辑经活文档整批提交、重开、清除和撤销，动态溢出不覆盖阻挡格", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openDb, BACKUPS_MIGRATION } = await import("@excelmanus/kernel");
  const {
    DocumentService,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    DOC_MOVES_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  } = await import("../src/service.ts");
  const root = mkdtempSync(join(tmpdir(), "arrays-")),
    db = openDb(join(root, "db"), [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      DOC_MOVES_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
      BACKUPS_MIGRATION,
    ]),
    svc = new DocumentService(db);
  try {
    const snap = importCsv(new TextEncoder().encode("1,2\n3,4"), "a.csv").snapshot,
      sid = snap.sheetOrder[0]!;
    writeFileSync(join(root, "a.xlsx"), minimalXlsx(snap));
    const { meta } = await svc.open("ws", root, "a.xlsx");
    const submit = async (arrays: ArrayFormula[], cellValue: unknown) => {
      const v = await svc.snapshot(meta.id, root);
      return svc.submit(meta.id, root, {
        baseRev: v.meta.rev,
        source: { kind: "user", id: "array-edit" },
        mutations: [
          {
            id: "excelmanus.mutation.set-sheet-arrays",
            params: { unitId: v.snapshot.id, subUnitId: sid, arrays },
          },
          {
            id: "sheet.mutation.set-range-values",
            params: { unitId: v.snapshot.id, subUnitId: sid, cellValue, trigger: "array-edit" },
          },
        ],
      });
    };
    const cells: Record<number, Record<number, { f: string }>> = {};
    for (let r = 0; r < 2; r++) {
      cells[r] = {};
      for (let c = 3; c < 5; c++) cells[r]![c] = { f: fixedArrayCellFormula(a, r, c) };
    }
    expect(await submit([a], cells)).toMatchObject({ ok: true });
    await svc.checkpoint(meta.id, root);
    const next = { ...a, formula: "=A1:B2*3" };
    for (let r = 0; r < 2; r++)
      for (let c = 3; c < 5; c++) cells[r]![c] = { f: fixedArrayCellFormula(next, r, c) };
    expect(await submit([next], cells)).toMatchObject({ ok: true });
    expect((await svc.snapshot(meta.id, root)).snapshot.sheets[sid]?.cellData?.[1]?.[4]?.v).toBe(
      12,
    );
    await svc.checkpoint(meta.id, root);
    expect(
      arraysOf(importXlsx(readFileSync(join(root, "a.xlsx")), "a.xlsx").snapshot.sheets[sid])[0]
        ?.formula,
    ).toBe(next.formula);
    const clear = {
      0: { 3: { v: null, f: null }, 4: { v: null, f: null } },
      1: { 3: { v: null, f: null }, 4: { v: null, f: null } },
    };
    const removed = await submit([], clear);
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
    if (!removed.ok) return;
    expect(
      await svc.undoRevision(meta.id, root, removed.rev, { kind: "user", id: "undo" }),
    ).toMatchObject({ ok: true });
    expect((await svc.snapshot(meta.id, root)).snapshot.sheets[sid]?.cellData?.[1]?.[4]?.v).toBe(
      12,
    );
    const dynamic: ArrayFormula = {
      id: "dyn",
      mode: "dynamic",
      formula: "=SEQUENCE(3,2)",
      range: { startRow: 0, endRow: 0, startColumn: 6, endColumn: 6 },
    };
    const result = await submit([next, dynamic], {
      0: { 6: { f: dynamic.formula } },
      1: { 7: { v: 999 } },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const v = (await svc.snapshot(meta.id, root)).snapshot;
    expect(v.sheets[sid]?.cellData?.[0]?.[6]?.v).toBe("#SPILL!");
    expect(v.sheets[sid]?.cellData?.[1]?.[7]?.v).toBe(999);
    expect(await submit([next, dynamic], { 1: { 7: { v: null, f: null } } })).toMatchObject({
      ok: true,
    });
    await svc.checkpoint(meta.id, root);
    const small = { ...dynamic, formula: "=SEQUENCE(2,1)" };
    const resized = await submit([next, small], {
      0: { 6: { f: small.formula }, 7: { v: null, f: null } },
      1: { 6: { v: null, f: null }, 7: { v: null, f: null } },
      2: { 6: { v: null, f: null }, 7: { v: null, f: null } },
    });
    expect(resized, JSON.stringify(resized)).toMatchObject({ ok: true });
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
