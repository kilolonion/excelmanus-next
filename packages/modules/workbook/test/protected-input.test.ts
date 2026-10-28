import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  openDb,
  sha256,
  type ToolContext,
} from "@excelmanus/kernel";
import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { minimalXlsx, workbookProtection } from "../src/checkpoint.ts";
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
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";

for (const action of [
  "edit",
  "dryRun",
  "rawMutation",
  "recalculate",
  "recalcOp",
  "export",
] as const) {
  test(`受保护输入仍可读取，${action} 明确拒绝且原字节不变`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "protected-input-"));
    const db = openDb(join(dir, "db.sqlite"), [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      BACKUPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ]);
    const service = new DocumentService(db);
    try {
      const snap = importCsv(
        new TextEncoder().encode("Qty,Price,Amount\n3,12.5,\n"),
        "Source.csv",
      ).snapshot;
      snap.sheets[snap.sheetOrder[0]!]!.name = "Source";
      snap.sheets[snap.sheetOrder[0]!]!.cellData![1]![2] = { f: "=A2*B2" };
      const parts = unzipSync(minimalXlsx(snap));
      parts["[Content_Types].xml"] = new TextEncoder().encode(
        new TextDecoder()
          .decode(parts["[Content_Types].xml"])
          .replace(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
          ),
      );
      parts["xl/worksheets/sheet1.xml"] = new TextEncoder().encode(
        new TextDecoder()
          .decode(parts["xl/worksheets/sheet1.xml"])
          .replace("</worksheet>", '<sheetProtection sheet="1" password="ABCD"/></worksheet>'),
      );
      const original = zipSync(parts);
      writeFileSync(join(dir, "book.xlsx"), original);
      const { meta } = await service.open("w", dir, "book.xlsx");
      const entry = await service.entry(meta.id, dir);
      await entry.live.boot.waitCalc(5000);
      const before = await service.snapshot(meta.id, dir);
      const sid = before.snapshot.sheetOrder[0]!;
      const ctx: ToolContext = {
        workspaceId: "w",
        workspaceRoot: dir,
        sessionId: "s",
        agentId: "main",
        toolCallId: "tc",
        role: "main",
        reads: createReadTable(),
        signal: AbortSignal.timeout(10000),
        backups: new BackupService(db).bind({
          workspaceId: "w",
          workspaceRoot: dir,
          sessionId: "s",
          agentId: "main",
        }),
      };
      const tools = workbookTools(service);
      if (action === "recalculate") {
        await expect(service.recalculate(meta.id, dir)).rejects.toMatchObject({
          code: "UNSUPPORTED_FEATURE",
          message: expect.stringContaining("保护"),
        });
      } else if (action === "export") {
        const result = await tools
          .find((t) => t.name === "workbook_export")!
          .execute(
            {
              mode: "convert",
              path: "book.xlsx",
              to: "copy.csv",
              format: "csv",
              sheet: before.snapshot.sheets[sid]!.name,
            },
            ctx,
          );
        expect(result).toMatchObject({
          status: "error",
          error: { code: "UNSUPPORTED_FEATURE", message: expect.stringContaining("保护") },
        });
      } else {
        const result = await service.submit(meta.id, dir, {
          baseRev: before.meta.rev,
          source: { kind: "agent", id: "main" },
          sessionId: "s",
          dryRun: action === "dryRun",
          ...(action === "rawMutation"
            ? {
                mutations: [
                  {
                    id: "sheet.mutation.set-range-values",
                    params: {
                      unitId: before.snapshot.id,
                      subUnitId: sid,
                      cellValue: { 1: { 0: { v: 9 } } },
                    },
                  },
                ],
              }
            : {
                ops: [
                  ChangeOp.parse(
                    action === "recalcOp"
                      ? { op: "recalculate" }
                      : { op: "cells.set", range: "'Source'!A2", values: [[9]] },
                  ),
                ],
              }),
        });
        expect(result).toMatchObject({
          ok: false,
          code: "UNSUPPORTED_FEATURE",
          message: expect.stringContaining("保护"),
        });
      }
      await service.checkpoint(meta.id, dir);
      expect(readFileSync(join(dir, "book.xlsx"))).toEqual(Buffer.from(original));
      expect((await service.snapshot(meta.id, dir)).meta.rev).toBe(before.meta.rev);
      const result = await tools
        .find((t) => t.name === "workbook_read")!
        .execute({ path: "book.xlsx", mode: "overview", depth: 2 }, ctx);
      expect(result).toMatchObject({
        status: "ok",
        data: {
          packageFormat: { macroEnabled: true, vbaProjectPresent: false },
          protection: { readOnly: true, sheets: [{ sheet: "Source" }] },
        },
      });
    } finally {
      await service.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("旧版本受保护文件有未写回日志时，重开保留日志但拒绝检查点写源", async () => {
  const dir = mkdtempSync(join(tmpdir(), "protected-pending-"));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  let service = new DocumentService(db);
  try {
    const snap = importCsv(new TextEncoder().encode("Qty\n3\n"), "Source.csv").snapshot;
    const original = minimalXlsx(snap);
    writeFileSync(join(dir, "book.xlsx"), original);
    const { meta } = await service.open("w", dir, "book.xlsx");
    const initial = await service.snapshot(meta.id, dir);
    const sheet = initial.snapshot.sheets[initial.snapshot.sheetOrder[0]!]!.name!;
    const edit = await service.submit(meta.id, dir, {
      baseRev: initial.meta.rev,
      source: { kind: "agent", id: "old-version" },
      sessionId: "s",
      ops: [ChangeOp.parse({ op: "cells.set", range: `'${sheet}'!A2`, values: [[9]] })],
    });
    expect(edit.ok).toBe(true);
    await service.close();
    // Seed the persisted state of an old version: protected disk baseline plus author log.
    const parts = unzipSync(original);
    parts["xl/worksheets/sheet1.xml"] = new TextEncoder().encode(
      new TextDecoder()
        .decode(parts["xl/worksheets/sheet1.xml"])
        .replace("</worksheet>", '<sheetProtection sheet="1"/></worksheet>'),
    );
    const protectedBytes = zipSync(parts);
    writeFileSync(join(dir, "book.xlsx"), protectedBytes);
    db.prepare(
      "UPDATE documents SET checkpoint_rev=0, checkpoint_hash=?, checkpoint_snapshot=? WHERE id=?",
    ).run(sha256(protectedBytes), JSON.stringify(initial.snapshot), meta.id);
    const logCount = db.prepare("SELECT count(*) AS n FROM doc_ops WHERE doc_id=?").get(meta.id);
    service = new DocumentService(db);
    const reopened = await service.open("w", dir, "book.xlsx");
    expect(readFileSync(join(dir, "book.xlsx"))).toEqual(Buffer.from(protectedBytes));
    expect(reopened.meta.checkpointError).toContain("保护");
    await expect(service.checkpoint(meta.id, dir)).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });
    expect(db.prepare("SELECT count(*) AS n FROM doc_ops WHERE doc_id=?").get(meta.id)).toEqual(
      logCount,
    );
    expect(readFileSync(join(dir, "book.xlsx"))).toEqual(Buffer.from(protectedBytes));
    await expect(service.close()).rejects.toThrow("日志已保留");
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [tag, active] of [
  ['<sheetProtection sheet=" true "/>', true],
  [
    '<x:sheetProtection xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" sheet="1"/>',
    true,
  ],
  ['<sheetProtection sheet="0"/>', false],
  ['<sheetProtection sheet="false"/>', false],
] as const) {
  test(`保护标记识别 ${tag}`, () => {
    const parts = unzipSync(
      minimalXlsx(importCsv(new TextEncoder().encode("x\n1\n"), "test.csv").snapshot),
    );
    parts["xl/worksheets/sheet1.xml"] = new TextEncoder().encode(
      new TextDecoder()
        .decode(parts["xl/worksheets/sheet1.xml"])
        .replace("</worksheet>", `${tag}</worksheet>`),
    );
    expect(workbookProtection(importXlsx(zipSync(parts), "test.xlsx")).readOnly).toBe(active);
  });
}
