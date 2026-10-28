import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  openDb,
  type ToolContext,
} from "@excelmanus/kernel";
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

test("profile top reports actual nonblank coverage instead of implying all values were listed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-coverage-"));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  const ctx: ToolContext = {
    workspaceId: "ws",
    workspaceRoot: dir,
    sessionId: "ses",
    agentId: "main",
    toolCallId: "tc",
    role: "main",
    signal: AbortSignal.timeout(20_000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "ws",
      workspaceRoot: dir,
      sessionId: "ses",
      agentId: "main",
    }),
  };
  try {
    const values = [
      ["identifier", "quantity", "empty"],
      ["00021", 0, null],
      ["00032", null, null],
      ["000043", 3, null],
      ["00540", 2, null],
      ["00650", null, null],
      ["200006", 0, null],
    ];
    expect(
      (
        await workbookEditTool(service).execute(
          {
            path: "profile.xlsx",
            create: true,
            sheetNames: ["Data"],
            ops: [{ op: "cells.set", range: "Data!A1:C7", values }],
          },
          ctx,
        )
      ).status,
    ).toBe("ok");
    const analyze = workbookTools(service).find((tool) => tool.name === "workbook_analyze");
    if (!analyze) throw new Error("workbook_analyze 未注册");
    const result = await analyze.execute(
      { path: "profile.xlsx", mode: "profile", range: "Data!A1:C7" },
      ctx,
    );
    expect(result.status).toBe("ok");
    const columns = (result.data as { columns: Record<string, unknown>[] }).columns;
    expect(columns[0]).toMatchObject({
      nonNull: 6,
      distinct: 6,
      top: [
        { v: "00021", count: 1 },
        { v: "00032", count: 1 },
        { v: "000043", count: 1 },
        { v: "00540", count: 1 },
        { v: "00650", count: 1 },
      ],
      topCoverage: {
        coveredNonNull: 5,
        totalNonNull: 6,
        truncated: true,
        frequencyTrackingTruncated: false,
      },
    });
    expect(columns[1]).toMatchObject({
      nonNull: 4,
      topCoverage: {
        coveredNonNull: 4,
        totalNonNull: 4,
        truncated: false,
        frequencyTrackingTruncated: false,
      },
    });
    expect(columns[2]).toMatchObject({
      nonNull: 0,
      top: [],
      topCoverage: {
        coveredNonNull: 0,
        totalNonNull: 0,
        truncated: false,
        frequencyTrackingTruncated: false,
      },
    });

    const capped = [["identifier"], ...Array.from({ length: 501 }, (_, i) => [`V${i}`]), ["V500"]];
    expect(
      (
        await workbookEditTool(service).execute(
          {
            path: "capped.xlsx",
            create: true,
            sheetNames: ["Data"],
            ops: [{ op: "cells.set", range: "Data!A1:A503", values: capped }],
          },
          ctx,
        )
      ).status,
    ).toBe("ok");
    const cappedResult = await analyze.execute(
      { path: "capped.xlsx", mode: "profile", range: "Data!A1:A503" },
      ctx,
    );
    expect(cappedResult.status).toBe("ok");
    expect((cappedResult.data as { columns: unknown[] }).columns[0]).toMatchObject({
      nonNull: 502,
      topCoverage: {
        coveredNonNull: 5,
        totalNonNull: 502,
        truncated: true,
        frequencyTrackingTruncated: true,
      },
    });
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
