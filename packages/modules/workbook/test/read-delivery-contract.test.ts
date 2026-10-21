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
import type { IWorkbookData } from "@univerjs/core";
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

const fixture = (name: string) =>
  Buffer.from(
    readFileSync(new URL(`./fixtures/${name}.base64`, import.meta.url), "utf8"),
    "base64",
  );

function setup(bytes: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "read-delivery-contract-"));
  const path = join(dir, "book.xlsx");
  writeFileSync(path, bytes);
  const db = openDb(join(dir, "test.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    sessionId: "s",
    agentId: "main",
    toolCallId: "read-delivery-contract",
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
  const read = workbookTools(service).find((tool) => tool.name === "workbook_read")!;
  return {
    path,
    ctx,
    read,
    async close() {
      await service.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sheetBytes(csv: string, configure: (snapshot: IWorkbookData) => void) {
  const { snapshot } = importCsv(new TextEncoder().encode(csv), "Metrics.csv");
  configure(snapshot);
  return Buffer.from(minimalXlsx(snapshot));
}

test("range receipt preserves the requested rectangle separately from sheet clipping", async () => {
  const bytes = fixture("book1.xlsx");
  const f = setup(bytes);
  try {
    const result = await f.read.execute(
      { path: "book.xlsx", mode: "range", sheet: "Sheet1", range: "A1:B2" },
      f.ctx,
    );
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(result.data).toMatchObject({
      range: "Sheet1!A1",
      readWindow: {
        requestedRange: "Sheet1!A1:B2",
        effectiveRange: "Sheet1!A1",
        clipped: true,
        returnedRange: "Sheet1!A1",
        offset: 0,
        returnedRows: 1,
        totalRows: 1,
        complete: true,
      },
    });
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally {
    await f.close();
  }
});

test("values include same-snapshot display strings without requesting full styles", async () => {
  const bytes = sheetBytes("指标,数值,未知,比例\n金额（万元）,1.239632,7,0.125\n", (snapshot) => {
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;
    sheet.cellData![1]![1]!.s = { n: { pattern: "0.00" } };
    sheet.cellData![1]![2]!.s = { n: { pattern: "[broken" } };
    sheet.cellData![1]![3]!.s = { n: { pattern: "0.0%" } };
  });
  const f = setup(bytes);
  try {
    const result = await f.read.execute(
      { path: "book.xlsx", mode: "range", range: "A2:D2", facets: ["values"] },
      f.ctx,
    );
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(result.data).toMatchObject({
      values: [["金额（万元）", 1.239632, 7, 0.125]],
      displayValues: [["金额（万元）", "1.24", null, "12.5%"]],
      displayBasis: "same_snapshot_number_format",
      coverage: { styles: "not_requested" },
    });
    expect(result.data).not.toHaveProperty("styles");
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally {
    await f.close();
  }
});

test("display text consumes the range budget and stays aligned through pagination", async () => {
  const bytes = sheetBytes(Array.from({ length: 800 }, () => "1.239632").join("\n"), (snapshot) => {
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;
    for (const row of Object.values(sheet.cellData!))
      row[0]!.s = { n: { pattern: `"${"x".repeat(80)}"0.00` } };
  });
  const f = setup(bytes);
  try {
    const args = { path: "book.xlsx", mode: "range", range: "A1:A800", facets: ["values"] };
    const result = await f.read.execute(args, f.ctx);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    const first = result.data as {
      values: number[][];
      displayValues: string[][];
      nextOffset: number;
      truncated: boolean;
      readWindow: Record<string, unknown>;
    };
    expect(first.truncated).toBe(true);
    expect(first.values.length).toBeLessThan(800);
    expect(first.displayValues).toEqual(first.values.map(() => [`${"x".repeat(80)}1.24`]));
    expect(first.nextOffset).toBe(first.values.length);
    expect(first.readWindow).toMatchObject({
      requestedRange: "Sheet1!A1:A800",
      effectiveRange: "Sheet1!A1:A800",
      clipped: false,
      returnedRows: first.values.length,
      complete: false,
    });
    const tail = await f.read.execute({ ...args, offset: 799 }, f.ctx);
    expect(tail.data).toMatchObject({
      values: [[1.239632]],
      displayValues: [[`${"x".repeat(80)}1.24`]],
      readWindow: {
        requestedRange: "Sheet1!A1:A800",
        effectiveRange: "Sheet1!A1:A800",
        clipped: false,
        returnedRange: "Sheet1!A800",
        offset: 799,
        returnedRows: 1,
        complete: true,
      },
    });
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally {
    await f.close();
  }
});

test("overview carries the same current external-link checkpoint facts as objects", async () => {
  const bytes = fixture("external-links.xlsx");
  const f = setup(bytes);
  try {
    const overview = await f.read.execute({ path: "book.xlsx", mode: "overview" }, f.ctx);
    const objects = await f.read.execute({ path: "book.xlsx", mode: "objects" }, f.ctx);
    expect(overview.status, JSON.stringify(overview)).toBe("ok");
    expect(objects.status, JSON.stringify(objects)).toBe("ok");
    expect(overview.data).toMatchObject({
      checkpointExternalLinks: {
        source: "preserved_package",
        checkpointRev: 0,
        currentRev: 0,
        isCurrent: true,
        packageState: "confirmed_checkpoint",
      },
    });
    const data = overview.data as Record<string, unknown>;
    const objectData = objects.data as Record<string, unknown>;
    expect(data.checkpointExternalLinks).toEqual(objectData.checkpointExternalLinks);
    expect(data.preserved).toEqual(objectData.preserved);
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally {
    await f.close();
  }
});
