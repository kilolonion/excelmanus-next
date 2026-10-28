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
      worksheetRows: number[];
      displayValues: string[][];
      nextOffset: number;
      truncated: boolean;
      readWindow: Record<string, unknown>;
    };
    expect(first.truncated).toBe(true);
    expect(first.values.length).toBeLessThan(800);
    expect(first.displayValues).toEqual(first.values.map(() => [`${"x".repeat(80)}1.24`]));
    expect(first.nextOffset).toBe(first.values.length);
    expect(first.worksheetRows).toEqual(first.values.map((_, i) => i + 1));
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
      worksheetRows: [800],
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

test("worksheet row receipts retain real positions across clipping, pagination, blank and hidden rows", async () => {
  const bytes = sheetBytes("\n\n键,金额\nA,10\n,\nB,20\nC,30\n", (snapshot) => {
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;
    sheet.rowData = { 5: { hd: 1 } };
  });
  const f = setup(bytes);
  try {
    const range = await f.read.execute(
      { path: "book.xlsx", mode: "range", range: "A4:B20", offset: 1 },
      f.ctx,
    );
    expect(range.status, JSON.stringify(range)).toBe("ok");
    expect(range.data).toMatchObject({
      worksheetRows: [5, 6, 7],
      values: [
        ["", ""],
        ["B", 20],
        ["C", 30],
      ],
      readWindow: { clipped: true, returnedRange: "Sheet1!A5:B7", returnedRows: 3 },
    });
    const table = await f.read.execute(
      { path: "book.xlsx", mode: "table", range: "A3:B20", offset: 1 },
      f.ctx,
    );
    expect(table.data).toMatchObject({
      worksheetRows: [5, 6, 7],
      headerWorksheetRow: 3,
      rows: [
        { 键: null, 金额: null },
        { 键: "B", 金额: 20 },
        { 键: "C", 金额: 30 },
      ],
    });
    const empty = await f.read.execute(
      { path: "book.xlsx", mode: "range", range: "A4:B7", offset: 10 },
      f.ctx,
    );
    expect(empty.data).toMatchObject({
      worksheetRows: [],
      values: [],
      readWindow: { returnedRows: 0 },
    });
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally {
    await f.close();
  }
});

test("table pagination maps every returned object to its worksheet row after the header", async () => {
  const f = setup(
    sheetBytes(["key", ...Array.from({ length: 205 }, (_, i) => `K${i}`)].join("\n"), () => {}),
  );
  try {
    const args = { path: "book.xlsx", mode: "table", range: "A1:A206" };
    const first = await f.read.execute(args, f.ctx);
    expect(first.data).toMatchObject({
      headerWorksheetRow: 1,
      nextOffset: 200,
      worksheetRows: Array.from({ length: 200 }, (_, i) => i + 2),
    });
    const tail = await f.read.execute({ ...args, offset: 200 }, f.ctx);
    expect(tail.data).toMatchObject({
      worksheetRows: [202, 203, 204, 205, 206],
      rows: [200, 201, 202, 203, 204].map((i) => ({ key: `K${i}` })),
    });
    const empty = await f.read.execute({ ...args, offset: 205 }, f.ctx);
    expect(empty.data).toMatchObject({ worksheetRows: [], rows: [] });
  } finally {
    await f.close();
  }
});

test("worksheet row receipts share the range character budget without splitting or stalling a row", async () => {
  const f = setup(sheetBytes(Array.from({ length: 2200 }, () => "1").join("\n"), () => {}));
  try {
    const args = { path: "book.xlsx", mode: "range", range: "A1:A2200" };
    const first = (await f.read.execute(args, f.ctx)).data as {
      values: number[][];
      worksheetRows: number[];
      nextOffset: number;
    };
    expect(first.values.length).toBeGreaterThan(0);
    expect(first.values.length).toBeLessThan(2000);
    expect(first.worksheetRows).toEqual(first.values.map((_, i) => i + 1));
    expect(first.nextOffset).toBe(first.values.length);
    // Each value contributes its raw character and JSON display text (\"1\").
    const charged = first.values.length * 4 + JSON.stringify(first.worksheetRows).length;
    expect(charged).toBeGreaterThanOrEqual(16000);
    expect(charged).toBeLessThan(16010);
    const tail = (await f.read.execute({ ...args, offset: first.nextOffset }, f.ctx)).data as {
      values: number[][];
      worksheetRows: number[];
    };
    expect(tail.worksheetRows).toEqual(tail.values.map((_, i) => first.nextOffset + i + 1));
    expect(first.values.length + tail.values.length).toBe(2200);
  } finally {
    await f.close();
  }
});

test("a single oversized range row still returns with its worksheet row and advances the cursor", async () => {
  const f = setup(sheetBytes(`${"x".repeat(20000)}\ntail\n`, () => {}));
  try {
    const args = { path: "book.xlsx", mode: "range", range: "A1:A2" };
    const first = await f.read.execute(args, f.ctx);
    expect(first.data).toMatchObject({ worksheetRows: [1], nextOffset: 1, truncated: true });
    const tail = await f.read.execute({ ...args, offset: 1 }, f.ctx);
    expect(tail.data).toMatchObject({ worksheetRows: [2], values: [["tail"]], truncated: false });
  } finally {
    await f.close();
  }
});

test("merge geometry names exact cells without filling ordinary blanks or adjacent identity cells", async () => {
  const f = setup(
    sheetBytes("地区,客户\n\n\n\n东区,001\n,\n西区,1\n,002\n,\n尾行,3", (s) => {
      const sheet = s.sheets[s.sheetOrder[0]!]!;
      sheet.mergeData = [{ startRow: 6, endRow: 7, startColumn: 0, endColumn: 0 }];
      sheet.cellData![6]![1] = { v: "1", t: 1 };
      sheet.cellData![7]![1] = { v: "002", t: 1 };
    }),
  );
  const before = readFileSync(f.path);
  try {
    const result = await f.read.execute(
      { path: "book.xlsx", mode: "range", range: "A7:B9", facets: ["values", "layout"] },
      f.ctx,
    );
    const d = result.data as any;
    expect(d.values).toEqual([
      ["西区", "1"],
      ["", "002"],
      ["", ""],
    ]);
    expect(d.blankCells).toEqual(["A8", "A9", "B9"]);
    expect(d.layout.mergesScope).toBe("effective_range_intersections");
    expect(d.layout.merges).toEqual([
      {
        startRow: 6,
        endRow: 7,
        startColumn: 0,
        endColumn: 0,
        range: "A7:A8",
        anchor: "A7",
        intersectsReturnedWindow: true,
        anchorInReturnedWindow: true,
      },
    ]);
    expect(d.layout.merges[0]).not.toHaveProperty("anchorValue");
    expect(readFileSync(f.path)).toEqual(before);
  } finally {
    await f.close();
  }
});

test("cropped merge geometry does not imply an anchor value was read or B7 was merged", async () => {
  const f = setup(
    sheetBytes("部门,ID\n\n\n\n研发,001\n,\n,1\n,", (s) => {
      s.sheets[s.sheetOrder[0]!]!.cellData![6]![1] = { v: "1", t: 1 };
      s.sheets[s.sheetOrder[0]!]!.mergeData = [
        { startRow: 4, endRow: 6, startColumn: 0, endColumn: 0 },
        { startRow: 4, endRow: 5, startColumn: 1, endColumn: 1 },
      ];
    }),
  );
  try {
    const result = await f.read.execute(
      { path: "book.xlsx", mode: "range", range: "A7:B7", facets: ["values", "layout"] },
      f.ctx,
    );
    expect(result.data).toMatchObject({
      values: [["", "1"]],
      blankCells: ["A7"],
      layout: {
        merges: [
          {
            range: "A5:A7",
            anchor: "A5",
            intersectsReturnedWindow: true,
            anchorInReturnedWindow: false,
          },
        ],
      },
      readWindow: { returnedRange: "Sheet1!A7:B7" },
    });
    expect((result.data as any).layout.merges).toHaveLength(1);
    const reads = f.ctx.reads.get((result.data as any).docId);
    expect(JSON.stringify(reads)).not.toContain('"r0":4');
  } finally {
    await f.close();
  }
});

test("paged and empty reads mark merge geometry outside the returned window without changing read windows", async () => {
  const f = setup(
    sheetBytes("a,b\n1,\n2,\n3,\n4,", (s) => {
      s.sheets[s.sheetOrder[0]!]!.mergeData = [
        { startRow: 1, endRow: 2, startColumn: 1, endColumn: 1 },
      ];
    }),
  );
  try {
    const args = {
      path: "book.xlsx",
      mode: "range",
      range: "A1:B99",
      facets: ["values", "layout"],
    };
    const page = await f.read.execute({ ...args, offset: 4 }, f.ctx);
    expect(page.data).toMatchObject({
      values: [[4, ""]],
      readWindow: { clipped: true, returnedRange: "Sheet1!A5:B5", returnedRows: 1 },
      layout: {
        merges: [
          {
            range: "B2:B3",
            anchor: "B2",
            intersectsReturnedWindow: false,
            anchorInReturnedWindow: false,
          },
        ],
      },
    });
    const empty = await f.read.execute({ ...args, offset: 10 }, f.ctx);
    expect(empty.data).toMatchObject({
      values: [],
      worksheetRows: [],
      readWindow: { returnedRows: 0, returnedRange: null },
      layout: {
        merges: [
          { range: "B2:B3", intersectsReturnedWindow: false, anchorInReturnedWindow: false },
        ],
      },
    });
  } finally {
    await f.close();
  }
});
