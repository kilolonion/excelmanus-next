import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import type { ICellData, IRange, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { ChangeOp } from "../src/ops.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

function firstSheet(snapshot: IWorkbookData) {
  const sheet = snapshot.sheets[snapshot.sheetOrder[0] ?? ""];
  if (!sheet) throw new Error("Test workbook is missing its sheet");
  return sheet;
}

function setCell(sheet: Partial<IWorksheetData>, row: number, col: number, cell: ICellData) {
  sheet.cellData ??= {};
  const values = sheet.cellData[row] ?? {};
  values[col] = cell;
  sheet.cellData[row] = values;
}

async function withBook(
  merges: IRange[],
  run: (svc: DocumentService, root: string, id: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "sort-boundary-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    const snapshot = importCsv(
      new TextEncoder().encode("name,count,double,mixed\nb,20,,\na,10,,\nc,30,,\n,7,,\n"),
      "Data.csv",
    ).snapshot;
    const sheet = firstSheet(snapshot);
    sheet.name = "Data";
    sheet.mergeData = merges;
    setCell(sheet, 1, 2, { f: "=B2*2", v: 40, t: 2 });
    setCell(sheet, 2, 2, { f: "=B3*2", v: 20, t: 2 });
    setCell(sheet, 2, 3, { f: '=SUM($B3,B$5,$B$5)+N("B3")', v: 24, t: 2 });
    writeFileSync(join(root, "book.xlsx"), minimalXlsx(snapshot));
    const { meta } = await svc.open("ws", root, "book.xlsx");
    await run(svc, root, meta.id);
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const source of ["native sort", "editor reorder"] as const) {
  test(`${source} relocates row formulas, preserves absolute references, and checkpoints correctly`, async () => {
    await withBook([], async (svc, root, id) => {
      const before = await svc.snapshot(id, root);
      const shared = { unitId: before.snapshot.id, subUnitId: before.snapshot.sheetOrder[0] ?? "" };
      const result = await svc.submit(id, root, {
        baseRev: before.meta.rev,
        source: { kind: source === "native sort" ? "agent" : "user", id: "sort-test" },
        ...(source === "native sort"
          ? {
              ops: [
                ChangeOp.parse({
                  op: "sort",
                  range: "Data!A1:D3",
                  header: true,
                  keys: [{ column: 1, order: "asc" }],
                }),
              ],
            }
          : {
              mutations: [
                {
                  id: "sheet.mutation.reorder-range",
                  params: {
                    ...shared,
                    range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 3 },
                    order: { 1: 2, 2: 1 },
                  },
                },
              ],
            }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const after = (await svc.snapshot(id, root)).snapshot;
      const cells = firstSheet(after).cellData ?? {};
      expect(cells[0]?.[0]?.v).toBe("name");
      expect(cells[1]?.[0]?.v).toBe("a");
      expect(cells[1]?.[2]?.f).toBe("=B2*2");
      expect(cells[1]?.[2]?.v).toBe(20);
      expect(cells[2]?.[2]?.f).toBe("=B3*2");
      expect(cells[2]?.[2]?.v).toBe(40);
      expect(cells[1]?.[3]?.f).toBe('=SUM($B2,B$5,$B$5)+N("B3")');
      await svc.checkpoint(id, root);
      const saved = importXlsx(readFileSync(join(root, "book.xlsx")), "book.xlsx").snapshot;
      expect(firstSheet(saved).cellData?.[1]?.[2]).toMatchObject({
        f: "=B2*2",
        v: 20,
      });
      const undo = await svc.submit(id, root, {
        baseRev: (await svc.snapshot(id, root)).meta.rev,
        source: { kind: "user", id: "undo-test" },
        mutations: [
          {
            id: "sheet.mutation.reorder-range",
            params: {
              ...shared,
              range: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 3 },
              order: { 1: 2, 2: 1 },
            },
          },
        ],
      });
      expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true });
      const restored = firstSheet((await svc.snapshot(id, root)).snapshot).cellData ?? {};
      expect(restored[1]?.[0]?.v).toBe("b");
      expect(restored[1]?.[2]).toMatchObject({ f: "=B2*2", v: 40 });
      expect(restored[2]?.[3]?.f).toBe('=SUM($B3,B$5,$B$5)+N("B3")');
    });
  }, 15000);
}

for (const [name, range] of [
  ["contained", "Data!A2:D4"],
  ["partially intersecting", "Data!A3:D4"],
] as const) {
  test(`native sort refuses ${name} data merges without changing the revision`, async () => {
    await withBook(
      [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }],
      async (svc, root, id) => {
        const before = await svc.snapshot(id, root);
        for (const dryRun of [true, false]) {
          const result = await svc.submit(id, root, {
            baseRev: before.meta.rev,
            source: { kind: "agent", id: "sort-test" },
            dryRun,
            ops: [
              ChangeOp.parse({
                op: "sort",
                range,
                header: false,
                keys: [{ column: 1, order: "asc" }],
              }),
            ],
          });
          expect(result).toMatchObject({ ok: false, message: expect.stringContaining("合并") });
          const after = await svc.snapshot(id, root);
          expect(after.meta.rev).toBe(before.meta.rev);
          expect(after.snapshot.sheets).toEqual(before.snapshot.sheets);
        }
      },
    );
  });
}

for (const [name, merge] of [
  ["header-only", { startRow: 0, endRow: 0, startColumn: 1, endColumn: 3 }],
  ["outside", { startRow: 1, endRow: 2, startColumn: 5, endColumn: 5 }],
] as const) {
  test(`native sort permits ${name} merges outside the actual data range`, async () => {
    await withBook([merge], async (svc, root, id) => {
      const before = await svc.snapshot(id, root);
      const result = await svc.submit(id, root, {
        baseRev: before.meta.rev,
        source: { kind: "agent", id: "sort-test" },
        ops: [
          ChangeOp.parse({
            op: "sort",
            range: "Data!A1:D3",
            header: true,
            keys: [{ column: 1, order: "asc" }],
          }),
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const after = (await svc.snapshot(id, root)).snapshot;
      const sheet = firstSheet(after);
      expect(sheet.cellData?.[1]?.[0]?.v).toBe("a");
      expect(sheet.cellData?.[2]?.[0]?.v).toBe("b");
      expect(sheet.mergeData).toEqual([merge]);
    });
  });
}

test("editor reorder refuses a partially intersecting merge atomically", async () => {
  await withBook(
    [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }],
    async (svc, root, id) => {
      const before = await svc.snapshot(id, root);
      const result = await svc.submit(id, root, {
        baseRev: before.meta.rev,
        source: { kind: "user", id: "sort-test" },
        mutations: [
          {
            id: "sheet.mutation.reorder-range",
            params: {
              unitId: before.snapshot.id,
              subUnitId: before.snapshot.sheetOrder[0] ?? "",
              range: { startRow: 2, endRow: 3, startColumn: 0, endColumn: 3 },
              order: { 2: 3, 3: 2 },
            },
          },
        ],
      });
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining("未生效") });
      const after = await svc.snapshot(id, root);
      expect(after.meta.rev).toBe(before.meta.rev);
      expect(after.snapshot.sheets).toEqual(before.snapshot.sheets);
    },
  );
});

test("native sort expands shared row formulas before moving their master", async () => {
  const { bootUniver, createBook } = await import("../src/engine.ts");
  const boot = bootUniver();
  try {
    const snapshot = importCsv(
      new TextEncoder().encode("name,count,double\nb,20,\na,10,\n"),
      "Data.csv",
    ).snapshot;
    const sheetId = snapshot.sheetOrder[0] ?? "";
    const sheet = firstSheet(snapshot);
    setCell(sheet, 1, 2, { f: "=B2*2", si: "shared-double", v: 40, t: 2 });
    setCell(sheet, 2, 2, { si: "shared-double", v: 20, t: 2 });
    const book = createBook(boot, snapshot);
    expect(
      await boot.executeCommand("sheet.command.sort-range", {
        unitId: book.unitId,
        subUnitId: sheetId,
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        hasTitle: true,
        orderRules: [{ colIndex: 0, type: "asc" }],
      }),
    ).toBe(true);
    expect(await boot.waitCalc(3000, true)).toBe(true);
    const cells = firstSheet(book.workbook.save()).cellData ?? {};
    expect(cells[1]?.[0]?.v).toBe("a");
    expect(cells[1]?.[2]).toMatchObject({ f: "=B2*2", v: 20 });
    expect(cells[2]?.[2]).toMatchObject({ f: "=B3*2", v: 40 });
    expect(cells[1]?.[2]?.si).toBeFalsy();
    expect(cells[2]?.[2]?.si).toBeFalsy();
  } finally {
    await boot.dispose();
  }
});

test("native multi-key sort is stable and keeps record fields and G/H formulas together", async () => {
  await withBook([], async (svc, root, id) => {
    const before = await svc.snapshot(id, root);
    const rows = [
      ["r1", "B", 1, "one", 10, 1],
      ["r2", "A", 1, "two", 20, 1],
      ["r3", "A", 2, "three", 30, 1],
      ["r4", "A", 2, "four", 40, 1],
    ];
    const seed = await svc.submit(id, root, {
      baseRev: before.meta.rev,
      source: { kind: "agent", id: "sort-test" },
      ops: [
        ChangeOp.parse({
          op: "cells.set",
          range: "Data!A1:H5",
          values: [
            ["id", "group", "priority", "label", "price", "qty", "total", "extra"],
            ...rows.map((row, i) => [...row, `=E${i + 2}*F${i + 2}`, `=G${i + 2}+1`]),
          ],
        }),
      ],
    });
    expect(seed, JSON.stringify(seed)).toMatchObject({ ok: true });
    const result = await svc.submit(id, root, {
      baseRev: (await svc.snapshot(id, root)).meta.rev,
      source: { kind: "agent", id: "sort-test" },
      ops: [
        ChangeOp.parse({
          op: "sort",
          range: "Data!A1:H5",
          header: true,
          keys: [
            { column: 2, order: "asc" },
            { column: 3, order: "desc" },
          ],
        }),
      ],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.mutations.some((m) => m.id === "sheet.mutation.reorder-range")).toBe(true);
    const snapshot = (await svc.snapshot(id, root)).snapshot;
    const cells = firstSheet(snapshot).cellData ?? {};
    for (const [index, originalIndex] of [2, 3, 1, 0].entries()) {
      const r = index + 1;
      expect(Array.from({ length: 6 }, (_, c) => cells[r]?.[c]?.v)).toEqual(rows[originalIndex]);
      expect(cells[r]?.[6]).toMatchObject({
        f: `=E${r + 1}*F${r + 1}`,
        v: (originalIndex + 1) * 10,
      });
      expect(cells[r]?.[7]).toMatchObject({ f: `=G${r + 1}+1`, v: (originalIndex + 1) * 10 + 1 });
    }
  });
});

test("native sort refuses to strand shared-formula followers outside the data range", async () => {
  const { bootUniver, createBook } = await import("../src/engine.ts");
  const boot = bootUniver();
  try {
    const snapshot = importCsv(
      new TextEncoder().encode("name,count,double\nb,20,\na,10,\nc,30,\n"),
      "Data.csv",
    ).snapshot;
    const sheetId = snapshot.sheetOrder[0] ?? "";
    const sheet = firstSheet(snapshot);
    setCell(sheet, 1, 2, { f: "=B2*2", si: "shared-double", v: 40, t: 2 });
    setCell(sheet, 2, 2, { si: "shared-double", v: 20, t: 2 });
    setCell(sheet, 3, 2, { si: "shared-double", v: 60, t: 2 });
    const book = createBook(boot, snapshot);
    const before = structuredClone(book.workbook.save().sheets);
    await expect(
      boot.executeCommand("sheet.command.sort-range", {
        unitId: book.unitId,
        subUnitId: sheetId,
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        hasTitle: true,
        orderRules: [{ colIndex: 0, type: "asc" }],
      }),
    ).resolves.toBe(false);
    expect(book.workbook.save().sheets).toEqual(before);
  } finally {
    await boot.dispose();
  }
});

for (const [boundary, range] of [
  ["follower outside", "Data!A2:C3"],
  ["master outside", "Data!A3:C4"],
] as const) {
  test(`native sort rejects a partial shared-formula group (${boundary}) without a revision`, async () => {
    await withBook([], async (svc, root, id) => {
      const initial = await svc.snapshot(id, root);
      const seeded = await svc.submit(id, root, {
        baseRev: initial.meta.rev,
        source: { kind: "user", id: "shared-seed" },
        mutations: [
          {
            id: "sheet.mutation.set-range-values",
            params: {
              unitId: initial.snapshot.id,
              subUnitId: initial.snapshot.sheetOrder[0],
              trigger: "sheet.command.set-range-values",
              cellValue: {
                1: { 2: { f: "=B2*2", si: "shared-double", v: 40, t: 2 } },
                2: { 2: { f: null, si: "shared-double", v: 20, t: 2 } },
                3: { 2: { f: null, si: "shared-double", v: 60, t: 2 } },
              },
            },
          },
        ],
      });
      expect(seeded, JSON.stringify(seeded)).toMatchObject({ ok: true });
      const before = await svc.snapshot(id, root);
      expect(firstSheet(before.snapshot).cellData?.[3]?.[2]?.si).toBe("shared-double");
      const result = await svc.submit(id, root, {
        baseRev: before.meta.rev,
        source: { kind: "agent", id: "sort-test" },
        ops: [
          ChangeOp.parse({
            op: "sort",
            range,
            header: false,
            keys: [{ column: 1, order: "desc" }],
          }),
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false });
      const after = await svc.snapshot(id, root);
      expect(after.meta.rev).toBe(before.meta.rev);
      expect(after.snapshot.sheets).toEqual(before.snapshot.sheets);
    });
  });
}

for (const [source, formula] of [
  ["native", "=B1+1"],
  ["native", "=SUM(B1:B2)"],
  ["native", "=#REF!+B1"],
  ["editor", "=B1+1"],
] as const) {
  test(`${source} sort refuses irreversible reference loss in ${formula} atomically`, async () => {
    await withBook([], async (svc, root, id) => {
      const seeded = await svc.submit(id, root, {
        baseRev: (await svc.snapshot(id, root)).meta.rev,
        source: { kind: "agent", id: "formula-seed" },
        ops: [ChangeOp.parse({ op: "cells.set", range: "Data!C3", values: [[formula]] })],
      });
      expect(seeded, JSON.stringify(seeded)).toMatchObject({ ok: true });
      const before = await svc.snapshot(id, root);
      const result = await svc.submit(id, root, {
        baseRev: before.meta.rev,
        source: { kind: source === "native" ? "agent" : "user", id: "sort-test" },
        ...(source === "native"
          ? {
              ops: [
                ChangeOp.parse({
                  op: "sort",
                  range: "Data!A1:D3",
                  header: true,
                  keys: [{ column: 1, order: "asc" }],
                }),
              ],
            }
          : {
              mutations: [
                {
                  id: "sheet.mutation.reorder-range",
                  params: {
                    unitId: before.snapshot.id,
                    subUnitId: before.snapshot.sheetOrder[0],
                    range: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 3 },
                    order: { 1: 2, 2: 1 },
                  },
                },
              ],
            }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false });
      const after = await svc.snapshot(id, root);
      expect(after.meta.rev).toBe(before.meta.rev);
      expect(after.snapshot.sheets).toEqual(before.snapshot.sheets);
    });
  });
}

for (const [formula, shifted] of [
  ["=#REF!+B3", "=#REF!+B2"],
  ['=IF(B3>0,"#REF!",B3)', '=IF(B2>0,"#REF!",B2)'],
] as const) {
  test(`native sort permits reversible references with pre-existing error text in ${formula}`, async () => {
    await withBook([], async (svc, root, id) => {
      const seeded = await svc.submit(id, root, {
        baseRev: (await svc.snapshot(id, root)).meta.rev,
        source: { kind: "agent", id: "formula-seed" },
        ops: [ChangeOp.parse({ op: "cells.set", range: "Data!C3", values: [[formula]] })],
      });
      expect(seeded, JSON.stringify(seeded)).toMatchObject({ ok: true });
      const result = await svc.submit(id, root, {
        baseRev: (await svc.snapshot(id, root)).meta.rev,
        source: { kind: "agent", id: "sort-test" },
        ops: [
          ChangeOp.parse({
            op: "sort",
            range: "Data!A1:D3",
            header: true,
            keys: [{ column: 1, order: "asc" }],
          }),
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const cells = firstSheet((await svc.snapshot(id, root)).snapshot).cellData;
      expect(cells?.[1]?.[0]?.v).toBe("a");
      expect(cells?.[1]?.[2]?.f).toBe(shifted);
    });
  });
}
