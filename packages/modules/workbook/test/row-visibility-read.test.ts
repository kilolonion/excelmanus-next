import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("workbook_read reports effective row visibility for only its returned window without writing source bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "row-visibility-"));
  const db = openDb(join(dir, "test.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    const snapshot = importCsv(
      new TextEncoder().encode(
        [
          "ID,Status,Quantity,Note",
          ...Array.from(
            { length: 1002 },
            (_, i) => `F${i + 1},${[1, 5].includes(i) ? "Closed" : "Open"},${i === 2 ? 3 : 5},note`,
          ),
        ].join("\n"),
      ),
      "Data.csv",
    ).snapshot;
    const sid = snapshot.sheetOrder[0]!;
    snapshot.sheets[sid]!.rowData = {
      5: { hd: 1 },
      7: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
      600: { hd: 1 },
    };
    snapshot.resources = [
      {
        name: "SHEET_FILTER_PLUGIN",
        data: JSON.stringify({
          [sid]: {
            ref: { startRow: 0, endRow: 7, startColumn: 0, endColumn: 3 },
            filterColumns: [
              { colId: 1, filters: { filters: ["Open"] } },
              {
                colId: 2,
                customFilters: { customFilters: [{ operator: "greaterThanOrEqual", val: 5 }] },
              },
            ],
            cachedFilteredOut: [2, 3, 6],
          },
        }),
      },
    ];
    const bytes = minimalXlsx(snapshot);
    const path = join(dir, "book.xlsx");
    writeFileSync(path, bytes);
    const ctx: ToolContext = {
      workspaceId: "w",
      workspaceRoot: dir,
      agentId: "main",
      sessionId: "s",
      toolCallId: "visibility-read",
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
    const result = await read.execute(
      {
        path: "book.xlsx",
        mode: "range",
        range: "A1:D1003",
        facets: ["layout"],
      },
      ctx,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.data).toMatchObject({
      truncated: true,
      nextOffset: 500,
      readWindow: { returnedRows: 500 },
      layout: {
        rows: { 5: { hd: 1 }, 7: { hd: 1, custom: { excelmanusOutlineLevel: 1 } } },
        filter: { cachedFilteredOut: [2, 3, 6] },
        rowVisibility: {
          rowNumberBase: 1,
          rowStateHiddenRows: [6, 8],
          filteredOutRows: [3, 4, 7],
          effectiveHiddenRows: [3, 4, 6, 7, 8],
          visibleRows: Array.from({ length: 500 }, (_, i) => i + 1).filter(
            (row) => ![3, 4, 6, 7, 8].includes(row),
          ),
        },
      },
    });
    const later = await read.execute(
      {
        path: "book.xlsx",
        mode: "range",
        range: "A1:D1003",
        offset: 500,
        facets: ["layout"],
      },
      ctx,
    );
    expect(later.status, JSON.stringify(later.error)).toBe("ok");
    expect(later.data).toMatchObject({
      truncated: true,
      nextOffset: 1000,
      readWindow: { returnedRows: 500 },
      layout: {
        rowVisibility: {
          rowNumberBase: 1,
          rowStateHiddenRows: [601],
          filteredOutRows: [],
          effectiveHiddenRows: [601],
          visibleRows: Array.from({ length: 500 }, (_, i) => i + 501).filter((row) => row !== 601),
        },
      },
    });
    const partial = await read.execute(
      {
        path: "book.xlsx",
        mode: "range",
        range: "A4:D8",
        offset: 1,
        facets: ["values", "layout"],
      },
      ctx,
    );
    expect(partial.status, JSON.stringify(partial.error)).toBe("ok");
    expect(partial.data).toMatchObject({
      readWindow: { returnedRows: 4 },
      layout: {
        rowVisibility: {
          rowNumberBase: 1,
          rowStateHiddenRows: [6, 8],
          filteredOutRows: [7],
          effectiveHiddenRows: [6, 7, 8],
          visibleRows: [5],
        },
      },
    });
    const empty = await read.execute(
      {
        path: "book.xlsx",
        mode: "range",
        range: "A1:D8",
        offset: 8,
        facets: ["layout"],
      },
      ctx,
    );
    expect(empty.status, JSON.stringify(empty.error)).toBe("ok");
    expect(empty.data).toMatchObject({
      readWindow: { returnedRows: 0, returnedRange: null },
      layout: {
        rowVisibility: {
          rowNumberBase: 1,
          rowStateHiddenRows: [],
          filteredOutRows: [],
          effectiveHiddenRows: [],
          visibleRows: [],
        },
      },
    });
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
    const opened = await svc.open("w", dir, "book.xlsx");
    expect((await svc.snapshot(opened.meta.id, dir)).meta.rev).toBe(0);
    expect(await svc.sourceStatus(opened.meta.id, dir)).toMatchObject({
      changedSinceOpen: false,
      pendingWrite: false,
    });
  } finally {
    await svc.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
