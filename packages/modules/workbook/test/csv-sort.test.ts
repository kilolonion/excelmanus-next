import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

test.each(["csv", "tsv"])(
  "%s row reorder writes data and preserves headers and paired columns",
  async (extension) => {
    const root = mkdtempSync(join(tmpdir(), "csv-sort-"));
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
      const delimiter = extension === "csv" ? "," : "\t";
      const original =
        ["name,count", "apple,2", "pear,3"].map((s) => s.replace(",", delimiter)).join("\n") + "\n";
      writeFileSync(join(root, `test.${extension}`), original);
      const { meta } = await svc.open("ws", root, `test.${extension}`);
      const snapshot = (await svc.snapshot(meta.id, root)).snapshot;
      const mutation = {
        id: "sheet.mutation.reorder-range",
        params: {
          unitId: snapshot.id,
          subUnitId: snapshot.sheetOrder[0],
          range: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 1 },
          order: { 1: 2, 2: 1 },
        },
      };
      expect(
        await svc.submit(meta.id, root, {
          baseRev: 0,
          source: { kind: "user", id: "test" },
          mutations: [mutation],
        }),
      ).toMatchObject({ ok: true });
      await svc.checkpoint(meta.id, root);
      expect(
        readFileSync(join(root, `test.${extension}`), "utf8")
          .trim()
          .split(/\r?\n/),
      ).toEqual([`name${delimiter}count`, `pear${delimiter}3`, `apple${delimiter}2`]);
      expect(
        await svc.submit(meta.id, root, {
          baseRev: 1,
          source: { kind: "user", id: "test" },
          mutations: [mutation],
        }),
      ).toMatchObject({ ok: true });
      await svc.checkpoint(meta.id, root);
      expect(readFileSync(join(root, `test.${extension}`), "utf8").trim()).toBe(original.trim());
    } finally {
      await svc.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
