import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOC_PATH_MOVES_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

test("选中差异一次合并，保留目标样式，补建工作表，可撤销且拒绝过期版本", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-doc-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_PATH_MOVES_MIGRATION,
    BACKUPS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    const target = importCsv(
      new TextEncoder().encode("old,keep\nremove,5\n"),
      "target.csv",
    ).snapshot;
    target.sheets.s0!.cellData![0]![0]!.s = { bg: { rgb: "#FF0000" } };
    const source = importCsv(new TextEncoder().encode("new,ignore\n,7\n"), "source.csv").snapshot;
    source.sheets.s0!.cellData![0]![0] = { v: "=literal", t: 1 };
    source.sheets.extra = {
      id: "extra",
      name: "新增",
      rowCount: 20,
      columnCount: 10,
      cellData: { 0: { 0: { v: 42 } } },
    };
    source.sheetOrder.push("extra");
    writeFileSync(join(root, "target.xlsx"), minimalXlsx(target));
    writeFileSync(join(root, "source.xlsx"), minimalXlsx(source));
    const a = (await svc.open("ws", root, "target.xlsx")).meta;
    const b = (await svc.open("ws", root, "source.xlsx")).meta;
    const before = await svc.snapshot(a.id, root);
    const src = await svc.snapshot(b.id, root);
    const sheet = Object.values(before.snapshot.sheets)[0]!.name ?? "Sheet1";
    const request = {
      targetDocId: a.id,
      sourceDocId: b.id,
      targetRev: before.meta.rev,
      sourceRev: src.meta.rev,
      cells: [
        { sheet, cell: "A1" },
        { sheet, cell: "A2" },
        { sheet: "新增", cell: "A1" },
      ],
    };
    const result = await svc.merge("ws", root, request);
    if (!result.ok) throw Error(result.message);
    expect(result).toMatchObject({ ok: true });
    const after = await svc.snapshot(a.id, root);
    const main = Object.values(after.snapshot.sheets).find((s) => s.name === sheet)!;
    expect(main.cellData?.[0]?.[0]?.v).toBe("=literal");
    expect(main.cellData?.[0]?.[0]?.f).toBeFalsy();
    expect(main.cellData?.[1]?.[0]?.v ?? null).toBeNull();
    expect(main.cellData?.[0]?.[1]?.v).toBe("keep");
    expect(main.cellData?.[0]?.[0]?.s).toEqual(
      Object.values(before.snapshot.sheets)[0]!.cellData?.[0]?.[0]?.s,
    );
    expect(
      Object.values(after.snapshot.sheets).find((s) => s.name === "新增")?.cellData?.[0]?.[0]?.v,
    ).toBe(42);
    expect((await svc.snapshot(b.id, root)).snapshot).toEqual(src.snapshot);
    expect(await svc.merge("ws", root, request)).toMatchObject({
      ok: false,
      code: "VERSION_CONFLICT",
    });
    expect(
      await svc.undoRevision(a.id, root, result.rev, { kind: "user", id: "test" }),
    ).toMatchObject({ ok: true });
    const undone = await svc.snapshot(a.id, root);
    expect(Object.values(undone.snapshot.sheets).some((s) => s.name === "新增")).toBe(false);
    expect(Object.values(undone.snapshot.sheets)[0]!.cellData?.[0]?.[0]?.v).toBe("old");
    expect(
      await svc.submit(b.id, root, {
        baseRev: src.meta.rev,
        source: { kind: "user", id: "test-source" },
        ops: [{ op: "cells.set", range: `'${sheet}'!B1`, values: [["=B2+1"]] }],
      }),
    ).toMatchObject({ ok: true });
    await svc.recalculate(b.id, root);
    const formulaSource = await svc.snapshot(b.id, root);
    const formulaRequest = {
      ...request,
      targetRev: undone.meta.rev,
      sourceRev: formulaSource.meta.rev,
      cells: [{ sheet, cell: "B1" }],
    };
    const mergedFormula = await svc.merge("ws", root, formulaRequest);
    if (!mergedFormula.ok) throw Error(mergedFormula.message);
    await svc.recalculate(a.id, root);
    const calculated = await svc.snapshot(a.id, root);
    const formulaCell = Object.values(calculated.snapshot.sheets)[0]!.cellData?.[0]?.[1];
    expect(formulaCell?.f).toBe("=B2+1");
    expect(formulaCell?.v).toBe(6);
    expect(
      await svc.merge("ws", root, {
        ...formulaRequest,
        targetRev: calculated.meta.rev,
        sourceRev: src.meta.rev,
      }),
    ).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
