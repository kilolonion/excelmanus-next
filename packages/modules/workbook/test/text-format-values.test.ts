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

test("styling reconciliation rows preserves leading-zero keys and cell types", async () => {
  const root = mkdtempSync(join(tmpdir(), "text-format-"));
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
    const snap = importCsv(new TextEncoder().encode("key\n"), "report.csv").snapshot;
    const sid = snap.sheetOrder[0] ?? "";
    const initial = snap.sheets[sid];
    if (!initial) throw new Error("Missing test worksheet");
    initial.name = "报告";
    writeFileSync(join(root, "report.xlsx"), minimalXlsx(snap));
    const { meta } = await svc.open("ws", root, "report.xlsx");
    const source = { kind: "agent" as const, id: "test" };
    expect(
      await svc.submit(meta.id, root, {
        baseRev: 0,
        source,
        ops: [
          {
            op: "cells.set",
            range: "报告!A2:E3",
            values: [
              ["0001", '=A2&""', 100, true, "001234567890123456789"],
              ["0002", '=A3&""', 200, false, "002234567890123456789"],
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: true, rev: 1 });
    const before = (await svc.snapshot(meta.id, root)).snapshot;
    expect(before.sheets[sid]?.cellData?.[1]?.[0]).toMatchObject({ v: "0001", t: 1 });
    expect(before.sheets[sid]?.cellData?.[2]?.[0]).toMatchObject({ v: "0002", t: 1 });
    expect(
      await svc.submit(meta.id, root, {
        baseRev: 1,
        source,
        ops: [
          { op: "style.set", range: "报告!A1:B1", bold: true },
          { op: "rows.height", sheet: "报告", at: 1, count: 1, pixels: 28 },
          {
            op: "style.set",
            range: "报告!A1:E3",
            borders: { bottom: { style: "thin", color: "#BFBFBF" } },
          },
          { op: "style.set", range: "报告!A2:A3", numFmt: "@", hAlign: "left" },
          { op: "style.set", range: "报告!A2:E2", fill: "#FFF2CC" },
          { op: "style.set", range: "报告!A3:E3", bold: true, fill: "#D9E2F3" },
        ],
      }),
    ).toMatchObject({ ok: true, rev: 2 });
    const after = (await svc.snapshot(meta.id, root)).snapshot;
    expect(after.sheets[sid]?.cellData?.[1]?.[0]).toMatchObject({ v: "0001", t: 1 });
    expect(after.sheets[sid]?.cellData?.[2]?.[0]).toMatchObject({ v: "0002", t: 1 });
    expect(after.sheets[sid]?.cellData?.[1]?.[1]).toMatchObject({ f: '=A2&""', v: "0001" });
    expect(after.sheets[sid]?.cellData?.[1]?.[2]).toMatchObject({ v: 100, t: 2 });
    expect(after.sheets[sid]?.cellData?.[1]?.[3]).toMatchObject({ t: 3 });
    expect(after.sheets[sid]?.cellData?.[1]?.[4]).toMatchObject({
      v: "001234567890123456789",
      t: 1,
    });
    const read = workbookTools(svc).find((tool) => tool.name === "workbook_read");
    if (!read) throw new Error("Missing workbook_read tool");
    const result = await read.execute(
      { path: "report.xlsx", mode: "range", range: "报告!A2:A3" },
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
    expect(result).toMatchObject({ status: "ok", data: { values: [["0001"], ["0002"]] } });
    await svc.checkpoint(meta.id, root);
    const exported = importXlsx(readFileSync(join(root, "report.xlsx")), "report.xlsx").snapshot;
    const sheet = exported.sheets[exported.sheetOrder[0] ?? ""];
    expect(sheet?.cellData?.[1]?.[0]).toMatchObject({ v: "0001", t: 1 });
    expect(sheet?.cellData?.[2]?.[0]).toMatchObject({ v: "0002", t: 1 });
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
