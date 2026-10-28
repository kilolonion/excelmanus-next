import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  type ToolContext,
} from "@excelmanus/kernel";
import { printNamesOf, printSettingsOf } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
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

test("public print read exposes current raw settings, defaults, scoped titles and leaves bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "print-tools-"));
  const db = openDb(join(dir, "test.sqlite"), [
    ...KERNEL_MIGRATIONS,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    db.prepare(
      "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES ('w', 'w', ?, 1, 0, '2026-10-20T00:00:00.000Z')",
    ).run(dir);
    const bytes = Buffer.from(
      readFileSync(new URL("./fixtures/printing.xlsx.base64", import.meta.url), "utf8"),
      "base64",
    );
    writeFileSync(join(dir, "print.xlsx"), bytes);
    const ctx: ToolContext = {
      workspaceId: "w",
      workspaceRoot: dir,
      agentId: "main",
      sessionId: "s",
      toolCallId: "print-test",
      role: "main",
      signal: AbortSignal.timeout(60000),
      reads: createReadTable(),
      backups: new BackupService(db).bind({
        workspaceId: "w",
        workspaceRoot: dir,
        sessionId: "s",
        agentId: "main",
      }),
    };
    const read = workbookTools(svc).find((tool) => tool.name === "workbook_read")!;
    expect(read.input.safeParse({ path: "print.xlsx", mode: "print" }).success).toBe(true);
    const result = await read.execute({ path: "print.xlsx", mode: "print" }, ctx);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.data).toMatchObject({
      mode: "print",
      source: "current_revision",
      print: [
        {
          sheet: "打印",
          printArea: "A1:F24",
          repeatRows: "1:2",
          repeatColumns: null,
          afterRows: [12],
          afterColumns: [3],
          raw: {
            pageSetup: { paperSize: "9", orientation: "landscape", fitToHeight: "0" },
            pageMargins: {
              left: "0.4",
              right: "0.4",
              top: "0.5",
              bottom: "0.5",
              header: "0.3",
              footer: "0.3",
            },
            headerFooter: {
              oddHeader: "&LLayout QA&C&F&R&A",
              oddFooter: "&LInternal&CPage &P of &N&R2026",
            },
          },
          effective: { fitToWidth: 1, fitToHeight: 0, orientation: "landscape", mode: "fit" },
          defaulted: expect.arrayContaining(["fitToWidth"]),
        },
      ],
    });
    expect(readFileSync(join(dir, "print.xlsx"))).toEqual(bytes);
    const edit = await workbookEditTool(svc).execute(
      {
        path: "print.xlsx",
        ops: [
          {
            op: "print.set",
            sheet: "打印",
            printArea: "A1:E22",
            repeatRows: "1:3",
            afterRows: [10],
            afterColumns: [4],
            orientation: "portrait",
            oddHeader: "&LLayout Round3&C&A&R&F",
          },
          { op: "cells.set", range: "打印!B3", values: [[37]] },
          { op: "print.set", sheet: "打印", oddFooter: "&LPrivate&C&P / &N&R2026" },
        ],
      },
      ctx,
    );
    expect(edit.status, JSON.stringify(edit.error)).toBe("ok");
    expect(edit.data).toMatchObject({
      changes: { structural: expect.arrayContaining(["更新打印设置（打印）"]) },
    });
    const opened = await svc.open("w", dir, "print.xlsx");
    const current = await svc.snapshot(opened.meta.id, dir);
    const sid = current.snapshot.sheetOrder[0]!;
    const currentRead = await read.execute(
      { path: "print.xlsx", mode: "print", sheet: "打印" },
      ctx,
    );
    expect(currentRead.data).toMatchObject({
      rev: current.meta.rev,
      print: [
        {
          printArea: "A1:E22",
          repeatRows: "1:3",
          afterRows: [10],
          afterColumns: [4],
          raw: {
            pageSetup: { paperSize: "9", orientation: "portrait", fitToHeight: "0" },
            headerFooter: {
              oddHeader: "&LLayout Round3&C&A&R&F",
              oddFooter: "&LPrivate&C&P / &N&R2026",
            },
          },
        },
      ],
    });
    const invalid = await svc.submit(opened.meta.id, dir, {
      baseRev: current.meta.rev,
      source: { kind: "agent", id: "main" },
      sessionId: "s",
      ops: [
        { op: "print.set", sheet: "打印", orientation: "landscape" },
        { op: "print.set", sheet: "打印", repeatRows: "3:1" },
      ],
    });
    expect(invalid).toMatchObject({ ok: false, code: "BAD_OPERATION" });
    expect((await svc.snapshot(opened.meta.id, dir)).meta.rev).toBe(current.meta.rev);
    expect(printSettingsOf((await svc.snapshot(opened.meta.id, dir)).snapshot.sheets[sid])).toEqual(
      printSettingsOf(current.snapshot.sheets[sid]),
    );
    await svc.checkpoint(opened.meta.id, dir);
    const reopened = importXlsx(readFileSync(join(dir, "print.xlsx")), "print.xlsx").snapshot;
    const reopenedId = reopened.sheetOrder[0]!;
    expect(printNamesOf(reopened, reopenedId)).toMatchObject({
      printArea: "A1:E22",
      repeatRows: "1:3",
    });
    expect(printSettingsOf(reopened.sheets[reopenedId])).toEqual(
      printSettingsOf(current.snapshot.sheets[sid]),
    );
    expect(reopened.sheets[reopenedId]?.cellData?.[2]?.[1]?.v).toBe(37);
    const undo = await svc.revert(opened.meta.id, dir, current.meta.rev, {
      kind: "user",
      id: "qa",
    });
    expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true });
    const restored = (await svc.snapshot(opened.meta.id, dir)).snapshot;
    const original = importXlsx(bytes, "print.xlsx").snapshot;
    expect(printSettingsOf(restored.sheets[sid])).toEqual(
      printSettingsOf(original.sheets[original.sheetOrder[0]!]!),
    );
    expect(printNamesOf(restored, sid)).toMatchObject({ printArea: "A1:F24", repeatRows: "1:2" });
  } finally {
    await svc.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
