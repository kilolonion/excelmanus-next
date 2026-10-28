import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { rulesResource } from "../src/rule-codec.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

test("editor sort and filter mutations survive XLSX checkpoint and filter removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "editor-data-"));
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
    const original = importCsv(
      new TextEncoder().encode("name,count\napple,2\npear,3\n"),
      "test.csv",
    ).snapshot;
    writeFileSync(join(root, "test.xlsx"), minimalXlsx(original));
    const { meta } = await svc.open("ws", root, "test.xlsx");
    const snapshot = (await svc.snapshot(meta.id, root)).snapshot;
    const shared = { unitId: snapshot.id, subUnitId: snapshot.sheetOrder[0]! };
    const apply = async (mutations: { id: string; params: object }[]) => {
      const result = await svc.submit(meta.id, root, {
        baseRev: (await svc.snapshot(meta.id, root)).meta.rev,
        source: { kind: "user", id: "ui" },
        mutations,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    };
    await apply([
      {
        id: "sheet.mutation.reorder-range",
        params: {
          ...shared,
          range: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 1 },
          order: { 1: 2, 2: 1 },
        },
      },
    ]);
    const range = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 };
    await apply([
      { id: "sheet.mutation.set-filter-range", params: { ...shared, range } },
      {
        id: "sheet.mutation.set-filter-criteria",
        params: {
          ...shared,
          col: 0,
          criteria: { colId: 0, filters: { filters: ["pear"], blank: false } },
        },
      },
      { id: "sheet.mutation.mark-dirty-filter-change", params: { ...shared, filterRange: range } },
    ]);
    await svc.checkpoint(meta.id, root);
    const imported = importXlsx(readFileSync(join(root, "test.xlsx")), "test.xlsx").snapshot;
    const sheet = imported.sheets[imported.sheetOrder[0]!]!;
    expect(sheet.cellData?.[1]?.[0]?.v).toBe("pear");
    const resource = Object.values(rulesResource(imported, "SHEET_FILTER_PLUGIN"))[0];
    expect(resource).toMatchObject({ cachedFilteredOut: [2] });
    await apply([{ id: "sheet.mutation.remove-filter", params: shared }]);
    await svc.checkpoint(meta.id, root);
    expect(
      Object.keys(
        rulesResource((await svc.snapshot(meta.id, root)).snapshot, "SHEET_FILTER_PLUGIN"),
      ),
    ).toHaveLength(0);
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
