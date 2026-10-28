import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

test("格式刷的清除与设置样式同批保存、撤销，不动值公式或合并范围", async () => {
  const root = mkdtempSync(join(tmpdir(), "paint-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    DOC_MOVES_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
    BACKUPS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    const snap = importCsv(new TextEncoder().encode("name,value\n12,24\n"), "a.csv").snapshot;
    snap.sheets.s0!.cellData![1]![1] = { f: "=A2*2", v: 24 };
    writeFileSync(join(root, "paint.xlsx"), minimalXlsx(snap));
    const { meta } = await svc.open("ws", root, "paint.xlsx");
    const before = await svc.snapshot(meta.id, root);
    const sid = before.snapshot.sheetOrder[0]!;
    const style = {
      bl: 1,
      bg: { rgb: "#FF0000" },
      n: { pattern: "0.00" },
      bd: { b: { s: 9, cl: { rgb: "#12ABEF" } }, t: { s: 7, cl: { rgb: "#112233" } } },
    };
    const result = await svc.submit(meta.id, root, {
      baseRev: before.meta.rev,
      source: { kind: "user", id: "painter" },
      mutations: [
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId: before.snapshot.id,
            subUnitId: sid,
            trigger: "sheet.command.set-style",
            cellValue: { 1: { 0: { s: null }, 1: { s: null } } },
          },
        },
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId: before.snapshot.id,
            subUnitId: sid,
            trigger: "sheet.command.set-style",
            cellValue: { 1: { 0: { s: style }, 1: { s: style } } },
          },
        },
      ],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    await svc.checkpoint(meta.id, root);
    const after = importXlsx(readFileSync(join(root, "paint.xlsx")), "paint.xlsx").snapshot;
    const sheet = after.sheets[after.sheetOrder[0]!]!;
    expect(sheet.cellData?.[1]?.[0]?.v).toBe(12);
    expect(sheet.cellData?.[1]?.[1]?.f).toBe("=A2*2");
    expect(sheet.mergeData ?? []).toEqual([]);
    const s = sheet.cellData?.[1]?.[0]?.s;
    const resolved = typeof s === "string" ? after.styles?.[s] : s;
    expect(resolved).toMatchObject({ bl: 1, bg: { rgb: "#FF0000" }, bd: style.bd });
    expect(
      await svc.undoRevision(meta.id, root, result.rev, { kind: "user", id: "undo" }),
    ).toMatchObject({ ok: true });
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
