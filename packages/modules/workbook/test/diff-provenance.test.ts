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
import { diffTables } from "../src/analysis.ts";
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

const table = (rows: (string | number | null)[][]) => ({
  name: "data",
  columns: ["id", "amount"],
  rows,
});

test("keyed diff keeps both original detail rows after reordering and pagination", () => {
  const result = diffTables(
    table([
      ["A", 10],
      ["B", 20],
      ["C", 30],
    ]),
    table([
      ["B", 21],
      ["A", 10],
      ["D", 40],
    ]),
    ["id"],
    1,
  );
  expect(result).toMatchObject({
    added: 1,
    deleted: 1,
    modified: 1,
    rowNumbering: "1-based detail rows, excludes header",
  });
  expect(result.changes).toMatchObject([
    { key: '["C"]', beforeRow: 3, afterRow: null },
    { key: '["D"]', beforeRow: null, afterRow: 3 },
  ]);
  expect(
    diffTables(
      table([
        ["A", 10],
        ["B", 20],
      ]),
      table([
        ["B", 21],
        ["A", 10],
      ]),
      ["id"],
    ).changes,
  ).toMatchObject([{ key: '["B"]', beforeRow: 2, afterRow: 1 }]);
});

test("duplicate key diagnostics identify side and original detail rows", () => {
  const unique = table([["A", 10]]);
  const duplicate = table([
    ["A", 10],
    ["B", 20],
    ["A", 30],
  ]);
  expect(() => diffTables(duplicate, unique, ["id"])).toThrow(
    '左侧业务键重复：["A"]；明细行 1、3（不含表头）',
  );
  expect(() => diffTables(unique, duplicate, ["id"])).toThrow(
    '右侧业务键重复：["A"]；明细行 1、3（不含表头）',
  );
});

test("diff tool returns worksheet provenance for unequal range starts and diagnoses duplicate rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-provenance-"));
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
  const edit = workbookEditTool(service);
  const analyze = workbookTools(service).find((tool) => tool.name === "workbook_analyze");
  if (!analyze) throw new Error("workbook_analyze 未注册");
  try {
    for (const input of [
      {
        path: "left.xlsx",
        sheetNames: ["发票"],
        range: "发票!B3:C6",
        values: [
          ["id", "amount"],
          ["A", 10],
          ["B", 20],
          ["C", 30],
        ],
      },
      {
        path: "right.xlsx",
        sheetNames: ["付款"],
        range: "付款!D7:E10",
        values: [
          ["id", "amount"],
          ["B", 21],
          ["A", 10],
          ["D", 40],
        ],
      },
    ]) {
      const result = await edit.execute(
        {
          path: input.path,
          create: true,
          sheetNames: input.sheetNames,
          ops: [{ op: "cells.set", range: input.range, values: input.values }],
        },
        ctx,
      );
      expect(result.status, JSON.stringify(result)).toBe("ok");
    }
    const args = {
      path: "left.xlsx",
      mode: "diff",
      range: "发票!B3:C6",
      keys: ["id"],
      right: { path: "right.xlsx", range: "付款!D7:E10" },
    };
    const result = await analyze.execute(args, ctx);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(result.data).toMatchObject({
      left: {
        path: "left.xlsx",
        docId: expect.any(String),
        sheet: "发票",
        range: "'发票'!B3:C6",
        headerRow: 3,
      },
      right: {
        path: "right.xlsx",
        docId: expect.any(String),
        sheet: "付款",
        range: "'付款'!D7:E10",
        headerRow: 7,
      },
      worksheetRowNumbering: "1-based worksheet rows, includes header",
      changes: [
        { key: '["B"]', beforeRow: 2, afterRow: 1, beforeWorksheetRow: 5, afterWorksheetRow: 8 },
        {
          key: '["C"]',
          beforeRow: 3,
          afterRow: null,
          beforeWorksheetRow: 6,
          afterWorksheetRow: null,
        },
        {
          key: '["D"]',
          beforeRow: null,
          afterRow: 3,
          beforeWorksheetRow: null,
          afterWorksheetRow: 10,
        },
      ],
    });
    expect(
      (
        await edit.execute(
          { path: "right.xlsx", ops: [{ op: "cells.set", range: "付款!D10", values: [["B"]] }] },
          ctx,
        )
      ).status,
    ).toBe("ok");
    const duplicate = await analyze.execute(args, ctx);
    expect(duplicate).toMatchObject({
      status: "error",
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining('右侧业务键重复：["B"]；明细行 1、3（不含表头）'),
      },
    });
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
