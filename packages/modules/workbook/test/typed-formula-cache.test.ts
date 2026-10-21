import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, BackupService, createReadTable, openDb } from "@excelmanus/kernel";
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
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";

test("formula boolean and empty-string caches retain their types through updates and reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "typed-cache-"));
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
    const snap = importCsv(new TextEncoder().encode("value\n"), "t.csv").snapshot;
    const sid = snap.sheetOrder[0];
    if (!sid) throw new Error("Missing sheet");
    writeFileSync(join(root, "typed.xlsx"), minimalXlsx(snap));
    const { meta } = await svc.open("ws", root, "typed.xlsx");
    const source = { kind: "agent" as const, id: "test" };
    const read = workbookTools(svc).find((tool) => tool.name === "workbook_read");
    if (!read) throw new Error("Missing read tool");
    for (const input of [1, 0, 1]) {
      const current = await svc.snapshot(meta.id, root);
      const ops =
        input === 1 && current.meta.rev === 0
          ? [
              {
                op: "cells.set" as const,
                range: "A1:D1",
                values: [[1, "=A1>0", '=IF(A1>0,"","text")', "=A1+0"]],
              },
            ]
          : [{ op: "cells.set" as const, range: "A1", values: [[input]] }];
      expect(
        await svc.submit(meta.id, root, { baseRev: current.meta.rev, source, ops }),
      ).toMatchObject({ ok: true, calc: "computed" });
      await svc.checkpoint(meta.id, root);
      const exported = importXlsx(readFileSync(join(root, "typed.xlsx")), "typed.xlsx").snapshot;
      const cells = exported.sheets[sid]?.cellData?.[0];
      if (!cells) throw new Error("Missing cells");
      expect(cells[1]).toMatchObject({ f: "=A1>0", t: 3, v: input === 1 });
      expect(cells[2]).toMatchObject({
        f: '=IF(A1>0,"","text")',
        t: 1,
        v: input === 1 ? "" : "text",
      });
      expect(cells[3]).toMatchObject({ f: "=A1+0", t: 2, v: input });
      const result = await read.execute(
        { path: "typed.xlsx", mode: "range", range: "A1:D1" },
        {
          workspaceId: "ws",
          workspaceRoot: root,
          sessionId: "test",
          agentId: "main",
          toolCallId: "read",
          role: "main",
          signal: AbortSignal.timeout(30000),
          reads: createReadTable(),
          backups: new BackupService(db).bind({
            workspaceId: "ws",
            workspaceRoot: root,
            sessionId: "test",
            agentId: "main",
          }),
        },
      );
      expect(result).toMatchObject({
        status: "ok",
        data: { values: [[input, input === 1, input === 1 ? "" : "text", input]] },
      });
    }
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
