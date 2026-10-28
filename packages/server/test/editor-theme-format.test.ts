import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../../modules/workbook/src/checkpoint.ts";
import { importCsv } from "../../modules/workbook/src/csv.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../../modules/workbook/src/service.ts";
import { importXlsx } from "../../modules/workbook/src/xlsx.ts";
import { dropEditorThemeColor } from "../../web/src/lib/workbook/univer-theme.ts";

function percentageCell(snapshot: ReturnType<typeof importCsv>["snapshot"]) {
  const cell = snapshot.sheets[snapshot.sheetOrder[0] ?? ""]?.cellData?.[1]?.[0];
  const style = typeof cell?.s === "string" ? snapshot.styles[cell.s] : cell?.s;
  return { value: cell?.v, pattern: style?.n?.pattern ?? "General", bold: style?.bl === 1 };
}

async function editAndRoundTrip(style: { cl: { rgb: string } } | null) {
  const root = mkdtempSync(join(tmpdir(), "editor-theme-format-"));
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
    const original = importCsv(new TextEncoder().encode("percentage\n0.25\n"), "test.csv").snapshot;
    const cell = original.sheets[original.sheetOrder[0] ?? ""]?.cellData?.[1]?.[0];
    if (!cell) throw new Error("Missing test percentage cell");
    cell.s = {
      n: { pattern: "0.00%" },
      bl: 1,
    };
    writeFileSync(join(root, "test.xlsx"), minimalXlsx(original));
    const { meta } = await svc.open("ws", root, "test.xlsx");
    const snapshot = (await svc.snapshot(meta.id, root)).snapshot;
    expect(percentageCell(snapshot)).toEqual({ value: 0.25, pattern: "0.00%", bold: true });
    const mutation = dropEditorThemeColor({
      id: "sheet.mutation.set-range-values",
      params: {
        unitId: snapshot.id,
        subUnitId: snapshot.sheetOrder[0] ?? "",
        trigger: "sheet.command.set-range-values",
        cellValue: { 1: { 0: { v: 0.5, t: 2, s: style } } },
      },
    });
    const result = await svc.submit(meta.id, root, {
      baseRev: meta.rev,
      source: { kind: "user", id: "ui" },
      mutations: [mutation],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, rev: 1 });
    const edited = percentageCell((await svc.snapshot(meta.id, root)).snapshot);
    await svc.checkpoint(meta.id, root);
    const exported = importXlsx(readFileSync(join(root, "test.xlsx")), "test.xlsx").snapshot;
    return { edited, reopened: percentageCell(exported) };
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("editor theme-color cleanup preserves percentage format through engine and XLSX round-trip", async () => {
  const result = await editAndRoundTrip({ cl: { rgb: "#000000" } });
  expect(result).toEqual({
    edited: { value: 0.5, pattern: "0.00%", bold: true },
    reopened: { value: 0.5, pattern: "0.00%", bold: true },
  });
});

test("explicit editor style null still clears percentage format through engine and XLSX round-trip", async () => {
  const result = await editAndRoundTrip(null);
  expect(result).toEqual({
    edited: { value: 0.5, pattern: "General", bold: false },
    reopened: { value: 0.5, pattern: "General", bold: false },
  });
});
