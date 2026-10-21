import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { DV_RESOURCE, rulesResource } from "../src/rule-codec.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

test("list validation accepts Excel quoted literals without adding quotes to the actual choices", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-list-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  try {
    writeFileSync(
      join(root, "list.xlsx"),
      minimalXlsx(importCsv(new TextEncoder().encode("状态\n待处理\n"), "list.csv").snapshot),
    );
    const { meta } = await service.open("w", root, "list.xlsx");
    const literals = ['"待处理,处理中,完成"', "待处理,处理中,完成", '="待处理,处理中,完成"'];
    for (const [i, formula1] of literals.entries()) {
      const result = await service.submit(meta.id, root, {
        baseRev: i,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        ops: [
          {
            op: "dv.add",
            id: "statuses",
            range: "A2:A20",
            type: "list",
            formula1,
            allowBlank: false,
          },
        ],
      });
      expect(result).toMatchObject({ ok: true });
      const { snapshot } = await service.snapshot(meta.id, root);
      const sid = snapshot.sheetOrder[0] ?? "";
      expect(rulesResource(snapshot, DV_RESOURCE)[sid]?.[0]).toMatchObject({
        formula1: "待处理,处理中,完成",
        showDropDown: true,
        errorStyle: 1,
      });
      await service.checkpoint(meta.id, root);
      const disk = importXlsx(readFileSync(join(root, "list.xlsx")), "list.xlsx").snapshot;
      expect(rulesResource(disk, DV_RESOURCE)[disk.sheetOrder[0] ?? ""]?.[0]?.formula1).toBe(
        "待处理,处理中,完成",
      );
      expect(disk.sheets[disk.sheetOrder[0] ?? ""]?.cellData?.[1]?.[0]?.v).toBe("待处理");
    }
  } finally {
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
