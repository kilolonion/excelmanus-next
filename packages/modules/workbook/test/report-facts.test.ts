import { createHash } from "node:crypto";
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
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
import { pivotMetadata } from "../src/pivot-codec.ts";
import * as reportFacts from "../src/report-facts.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";

const original = Buffer.from(
  readFileSync(new URL("./fixtures/pivot-slicer.xlsx.base64", import.meta.url), "utf8"),
  "base64",
);
const pivotPart = "xl/pivotTables/pivotTable1.xml";
const sheetPart = "xl/worksheets/sheet1.xml";
const parts = () => unzipSync(original);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function setup(bytes: Uint8Array = original) {
  const dir = mkdtempSync(join(tmpdir(), "report-facts-"));
  const db = openDb(join(dir, "test.sqlite"), [
    ...KERNEL_MIGRATIONS,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  db.prepare(
    "INSERT INTO workspaces (id,name,path,is_default,sort,created_at) VALUES ('w','w',?,1,0,'2026-10-20T00:00:00.000Z')",
  ).run(dir);
  writeFileSync(join(dir, "report.xlsx"), bytes);
  const svc = new DocumentService(db);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    agentId: "main",
    sessionId: "s",
    toolCallId: "report-test",
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
  return {
    dir,
    db,
    svc,
    ctx,
    read: workbookTools(svc).find((t) => t.name === "workbook_read")!,
    analyze: workbookTools(svc).find((t) => t.name === "workbook_analyze")!,
    async close() {
      await svc.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("saved total follows actual grand-item indices and location, not a fixed name or bottom-right cell", () => {
  const p = parts();
  expect(pivotMetadata(p).pivotTables[0]).toMatchObject({
    savedDisplayTotal: {
      status: "supported",
      cell: "L20",
      value: 13,
      label: "保存透视显示总计",
      dataField: { name: "Sum of Color", field: 4, subtotal: "sum" },
      rowGrandIndex: 4,
      columnGrandIndex: 4,
    },
  });
  // Move the total-bearing layout, rename it and put the grand item first rather than last.
  p[pivotPart] = strToU8(
    strFromU8(p[pivotPart]!)
      .replace('name="PivotTable1"', 'name="MovedSummary"')
      .replace('ref="G14:L20"', 'ref="C30:H36"')
      .replaceAll(
        '<i><x/></i><i><x v="1"/></i><i><x v="2"/></i><i><x v="3"/></i><i t="grand"><x/></i>',
        '<i t="grand"><x/></i><i><x/></i><i><x v="1"/></i><i><x v="2"/></i><i><x v="3"/></i>',
      ),
  );
  p[sheetPart] = strToU8(
    strFromU8(p[sheetPart]!).replace(
      "</sheetData>",
      '<row r="32"><c r="D32"><v>47</v></c></row><row r="36"><c r="H36"><v>999</v></c></row></sheetData>',
    ),
  );
  expect(pivotMetadata(p).pivotTables[0]).toMatchObject({
    name: "MovedSummary",
    range: "C30:H36",
    savedDisplayTotal: {
      status: "supported",
      cell: "D32",
      value: 47,
      rowGrandIndex: 0,
      columnGrandIndex: 0,
    },
  });
});

test.each([
  ["no grand markers", (s: string) => s.replaceAll('t="grand"', 't="data"')],
  [
    "grand totals disabled",
    (s: string) => s.replace("<pivotTableDefinition ", '<pivotTableDefinition rowGrandTotals="0" '),
  ],
  [
    "multiple measures",
    (s: string) =>
      s.replace(
        '<dataFields count="1">',
        '<dataFields count="2"><dataField name="Other" fld="3"/>',
      ),
  ],
  [
    "nested row fields",
    (s: string) => s.replace('<rowFields count="1">', '<rowFields count="2"><field x="3"/>'),
  ],
  ["inconsistent location", (s: string) => s.replace('firstDataRow="2"', 'firstDataRow="3"')],
  [
    "derived measure",
    (s: string) => s.replace('baseField="0"', 'showDataAs="percentOfTotal" baseField="0"'),
  ],
  [
    "unknown row field",
    (s: string) =>
      s.replace('<rowFields count="1"><field x="1"', '<rowFields count="1"><field x="99"'),
  ],
])("ambiguous saved layout stays unsupported: %s", (_name, edit) => {
  const p = parts();
  p[pivotPart] = strToU8(edit(strFromU8(p[pivotPart]!)));
  const metadata = pivotMetadata(p).pivotTables[0] as unknown as {
    savedDisplayTotal: { status: string; reason?: string; value?: number; cell?: string };
  };
  expect(metadata.savedDisplayTotal).toMatchObject({
    status: "unsupported",
    reason: expect.any(String),
  });
  expect(metadata.savedDisplayTotal.value).toBeUndefined();
  expect(metadata.savedDisplayTotal.cell).toBeUndefined();
});

test("unbounded or missing worksheet source cannot certify a saved grand total", () => {
  const p = parts(),
    cachePart = "xl/pivotCache/pivotCacheDefinition1.xml";
  p[cachePart] = strToU8(strFromU8(p[cachePart]!).replace('ref="A1:E10"', 'ref="A:E"'));
  expect(pivotMetadata(p).pivotTables[0]).toMatchObject({
    savedDisplayTotal: { status: "unsupported" },
  });
});

test("objects report facts are source-bound, read-only, and distinguish saved display from cache aggregation", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, "report.xlsx");
    const before = await t.svc.snapshot(opened.meta.id, t.dir);
    const result = await t.read.execute({ path: "report.xlsx", mode: "objects" }, t.ctx);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.data).toMatchObject({
      docId: opened.meta.id,
      path: "report.xlsx",
      docRevs: { [opened.meta.id]: 0 },
      sourceFile: { currentSha256: sha(original) },
      reportFacts: {
        version: 1,
        sheets: [{ name: "Sheet1", id: before.snapshot.sheetOrder[0] }],
        pivots: [
          {
            linked: true,
            name: "PivotTable1",
            range: "G14:L20",
            source: { type: "worksheet", sheet: "Sheet1", ref: "A1:E10" },
            recordCount: "9",
            checkpoint: { rev: 0, currentRev: 0, isCurrent: true },
            refreshOnLoad: { raw: null, effective: false, defaulted: true },
            savedDisplayTotal: { status: "supported", cell: "L20", value: 13 },
            slicers: [{ name: "USA" }],
            refreshExecuted: false,
            cacheRecordsAggregated: false,
          },
        ],
        capabilities: { refresh: false, cacheRecordsAggregation: false, slicerInteraction: false },
      },
    });
    expect(readFileSync(join(t.dir, "report.xlsx"))).toEqual(original);
    expect((await t.svc.snapshot(opened.meta.id, t.dir)).meta.rev).toBe(before.meta.rev);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM doc_ops").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM backups").get()).toEqual({ n: 0 });
  } finally {
    await t.close();
  }
});

test("sort preflight reuses merge geometry, returns no execution, and does not change workbook or journal", async () => {
  const p = parts();
  p[sheetPart] = strToU8(
    strFromU8(p[sheetPart]!).replace(
      "</sheetData>",
      '</sheetData><mergeCells count="3"><mergeCell ref="B4:B5"/><mergeCell ref="D2:D3"/><mergeCell ref="G1:L1"/></mergeCells>',
    ),
  );
  const bytes = zipSync(p),
    t = setup(bytes);
  try {
    const opened = await t.svc.open("w", t.dir, "report.xlsx");
    const before = await t.svc.snapshot(opened.meta.id, t.dir);
    const blocked = await t.analyze.execute(
      { path: "report.xlsx", mode: "sort_preflight", sheet: "Sheet1", range: "A2:E4" },
      t.ctx,
    );
    expect(blocked.status, JSON.stringify(blocked.error)).toBe("ok");
    expect(blocked.data).toMatchObject({
      docId: opened.meta.id,
      path: "report.xlsx",
      docRevs: { [opened.meta.id]: 0 },
      sourceFile: { currentSha256: sha(bytes) },
      range: "Sheet1!A2:E4",
      sortPreflight: {
        sheet: "Sheet1",
        targetRange: "Sheet1!A2:E4",
        dataRange: "Sheet1!A2:E4",
        hasHeader: false,
        status: "blocked",
        execution: "not_executed",
        merges: [
          { range: "Sheet1!B4:B5", relation: "crosses_boundary", risk: "crosses_boundary" },
          { range: "Sheet1!D2:D3", relation: "inside_data", risk: "spans_data_rows" },
          { range: "Sheet1!G1:L1", relation: "outside_data", risk: "outside_data" },
        ],
        savedSheet: {
          scope: "worksheet_xml_and_nonworksheet_package_parts",
          status: "confirmed_checkpoint",
          sheet: "Sheet1",
          checkpointRev: 0,
          packageSha256: sha(bytes),
          worksheetPart: sheetPart,
          worksheetSha256: sha(p[sheetPart]!),
        },
      },
    });
    const safe = await t.analyze.execute(
      { path: "report.xlsx", mode: "sort_preflight", range: "G1:L6", hasHeader: true },
      t.ctx,
    );
    expect(safe.data).toMatchObject({
      sortPreflight: {
        status: "safe",
        execution: "not_executed",
        hasHeader: true,
        targetRange: "Sheet1!G1:L6",
        dataRange: "Sheet1!G2:L6",
      },
    });
    expect(readFileSync(join(t.dir, "report.xlsx"))).toEqual(Buffer.from(bytes));
    expect((await t.svc.snapshot(opened.meta.id, t.dir)).snapshot).toEqual(before.snapshot);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM doc_ops").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM backups").get()).toEqual({ n: 0 });
    expect(t.ctx.reads.get(opened.meta.id)?.ranges.length).toBeGreaterThan(0);
  } finally {
    await t.close();
  }
});

test("saved sheet fingerprint covers the whole worksheet and shared parts, excluding only other worksheet XML", () => {
  const savedSheetFingerprint = reportFacts.savedSheetFingerprint;
  expect(typeof savedSheetFingerprint).toBe("function");
  const p = {
    "xl/workbook.xml": strToU8(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Target" sheetId="3" r:id="r1"/><sheet name="Other" sheetId="9" r:id="r2"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": strToU8("whole sheet, including outside the sort range"),
    "xl/worksheets/sheet2.xml": strToU8("other sheet"),
    "xl/sharedStrings.xml": strToU8("shared strings"),
    "xl/styles.xml": strToU8("styles"),
    "xl/worksheets/_rels/sheet2.xml.rels": strToU8("relationships are not excluded"),
  };
  const before = savedSheetFingerprint(p, "Target");
  p["xl/worksheets/sheet2.xml"] = strToU8("sorted other sheet");
  expect(savedSheetFingerprint(p, "Target")).toEqual(before);
  p["xl/sharedStrings.xml"] = strToU8("changed text for the same index");
  expect(savedSheetFingerprint(p, "Target")?.supportingPartsSha256).not.toBe(
    before?.supportingPartsSha256,
  );
  expect(savedSheetFingerprint(p, "Target")?.worksheetSha256).toBe(before?.worksheetSha256);
  p["xl/worksheets/sheet1.xml"] = strToU8("outside-sort cell changed");
  expect(savedSheetFingerprint(p, "Target")?.worksheetSha256).not.toBe(before?.worksheetSha256);
  expect(savedSheetFingerprint(undefined, "Target")).toBeUndefined();
});

test("sort preservation fingerprint is unavailable while the live revision is not the saved checkpoint", async () => {
  const t = setup();
  try {
    const edit = workbookEditTool(t.svc);
    const result = await edit.execute(
      { path: "report.xlsx", ops: [{ op: "cells.set", range: "Sheet1!A30", values: [[7]] }] },
      t.ctx,
    );
    expect(result.status).toBe("ok");
    const resultData = result.data as { docId: string };
    const entry = await t.svc.entry(resultData.docId, t.dir);
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const before = await t.analyze.execute(
      { path: "report.xlsx", mode: "sort_preflight", range: "Sheet1!A1:B2" },
      t.ctx,
    );
    expect(before.data).toMatchObject({ sortPreflight: { savedSheet: { status: "unavailable" } } });
    await t.svc.checkpoint(resultData.docId, t.dir);
    const saved = readFileSync(join(t.dir, "report.xlsx"));
    const after = await t.analyze.execute(
      { path: "report.xlsx", mode: "sort_preflight", range: "Sheet1!A1:B2" },
      t.ctx,
    );
    expect(after.data).toMatchObject({
      sortPreflight: {
        savedSheet: {
          status: "confirmed_checkpoint",
          packageSha256: sha(saved),
          worksheetSha256: sha(unzipSync(saved)[sheetPart]!),
        },
      },
    });
  } finally {
    await t.close();
  }
});

test("public report follows renamed sheet and relocated single-measure grand total", async () => {
  const p = parts();
  for (const path of ["xl/workbook.xml", "xl/pivotCache/pivotCacheDefinition1.xml"])
    p[path] = strToU8(strFromU8(p[path]!).replaceAll('="Sheet1"', '="Renamed stats"'));
  p[pivotPart] = strToU8(strFromU8(p[pivotPart]!).replace('ref="G14:L20"', 'ref="C30:H36"'));
  p[sheetPart] = strToU8(
    strFromU8(p[sheetPart]!)
      .replace('ref="A1:L20"', 'ref="A1:L36"')
      .replace("</sheetData>", '<row r="36"><c r="H36"><v>47</v></c></row></sheetData>'),
  );
  const bytes = zipSync(p),
    t = setup(bytes);
  try {
    const result = await t.read.execute({ path: "report.xlsx", mode: "objects" }, t.ctx);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.data).toMatchObject({
      reportFacts: {
        sheets: [{ name: "Renamed stats" }],
        pivots: [
          {
            sheet: "Renamed stats",
            range: "C30:H36",
            source: { sheet: "Renamed stats" },
            checkpoint: { isCurrent: true },
            savedDisplayTotal: { status: "supported", cell: "H36", value: 47 },
          },
        ],
      },
    });
    const actual = await t.read.execute(
      { path: "report.xlsx", mode: "range", range: "'Renamed stats'!C30:H36", facets: ["values"] },
      t.ctx,
    );
    expect(actual.data).toMatchObject({
      values: [...Array.from({ length: 6 }, () => Array(6).fill("")), ["", "", "", "", "", 47]],
    });
    expect(sha(readFileSync(join(t.dir, "report.xlsx")))).toBe(sha(bytes));
  } finally {
    await t.close();
  }
});

test("report keeps saved and current revisions distinct after pending source edit", async () => {
  const t = setup();
  try {
    const initial = await t.read.execute({ path: "report.xlsx", mode: "objects" }, t.ctx);
    expect(initial.data).toMatchObject({
      reportFacts: { pivots: [{ checkpoint: { isCurrent: true } }] },
    });
    const edit = await workbookEditTool(t.svc).execute(
      { path: "report.xlsx", ops: [{ op: "cells.set", range: "Sheet1!E3", values: [[8]] }] },
      t.ctx,
    );
    expect(edit.status, JSON.stringify(edit.error)).toBe("ok");
    const current = await t.read.execute({ path: "report.xlsx", mode: "objects" }, t.ctx);
    expect(current.data).toMatchObject({
      reportFacts: {
        pivots: [
          {
            checkpoint: { rev: 0, currentRev: 1, isCurrent: false },
            savedDisplayTotal: { status: "unsupported", reason: expect.any(String) },
            refreshExecuted: false,
            cacheRecordsAggregated: false,
          },
        ],
      },
    });
    expect(current.data).not.toMatchObject({
      reportFacts: { pivots: [{ savedDisplayTotal: { value: 13 } }] },
    });
  } finally {
    await t.close();
  }
});

test("preflight invalid requests fail before any mutations or output creation", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, "report.xlsx");
    for (const args of [
      {},
      { docId: opened.meta.id, path: "contradictory.xlsx", range: "A2:E4" },
      { range: "A2:E4", saveTo: { path: "unexpected.xlsx", sheet: "Result" } },
      { sheet: "Missing", range: "Sheet1!A2:E4" },
    ]) {
      const result = await t.analyze.execute(
        { path: "report.xlsx", mode: "sort_preflight", ...args },
        t.ctx,
      );
      expect(result.status).toBe("error");
    }
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM doc_ops").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM backups").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, "report.xlsx"))).toEqual(original);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 1 });
  } finally {
    await t.close();
  }
});
