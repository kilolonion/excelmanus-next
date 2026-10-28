import { TableColumnDataTypeEnum } from "@univerjs/sheets-table";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { setTables, tablesOf } from "../src/tables.ts";
import { importXlsx } from "../src/xlsx.ts";

test("Excel 表对象创建、调整范围与转换普通区域", () => {
  const initial = importXlsx(
    minimalXlsx(importCsv(new TextEncoder().encode("Item,Amount\na,2\nb,4"), "a.csv").snapshot),
    "a.xlsx",
  );
  const snap = structuredClone(initial.snapshot),
    sid = snap.sheetOrder[0]!;
  const t = {
    id: "sales",
    name: "Sales",
    range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
    options: {
      showHeader: true,
      showFooter: false,
      showAutoFilter: true,
      tableStyleId: "table-default-0",
    },
    filters: {},
    meta: {},
    columns: ["Item", "Amount"].map((displayName, i) => ({
      id: String(i + 1),
      displayName,
      dataType: TableColumnDataTypeEnum.None,
      formula: "",
      meta: {},
      style: {},
    })),
  };
  setTables(snap, { [sid]: { tables: [t] } });
  const reopened = importXlsx(exportXlsx(initial, snap), "a.xlsx");
  expect(tablesOf(reopened.snapshot)[sid]?.tables[0]?.name).toBe("Sales");
  const next = structuredClone(reopened.snapshot),
    ts = tablesOf(next);
  ts[sid]!.tables[0]!.range.endRow = 3;
  setTables(next, ts);
  expect(
    tablesOf(importXlsx(exportXlsx(reopened, next), "a.xlsx").snapshot)[sid]?.tables[0]?.range
      .endRow,
  ).toBe(3);
  setTables(next, {});
  const cleared = importXlsx(exportXlsx(reopened, next), "a.xlsx");
  expect(Object.keys(tablesOf(cleared.snapshot))).toHaveLength(0);
  expect(cleared.snapshot.sheets[sid]?.cellData?.[1]?.[1]?.v).toBe(2);
});

test("表对象参与结构化公式计算，活文档保存并撤销", async () => {
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
  const root = mkdtempSync(join(tmpdir(), "tables-")),
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
    const snap = importCsv(
      new TextEncoder().encode("Item,Amount\na,2\nb,4\nTotal,6"),
      "a.csv",
    ).snapshot;
    const sid = snap.sheetOrder[0]!;
    snap.sheets[sid]!.cellData![0]![3] = { f: "=SUM(Sales[Amount])" };
    writeFileSync(join(root, "a.xlsx"), minimalXlsx(snap));
    const { meta } = await svc.open("ws", root, "a.xlsx");
    const before = await svc.snapshot(meta.id, root);
    const result = await svc.submit(meta.id, root, {
      baseRev: before.meta.rev,
      source: { kind: "user", id: "tables" },
      mutations: [
        {
          id: "sheet.mutation.add-table",
          params: {
            unitId: before.snapshot.id,
            subUnitId: sid,
            tableId: "sales",
            name: "Sales",
            range: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 },
            header: ["Item", "Amount"],
            options: { showHeader: true, showFooter: true, tableStyleId: "table-default-0" },
          },
        },
      ],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    const after = await svc.snapshot(meta.id, root);
    expect(after.snapshot.sheets[sid]!.cellData?.[0]?.[3]?.v).toBe(6);
    const renamed = structuredClone(tablesOf(after.snapshot)[sid]!.tables[0]!);
    (await import("@excelmanus/protocol")).SheetTableState.parse({
      unitId: after.snapshot.id,
      subUnitId: sid,
      tables: [renamed],
    });
    renamed.name = "Orders";
    renamed.columns[1]!.displayName = "Value";
    const edited = await svc.submit(meta.id, root, {
      baseRev: after.meta.rev,
      source: { kind: "user", id: "rename-table" },
      mutations: [
        {
          id: "excelmanus.mutation.set-sheet-tables",
          params: { unitId: after.snapshot.id, subUnitId: sid, tables: [renamed] },
        },
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId: after.snapshot.id,
            subUnitId: sid,
            cellValue: { 0: { 1: { v: "Value" }, 3: { f: "=sum(orders[value])" } } },
            trigger: "excelmanus.table-edit",
          },
        },
      ],
    });
    expect(edited, JSON.stringify(edited)).toMatchObject({ ok: true });
    if (!edited.ok) return;
    const named = await svc.snapshot(meta.id, root);
    expect(named.snapshot.sheets[sid]!.cellData?.[0]?.[3]?.v).toBe(6);
    expect(
      await svc.undoRevision(meta.id, root, edited.rev, { kind: "user", id: "undo-rename" }),
    ).toMatchObject({ ok: true });
    const restored = await svc.snapshot(meta.id, root);
    expect(tablesOf(restored.snapshot)[sid]?.tables[0]?.name).toBe("Sales");
    expect(restored.snapshot.sheets[sid]!.cellData?.[0]?.[3]?.f).toBe("=SUM(Sales[Amount])");
    await svc.checkpoint(meta.id, root);
    expect(
      tablesOf(importXlsx(readFileSync(join(root, "a.xlsx")), "a.xlsx").snapshot)[sid]?.tables[0]
        ?.options.showFooter,
    ).toBe(true);
    const current = await svc.snapshot(meta.id, root);
    const removed = await svc.submit(meta.id, root, {
      baseRev: current.meta.rev,
      source: { kind: "user", id: "convert" },
      mutations: [
        {
          id: "excelmanus.mutation.set-sheet-tables",
          params: { unitId: current.snapshot.id, subUnitId: sid, tables: [] },
        },
      ],
    });
    expect(removed).toMatchObject({ ok: true });
    if (!removed.ok) return;
    expect(tablesOf((await svc.snapshot(meta.id, root)).snapshot)[sid]?.tables ?? []).toHaveLength(
      0,
    );
    expect(
      await svc.undoRevision(meta.id, root, removed.rev, { kind: "user", id: "undo-convert" }),
    ).toMatchObject({ ok: true });
    expect(tablesOf((await svc.snapshot(meta.id, root)).snapshot)[sid]?.tables[0]?.name).toBe(
      "Sales",
    );
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("表改名保留原有表样式标志", () => {
  const initial = importXlsx(
    minimalXlsx(importCsv(new TextEncoder().encode("Item,Amount\na,2\nb,4"), "a.csv").snapshot),
    "a.xlsx",
  );
  const sid = initial.snapshot.sheetOrder[0]!;
  const t = {
    id: "sales",
    name: "Sales",
    range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
    options: {
      showHeader: true,
      showFooter: false,
      showAutoFilter: true,
      tableStyleId: "table-default-0",
    },
    filters: {},
    meta: {},
    columns: ["Item", "Amount"].map((displayName, i) => ({
      id: String(i + 1),
      displayName,
      dataType: TableColumnDataTypeEnum.None,
      formula: "",
      meta: {},
      style: {},
    })),
  };
  setTables(initial.snapshot, { [sid]: { tables: [t] } });
  // The exact table style XML is retained during unrelated table-name edits.
  const reopened = importXlsx(minimalXlsx(initial.snapshot), "a.xlsx");
  const path = Object.keys(reopened.preservation!.parts).find(
    (p) => p.startsWith("xl/tables/") && p.endsWith(".xml"),
  )!;
  reopened.preservation!.parts[path] = new TextEncoder().encode(
    new TextDecoder()
      .decode(reopened.preservation!.parts[path])
      .replace('showFirstColumn="0"', 'showFirstColumn="1"'),
  );
  const after = structuredClone(reopened.snapshot),
    table = tablesOf(after)[sid]!.tables[0]!;
  table.name = "Orders";
  setTables(after, { [sid]: { tables: [table] } });
  const exported = importXlsx(exportXlsx(reopened, after), "a.xlsx");
  expect(new TextDecoder().decode(exported.preservation!.parts[path])).toContain(
    'showFirstColumn="1"',
  );
});

test("导入当前行简写引用可计算且下载仍为结构化引用", async () => {
  const { bootUniver, createBook } = await import("../src/engine.ts");
  const original = importXlsx(
    minimalXlsx(
      importCsv(new TextEncoder().encode("Qty,Price,Amount\n2,10,\n3,7,"), "a.csv").snapshot,
    ),
    "a.xlsx",
  );
  const snap = structuredClone(original.snapshot),
    sid = snap.sheetOrder[0]!;
  setTables(snap, {
    [sid]: {
      tables: [
        {
          id: "sales",
          name: "Sales",
          range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
          options: {
            showHeader: true,
            showFooter: false,
            showAutoFilter: true,
            tableStyleId: "table-default-0",
          },
          filters: {},
          meta: {},
          columns: ["Qty", "Price", "Amount"].map((displayName, i) => ({
            id: String(i + 1),
            displayName,
            dataType: TableColumnDataTypeEnum.None,
            formula: i === 2 ? "=[@Qty]*[@Price]" : "",
            meta: {},
            style: {},
          })),
        },
      ],
    },
  });
  for (const r of [1, 2]) snap.sheets[sid]!.cellData![r]![2] = { f: "=[@Qty]*[@Price]" };
  snap.sheets[sid]!.cellData![0]![4] = { f: "=SUM(Sales[Amount])" };
  const imported = importXlsx(exportXlsx(original, snap), "a.xlsx");
  const boot = bootUniver();
  try {
    const book = createBook(boot, structuredClone(imported.snapshot));
    await boot.waitCalc(3000);
    const saved = book.workbook.save();
    expect(saved.sheets[sid]?.cellData?.[1]?.[2]?.v).toBe(20);
    expect(saved.sheets[sid]?.cellData?.[2]?.[2]?.v).toBe(21);
    expect(saved.sheets[sid]?.cellData?.[0]?.[4]?.v).toBe(41);
    const reopened = importXlsx(exportXlsx(imported, saved), "a.xlsx").snapshot;
    expect(reopened.sheets[sid]?.cellData?.[2]?.[2]).toMatchObject({
      f: "=Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]",
      v: 21,
    });
    expect(tablesOf(reopened)[sid]?.tables[0]?.columns[2]?.formula).toBe("=[@Qty]*[@Price]");
  } finally {
    boot.dispose();
  }
});


test("已有缓存的简写 Table 导入重算经 DocumentService 检查点保真回读", async () => {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openDb, BACKUPS_MIGRATION } = await import("@excelmanus/kernel");
  const { DocumentService, DOCUMENTS_MIGRATION, DOC_OPS_MIGRATION, DOC_MOVES_MIGRATION, CHECKPOINT_MIGRATION, DOC_OPS_REVERTS_MIGRATION } = await import("../src/service.ts");
  const original = importXlsx(minimalXlsx(importCsv(new TextEncoder().encode("Qty,Amount\n2,\n3,"), "a.csv").snapshot), "a.xlsx");
  const snap = structuredClone(original.snapshot), sid = snap.sheetOrder[0]!;
  setTables(snap, { [sid]: { tables: [{ id: "sales", name: "Sales",
    range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
    options: { showHeader: true, showFooter: false, showAutoFilter: true, tableStyleId: "table-default-0" },
    filters: {}, meta: {}, columns: ["Qty", "Amount"].map((displayName,i) => ({ id: String(i+1), displayName, dataType: TableColumnDataTypeEnum.None, formula: i === 1 ? "=[@Qty]*10" : "", meta: {}, style: {} })),
  }] } });
  for (const r of [1,2]) snap.sheets[sid]!.cellData![r]![1] = { f: "=[@Qty]*10", v: (r+1)*10 };
  const root=mkdtempSync(join(tmpdir(),"cached-table-"));
  const db=openDb(":memory:",[DOCUMENTS_MIGRATION,DOC_OPS_MIGRATION,DOC_MOVES_MIGRATION,CHECKPOINT_MIGRATION,DOC_OPS_REVERTS_MIGRATION,BACKUPS_MIGRATION]);
  const svc=new DocumentService(db);
  try {
    writeFileSync(join(root,"a.xlsx"),exportXlsx(original,snap));
    const {meta}=await svc.open("w",root,"a.xlsx");
    await svc.recalculate(meta.id,root);
    await svc.checkpoint(meta.id,root);
    const exported=importXlsx(readFileSync(join(root,"a.xlsx")),"a.xlsx");
    expect(exported.snapshot.sheets[sid]?.cellData?.[1]?.[1]).toMatchObject({f:"=Sales[[#This Row],[Qty]]*10",v:20});
  } finally { try { await svc.close(); } finally { db.close(); rmSync(root,{recursive:true,force:true}); } }
});
