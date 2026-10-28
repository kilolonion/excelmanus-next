import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, BackupService, createReadTable, openDb } from "@excelmanus/kernel";
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
import { tablesOf } from "../src/tables.ts";
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";

test("agent creates a real table and calculated column, updates, checkpoints and undoes", async () => {
  const root = mkdtempSync(join(tmpdir(), "table-ops-"));
  const db = openDb(join(root, "db"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    writeFileSync(
      join(root, "book.xlsx"),
      minimalXlsx(
        importCsv(new TextEncoder().encode("Qty,Price,Amount\n2,12.5,\n3,7.2,"), "book.csv")
          .snapshot,
      ),
    );
    const { meta } = await svc.open("w", root, "book.xlsx");
    const apply = async (ops: unknown[], dryRun = false) =>
      svc.submit(meta.id, root, {
        baseRev: (await svc.snapshot(meta.id, root)).meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        dryRun,
        ops: ops.map((o) => ChangeOp.parse(o)),
      });
    const add = {
      op: "table.add",
      range: "A1:C3",
      name: "Sales",
      columns: [{ name: "Qty" }, { name: "Price" }, { name: "Amount", formula: "=A2*B2" }],
    };
    expect(await apply([add], true)).toMatchObject({ ok: true });
    expect(Object.keys(tablesOf((await svc.snapshot(meta.id, root)).snapshot))).toHaveLength(0);
    expect(await apply([add])).toMatchObject({ ok: true });
    const read = workbookTools(svc).find((t) => t.name === "workbook_read")!;
    const ctx = {
      workspaceId: "w",
      workspaceRoot: root,
      sessionId: "s",
      agentId: "main",
      toolCallId: "read",
      role: "main" as const,
      signal: new AbortController().signal,
      reads: createReadTable(),
      backups: new BackupService(db).bind({
        workspaceId: "w",
        workspaceRoot: root,
        sessionId: "s",
        agentId: "main",
      }),
    };
    const overview = await read.execute({ docId: meta.id, mode: "overview" }, ctx);
    expect(JSON.stringify(overview)).toContain('"formula":"=A2*B2"');
    let { snapshot } = await svc.snapshot(meta.id, root);
    const sid = snapshot.sheetOrder[0]!;
    expect(tablesOf(snapshot)[sid]?.tables[0]?.columns[2]?.formula).toBe("=A2*B2");
    expect(snapshot.sheets[sid]?.cellData?.[2]?.[2]).toMatchObject({ f: "=A3*B3", v: 21.6 });
    const changed = await apply([
      {
        op: "table.column_formula",
        sheet: snapshot.sheets[sid]!.name,
        table: "Sales",
        column: "Amount",
        formula: "=A2*B2+1",
      },
    ]);
    expect(changed).toMatchObject({ ok: true });
    if (!changed.ok) return;
    await svc.checkpoint(meta.id, root);
    const reopened = importXlsx(readFileSync(join(root, "book.xlsx")), "book.xlsx").snapshot;
    expect(tablesOf(reopened)[sid]?.tables[0]?.columns[2]?.formula).toBe("=A2*B2+1");
    expect(reopened.sheets[sid]?.cellData?.[2]?.[2]?.v).toBe(22.6);
    expect(
      await svc.undoRevision(meta.id, root, changed.rev, { kind: "user", id: "undo" }),
    ).toMatchObject({ ok: true });
    snapshot = (await svc.snapshot(meta.id, root)).snapshot;
    expect(tablesOf(snapshot)[sid]?.tables[0]?.columns[2]?.formula).toBe("=A2*B2");
    expect(snapshot.sheets[sid]?.cellData?.[2]?.[2]?.v).toBe(21.6);
    const batched = await apply([
      { op: "sheet.add", name: "Summary" },
      {
        op: "cells.set",
        range: "Summary!C1:E3",
        values: [
          ["Qty", "Price", "Amount"],
          [2, 10, null],
          [3, 20, null],
        ],
      },
      {
        op: "table.add",
        range: "Summary!C1:E3",
        name: "Secondary",
        columns: [{ name: "Qty" }, { name: "Price" }, { name: "Amount", formula: "=C2*D2" }],
      },
      { op: "cells.set", range: "Summary!A2", values: [["=SUM(Secondary[Amount])"]] },
      { op: "cells.set", range: "Summary!A1", values: [["=SUM(Sales[Amount])"]] },
      {
        op: "table.column_formula",
        sheet: snapshot.sheets[sid]!.name,
        table: "Sales",
        column: "Amount",
        formula: "=[@Qty]*[@Price]",
      },
    ]);
    expect(batched, JSON.stringify(batched)).toMatchObject({ ok: true });
    snapshot = (await svc.snapshot(meta.id, root)).snapshot;
    expect(snapshot.sheets[sid]?.cellData?.[2]?.[2]?.v).toBe(21.6);
    expect(snapshot.sheets[sid]?.cellData?.[2]?.[2]?.f).toBe(
      "=Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]",
    );
    const summary = Object.values(snapshot.sheets).find((s) => s.name === "Summary")!;
    expect(summary.cellData?.[0]?.[0]?.v).toBe(46.6);
    expect(summary.cellData?.[1]?.[0]?.v).toBe(80);
    expect(summary.cellData?.[2]?.[4]).toMatchObject({ f: "=C3*D3", v: 60 });
    expect(tablesOf(snapshot)[summary.id!]?.tables[0]?.name).toBe("Secondary");
    await svc.checkpoint(meta.id, root);
    expect(
      await apply([
        {
          op: "table.column_formula",
          sheet: snapshot.sheets[sid]!.name,
          table: "Sales",
          column: "Amount",
          formula: "=A2*B2-1",
        },
        { op: "recalculate" },
      ]),
    ).toMatchObject({ ok: true });
    expect(
      (await svc.snapshot(meta.id, root)).snapshot.sheets[summary.id!]?.cellData?.[0]?.[0]?.v,
    ).toBe(44.6);
    await svc.checkpoint(meta.id, root);
    const persisted = importXlsx(readFileSync(join(root, "book.xlsx")), "book.xlsx").snapshot;
    expect(
      Object.values(persisted.sheets).find((s) => s.name === "Summary")?.cellData?.[0]?.[0]?.v,
    ).toBe(44.6);
    const rev = (await svc.snapshot(meta.id, root)).meta.rev;
    expect(
      await apply([{ ...add, range: `'${snapshot.sheets[sid]!.name}'!A1:C3`, name: "Other" }]),
    ).toMatchObject({ ok: false });
    expect((await svc.snapshot(meta.id, root)).meta.rev).toBe(rev);
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
