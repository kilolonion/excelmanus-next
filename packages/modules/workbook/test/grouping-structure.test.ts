import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { assertWritable } from "../src/checkpoint.ts";
import { type ChangeOp, compileOps } from "../src/ops.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";
import { bytesOf, textOf } from "../src/xml.ts";

const source = () =>
  Buffer.from(
    readFileSync(new URL("./fixtures/grouping.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
async function actor(
  run: (svc: DocumentService, id: string, dir: string) => Promise<void>,
  input: Uint8Array = source(),
) {
  const dir = mkdtempSync(join(tmpdir(), "outline-structure-"));
  writeFileSync(join(dir, "book.xlsx"), input);
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    const { meta } = await svc.open("ws", dir, "book.xlsx");
    await run(svc, meta.id, dir);
  } finally {
    await svc.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const insert = { op: "rows.insert", sheet: "s0", at: 3, count: 2 } as const;
const remove = { op: "rows.delete", sheet: "s0", at: 14, count: 1 } as const;
const sender = { kind: "agent" as const, id: "outline" };

test("same-batch sheet identity changes cannot bypass group protection and leave no partial changes", async () => {
  const outcomes: Array<{
    operation: string;
    guardRejected: boolean;
    rejected: boolean;
    snapshotUnchanged: boolean;
    fileUnchanged: boolean;
  }> = [];
  for (const operation of ["sheet.rename", "sheet.copy", "sheet.add"] as const) {
    const ops: ChangeOp[] = [
      ...(operation === "sheet.add"
        ? ([
            { op: "sheet.add", name: "Renamed" },
            { op: "axis.group", sheet: "Renamed", axis: "rows", at: 3, count: 3, level: 1 },
          ] as ChangeOp[])
        : [{ op: operation, sheet: "s0", name: "Renamed" }]),
      { op: "rows.delete", sheet: "Renamed", at: 3, count: 1 },
    ];
    const imported = importXlsx(source(), "book.xlsx");
    const compiled = compileOps({ snapshot: imported.snapshot, unitId: imported.snapshot.id }, ops);
    let guardRejected = false;
    try {
      assertWritable(imported, compiled.ranges, ops, [], imported.snapshot);
    } catch {
      guardRejected = true;
    }
    await actor(async (svc, id, dir) => {
      const before = (await svc.snapshot(id, dir)).snapshot;
      const result = await svc.submit(id, dir, { baseRev: 0, source: sender, ops });
      outcomes.push({
        operation,
        guardRejected,
        rejected: !result.ok && result.code === "UNSUPPORTED_FEATURE",
        snapshotUnchanged:
          JSON.stringify((await svc.snapshot(id, dir)).snapshot) === JSON.stringify(before),
        fileUnchanged: readFileSync(join(dir, "book.xlsx")).equals(source()),
      });
    });
  }
  const imported = importXlsx(source(), "book.xlsx");
  for (const identity of ["sheet.mutation.set-worksheet-name", "sheet.mutation.insert-sheet"]) {
    expect(() =>
      assertWritable(
        imported,
        [{ sheetId: "s0", r0: 0, r1: 1, c0: 0, c1: 15 }],
        undefined,
        [
          {
            id: identity,
            params: {
              unitId: imported.snapshot.id,
              subUnitId: "s0",
              name: "Renamed",
              sheet: { ...imported.snapshot.sheets.s0, id: "copy", name: "Copied" },
              index: 1,
            },
          },
          {
            id: "sheet.mutation.insert-row",
            params: {
              unitId: imported.snapshot.id,
              subUnitId: "s0",
              range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 15 },
            },
          },
        ],
        imported.snapshot,
      ),
    ).toThrow(/同批/);
  }
  expect(outcomes).toEqual(
    ["sheet.rename", "sheet.copy", "sheet.add"].map((operation) => ({
      operation,
      guardRejected: true,
      rejected: true,
      snapshotUnchanged: true,
      fileUnchanged: true,
    })),
  );
}, 60000);

test("6c actor shifts complete nested groups and independent hiding, checkpoints and reopens", async () => {
  await actor(async (svc, id, dir) => {
    const result = await svc.submit(id, dir, { baseRev: 0, source: sender, ops: [insert, remove] });
    expect(result).toMatchObject({ ok: true });
    const { snapshot } = await svc.snapshot(id, dir);
    const original = importXlsx(source(), "original.xlsx").snapshot.sheets.s0!;
    const sheet = snapshot.sheets.s0!;
    for (const r of [2, 3]) {
      expect(sheet.rowData?.[r]?.hd ?? 0).toBe(0);
      expect(sheet.rowData?.[r]?.custom ?? {}).toEqual({});
      expect(
        Object.values(sheet.cellData?.[r] ?? {}).some((cell) => cell?.v != null || cell?.f),
      ).toBe(false);
    }
    for (let r = 2; r <= 8; r++) expect(sheet.rowData?.[r + 2]).toEqual(original.rowData?.[r]);
    expect(sheet.rowData?.[12]?.hd).toBe(1);
    expect(sheet.columnData).toEqual(original.columnData);
    expect(sheet.cellData?.[4]?.[2]?.f).toBe("=B5*2");
    await svc.checkpoint(id, dir);
    const reopened = importXlsx(readFileSync(join(dir, "book.xlsx")), "book.xlsx").snapshot.sheets
      .s0!;
    for (const r of [4, 5, 6, 7, 8, 9, 10, 12])
      expect(reopened.rowData?.[r]).toEqual(sheet.rowData?.[r]);
    expect(reopened.columnData).toEqual(original.columnData);
    expect(reopened.cellData?.[4]?.[2]?.f).toBe("=B5*2");
    const undo = await svc.revert(id, dir, result.ok ? result.rev : 0, sender);
    expect(undo).toMatchObject({ ok: true });
    await svc.checkpoint(id, dir);
    const restored = importXlsx(readFileSync(join(dir, "book.xlsx")), "book.xlsx").snapshot.sheets
      .s0!;
    for (const r of [2, 3, 4, 5, 6, 7, 8, 10])
      expect(restored.rowData?.[r]).toEqual(original.rowData?.[r]);
    expect(restored.columnData).toEqual(original.columnData);
    expect(restored.cellData?.[2]?.[2]?.f).toBe("=B3*2");
  });
}, 60000);

test("inside-group insertion and member or summary deletion reject atomically before files change", async () => {
  await actor(async (svc, id, dir) => {
    const before = (await svc.snapshot(id, dir)).snapshot;
    for (const bad of [
      { ...insert, at: 4 },
      { ...remove, at: 3 },
      { ...remove, at: 6 },
      { ...remove, at: 9 },
    ]) {
      const result = await svc.submit(id, dir, {
        baseRev: 0,
        source: sender,
        ops: [{ op: "cells.set", range: "s0!B1", values: [[99]] }, bad],
      });
      expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_FEATURE" });
      expect((await svc.snapshot(id, dir)).snapshot).toEqual(before);
      expect(readFileSync(join(dir, "book.xlsx"))).toEqual(source());
    }
  });
}, 60000);

test("current and same-batch outlines and print coordinates participate in structure guards", () => {
  const imported = importXlsx(source(), "book.xlsx");
  const before = structuredClone(imported.snapshot);
  const check = (ops: ChangeOp[]) => {
    const compiled = compileOps({ snapshot: before, unitId: before.id }, ops);
    return () => assertWritable(imported, compiled.ranges, ops, [], before);
  };
  expect(
    check([
      { op: "axis.group", sheet: "s0", axis: "rows", at: 3, count: 6, level: 0 },
      { ...remove, at: 3 },
    ]),
  ).toThrow();
  before.sheets.s0!.rowData![12] = { custom: { excelmanusOutlineLevel: 1 } };
  expect(check([{ ...remove, at: 13 }])).toThrow();
  expect(
    check([
      { op: "axis.group", sheet: "s0", axis: "rows", at: 13, count: 2, level: 1 },
      { ...insert, at: 14 },
    ]),
  ).toThrow();
  expect(check([{ op: "print.set", sheet: "s0", afterRows: [12] }, insert])).toThrow(/打印|分页/);
  before.sheets.s0!.custom = {
    ...before.sheets.s0!.custom,
    excelmanusPrintSettings: { rowBreaks: { attributes: {}, breaks: [{ id: "12" }] } },
  };
  expect(check([insert])).toThrow(/打印|分页/);
});

test("original page breaks and drawing objects remain protected while row-only column metadata survives", () => {
  for (const extra of [
    '<rowBreaks count="1"><brk id="12" min="0" max="16383"/></rowBreaks>',
    '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId99"/>',
  ]) {
    const parts: Record<string, Uint8Array> = unzipSync(source());
    parts["xl/worksheets/sheet1.xml"] = bytesOf(
      textOf(parts["xl/worksheets/sheet1.xml"]!).replace("</worksheet>", `${extra}</worksheet>`),
    );
    const imported = importXlsx(zipSync(parts), "guard.xlsx");
    const ops = [insert];
    const compiled = compileOps({ snapshot: imported.snapshot, unitId: imported.snapshot.id }, ops);
    expect(() => assertWritable(imported, compiled.ranges, ops, [], imported.snapshot)).toThrow();
  }
});

test("safe shifts retain row height and untouched unknown column attributes, including a same-batch new column level", async () => {
  const parts: Record<string, Uint8Array> = unzipSync(source());
  parts["xl/worksheets/sheet1.xml"] = bytesOf(
    textOf(parts["xl/worksheets/sheet1.xml"]!)
      .replace('<row r="3"', '<row r="3" ht="30" customHeight="1"')
      .replace('<row r="12"', '<row r="12" ht="24" customHeight="1" hidden="1"')
      .replace('<col min="1"', '<col vendor="keep" min="1"'),
  );
  await actor(async (svc, id, dir) => {
    const result = await svc.submit(id, dir, {
      baseRev: 0,
      source: sender,
      ops: [
        { op: "axis.group", sheet: "s0", axis: "cols", at: 1, count: 1, level: 1 },
        insert,
        remove,
      ],
    });
    expect(result).toMatchObject({ ok: true });
    await svc.checkpoint(id, dir);
    const bytes = readFileSync(join(dir, "book.xlsx"));
    const sheet = importXlsx(bytes, "book.xlsx").snapshot.sheets.s0!;
    expect(sheet.rowData?.[4]?.h).toBe(40);
    expect(sheet.rowData?.[2]?.h).toBeUndefined();
    expect(sheet.columnData?.[0]?.custom?.excelmanusOutlineLevel).toBe(1);
    expect(sheet.columnData?.[4]?.custom?.excelmanusCollapsed).toBe(true);
    expect(textOf(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!)).toContain('vendor="keep"');
    expect(await svc.revert(id, dir, result.ok ? result.rev : 0, sender)).toMatchObject({
      ok: true,
    });
    await svc.checkpoint(id, dir);
    const restored = importXlsx(readFileSync(join(dir, "book.xlsx")), "book.xlsx").snapshot.sheets
      .s0!;
    expect(restored.rowData?.[11]).toMatchObject({ h: 32, hd: 1 });
    expect(restored.cellData?.[11]?.[0]?.v).toBe(12);
  }, zipSync(parts));
}, 60000);

test("summary-above groups move together, and checkpoint protection is mapped through prior shifts", () => {
  const imported = importXlsx(source(), "book.xlsx");
  imported.snapshot.sheets.s0!.custom = {
    ...imported.snapshot.sheets.s0!.custom,
    excelmanusOutlineSettings: { summaryBelow: "false" },
  };
  const before = structuredClone(imported.snapshot);
  const check = (at: number) => () =>
    assertWritable(
      imported,
      [{ sheetId: "s0", r0: 0, r1: 30, c0: 0, c1: 15 }],
      [{ ...insert, at }],
      [],
      before,
    );
  expect(check(2)).not.toThrow();
  expect(check(3)).toThrow(/整组/);
  const shifted = structuredClone(imported.snapshot);
  shifted.sheets.s0!.rowData = {};
  // A prior ungroup cannot make original members deletable, even after a safe earlier insertion.
  expect(() =>
    assertWritable(
      imported,
      [{ sheetId: "s0", r0: 4, r1: 4, c0: 0, c1: 15 }],
      [{ ...remove, at: 5 }],
      [],
      shifted,
      [{ sheetId: "s0", kind: "insertRows", index: 0, count: 2 }],
    ),
  ).toThrow(/整组/);
});

test("row group support does not silently open column structure changes", () => {
  const imported = importXlsx(source(), "book.xlsx");
  imported.snapshot.sheets.s0!.columnData = {};
  const op = { op: "cols.insert", sheet: "s0", at: 1, count: 1 } as const;
  expect(() =>
    assertWritable(
      imported,
      [{ sheetId: "s0", r0: 0, r1: 20, c0: 0, c1: 0 }],
      [op],
      [],
      imported.snapshot,
    ),
  ).toThrow(/分组/);
});
