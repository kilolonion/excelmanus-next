import { readFileSync } from "node:fs";
import type { IWorkbookData } from "@univerjs/core";
import { unzipSync } from "fflate";
import { expect, test } from "vitest";
import {
  importPivotRefresh,
  pivotMetadata,
  planPivotRefreshPatches,
  resolvePivotRefreshTarget,
} from "../src/pivot-codec.ts";
import { bytesOf, textOf } from "../src/xml.ts";

const cachePart = "xl/pivotCache/pivotCacheDefinition1.xml";
const fixture = (): Record<string, Uint8Array> =>
  unzipSync(
    Buffer.from(
      readFileSync(new URL("./fixtures/pivot-slicer.xlsx.base64", import.meta.url), "utf8"),
      "base64",
    ),
  );
const mapping = { s0: { path: "xl/worksheets/sheet1.xml" } };
const snapshot = () =>
  ({
    id: "test",
    sheetOrder: ["s0"],
    sheets: {
      s0: {
        id: "s0",
        name: "Sheet1",
        rowCount: 100,
        columnCount: 26,
        custom: {
          keep: "yes",
          excelmanusObjects: {
            charts: [],
            images: [],
            notes: [{ ref: "A1", text: "keep", author: "" }],
          },
        },
      },
    },
  }) as unknown as IWorkbookData;
const flags = (s: IWorkbookData, id = "s0") =>
  (
    s.sheets[id]!.custom!.excelmanusObjects as {
      pivotRefreshOnLoad: Record<string, null | "0" | "1" | "false" | "true">;
    }
  ).pivotRefreshOnLoad;
function imported(parts = fixture()) {
  const before = snapshot();
  importPivotRefresh(parts, mapping, before.sheets);
  return { parts, before, next: structuredClone(before) };
}

test("actual pivot and slicer graph maps x14 cache 1 to workbook cache 0 and reports omitted defaults", () => {
  const parts = fixture(),
    meta = pivotMetadata(parts);
  expect(meta).toMatchObject({
    pivotTableCount: 1,
    cacheCount: 1,
    slicerCacheCount: 1,
    slicerCount: 1,
  });
  expect(meta.pivotCaches[0]).toMatchObject({
    cacheId: "0",
    part: cachePart,
    source: { type: "worksheet", sheet: "Sheet1", ref: "A1:E10" },
    refreshOnLoad: { raw: null, effective: false, defaulted: true },
    enableRefresh: { raw: null, effective: true, defaulted: true },
    editable: true,
    pivots: ["xl/pivotTables/pivotTable1.xml"],
    recordsPart: "xl/pivotCache/pivotCacheRecords1.xml",
    recordCount: "9",
  });
  expect(meta.pivotTables[0]).toMatchObject({
    name: "PivotTable1",
    cacheId: "0",
    cachePart,
    sheet: "Sheet1",
    range: "G14:L20",
    linked: true,
  });
  expect(meta.slicerCaches[0]).toMatchObject({
    name: "Slicer_USA",
    pivotCacheId: "1",
    cacheId: "0",
    linked: true,
  });
  expect(meta.slicers[0]).toMatchObject({ name: "USA", cacheName: "Slicer_USA", linked: true });
  const before = snapshot();
  importPivotRefresh(parts, mapping, before.sheets);
  expect(flags(before)).toEqual({ "0": null });
  expect(before.sheets.s0!.custom).toMatchObject({
    keep: "yes",
    excelmanusObjects: { notes: [{ text: "keep" }] },
  });
  expect(resolvePivotRefreshTarget(parts, mapping, before, "s0", "0").part).toBe(cachePart);
});

test("refresh plan is pure, adds only the root attribute, and supports exact omitted-attribute undo", () => {
  const { parts, before, next } = imported(),
    original = textOf(parts[cachePart]!);
  flags(next)["0"] = "1";
  const changes = planPivotRefreshPatches(parts, mapping, next, before);
  expect(changes).toHaveLength(1);
  expect(changes[0]!.part).toBe(cachePart);
  expect(textOf(changes[0]!.bytes)).toBe(
    original.replace(
      'xr:uid="{E06415C1-90E2-4BCC-9FB5-A17DFBF8349B}">',
      'xr:uid="{E06415C1-90E2-4BCC-9FB5-A17DFBF8349B}" refreshOnLoad="1">',
    ),
  );
  expect(textOf(parts[cachePart]!)).toBe(original);
  expect(planPivotRefreshPatches(parts, mapping, before, before)).toEqual([]);
  const updated = { ...parts, [cachePart]: changes[0]!.bytes };
  const undo = planPivotRefreshPatches(updated, mapping, before, next);
  expect(textOf(undo[0]!.bytes)).toBe(original);
});

test("prefixed root patch preserves quote style, whitespace, unknown attributes and nested lookalikes", () => {
  const parts = fixture();
  const original = textOf(parts[cachePart]!)
    .replace(
      "<pivotCacheDefinition ",
      '<m:pivotCacheDefinition xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:v="urn:vendor" refreshOnLoad = \'false\' v:refreshOnLoad="keep" ',
    )
    .replace(
      "</pivotCacheDefinition>",
      '<v:pivotCacheDefinition refreshOnLoad="0"/></m:pivotCacheDefinition>',
    );
  parts[cachePart] = bytesOf(original);
  const { before, next } = imported(parts);
  expect(flags(before)["0"]).toBe("false");
  flags(next)["0"] = "true";
  const changes = planPivotRefreshPatches(parts, mapping, next, before);
  expect(textOf(changes[0]!.bytes)).toBe(
    original.replace("refreshOnLoad = 'false'", "refreshOnLoad = 'true'"),
  );
});

test("attribute-like text inside a vendor attribute cannot redirect the root edit", () => {
  const parts = fixture();
  const original = textOf(parts[cachePart]!).replace(
    "<pivotCacheDefinition ",
    '<pivotCacheDefinition xmlns:v="urn:vendor" v:example=" refreshOnLoad=\'false\' " ',
  );
  parts[cachePart] = bytesOf(original);
  const { before, next } = imported(parts);
  flags(next)["0"] = "1";
  const changes = planPivotRefreshPatches(parts, mapping, next, before);
  expect(textOf(changes[0]!.bytes)).toBe(
    original.replace(
      'xr:uid="{E06415C1-90E2-4BCC-9FB5-A17DFBF8349B}">',
      'xr:uid="{E06415C1-90E2-4BCC-9FB5-A17DFBF8349B}" refreshOnLoad="1">',
    ),
  );
});

test("duplicate relationship IDs cannot provide unique pivot cache evidence", () => {
  const parts = fixture(),
    rel = "xl/pivotTables/_rels/pivotTable1.xml.rels";
  parts[rel] = bytesOf(
    textOf(parts[rel]!).replace(
      "</Relationships>",
      '<Relationship Id="rId1" Type="urn:vendor" Target="../styles.xml"/></Relationships>',
    ),
  );
  expect(pivotMetadata(parts).pivotCaches[0]!.editable).toBe(false);
});

test("records metadata follows only the root relationship, not a filename guess", () => {
  const parts = fixture(),
    rel = "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels";
  parts[rel] = bytesOf(textOf(parts[rel]!).replace('Id="rId1"', 'Id="other"'));
  const cache = pivotMetadata(parts).pivotCaches[0]!;
  expect(cache.recordsPart).toBeUndefined();
  expect(cache.recordsReason).toBeTruthy();
  expect(cache.recordCount).toBe("9");
});

test.each([
  "missing worksheet reference",
  "foreign slicer root",
  "foreign slicer cache root",
] as const)("a related slicer with %s remains visible and blocks its cache refresh", (damage) => {
  const parts = fixture();
  if (damage === "missing worksheet reference") {
    const path = "xl/worksheets/sheet1.xml";
    parts[path] = bytesOf(
      textOf(parts[path]!).replace(/<x14:slicerList>[\s\S]*?<\/x14:slicerList>/, ""),
    );
  } else {
    const path =
      damage === "foreign slicer root"
        ? "xl/slicers/slicer1.xml"
        : "xl/slicerCaches/slicerCache1.xml";
    parts[path] = bytesOf(
      textOf(parts[path]!).replace(
        'xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"',
        'xmlns="urn:foreign"',
      ),
    );
  }
  const meta = pivotMetadata(parts);
  expect(meta.slicers).toHaveLength(1);
  expect(meta.slicers[0]!.linked).toBe(false);
  if (damage === "foreign slicer root") {
    expect(meta.slicerCount).toBe(0);
    expect(meta.unknownSlicerPartCount).toBe(1);
  }
  expect(meta.pivotCaches[0]!.editable).toBe(false);
  expect(() => resolvePivotRefreshTarget(parts, mapping, snapshot(), "s0", "0")).toThrow();
});

test("shared cache metadata lists every dependent pivot without copying caches or slicers", () => {
  const parts = fixture();
  parts["xl/pivotTables/pivotTable2.xml"] = bytesOf(
    textOf(parts["xl/pivotTables/pivotTable1.xml"]!).replace(
      'name="PivotTable1"',
      'name="PivotTable2"',
    ),
  );
  parts["xl/pivotTables/_rels/pivotTable2.xml.rels"] =
    parts["xl/pivotTables/_rels/pivotTable1.xml.rels"]!;
  const rel = "xl/worksheets/_rels/sheet1.xml.rels";
  parts[rel] = bytesOf(
    textOf(parts[rel]!).replace(
      "</Relationships>",
      '<Relationship Id="pivot2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable2.xml"/></Relationships>',
    ),
  );
  const meta = pivotMetadata(parts);
  expect(meta.pivotTableCount).toBe(2);
  expect(meta.cacheCount).toBe(1);
  expect(meta.pivotCaches[0]!.pivots).toHaveLength(2);
  const { before, next } = imported(parts);
  flags(next)["0"] = "1";
  expect(planPivotRefreshPatches(parts, mapping, next, before)).toHaveLength(1);
});

test.each([
  ["external", (s: string) => s.replace('type="worksheet"', 'type="external" connectionId="1"')],
  ["named", (s: string) => s.replace('ref="A1:E10"', 'name="SourceTable"')],
  ["invalid reference", (s: string) => s.replace('ref="A1:E10"', 'ref="A:A"')],
  [
    "external worksheet relationship",
    (s: string) => s.replace("<worksheetSource ", '<worksheetSource r:id="outside" '),
  ],
  [
    "disabled refresh",
    (s: string) =>
      s.replace("<pivotCacheDefinition ", '<pivotCacheDefinition enableRefresh="false" '),
  ],
  [
    "unknown boolean",
    (s: string) =>
      s.replace("<pivotCacheDefinition ", '<pivotCacheDefinition refreshOnLoad="maybe" '),
  ],
  [
    "wrong root namespace",
    (s: string) =>
      s.replace(
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        'xmlns="urn:foreign"',
      ),
  ],
] as const)("unsupported %s cache is readable but cannot be targeted", (_name, modify) => {
  const parts = fixture();
  parts[cachePart] = bytesOf(modify(textOf(parts[cachePart]!)));
  const meta = pivotMetadata(parts);
  expect(meta.pivotCaches[0]!.editable).toBe(false);
  if (_name === "unknown boolean")
    expect(meta.pivotCaches[0]!.refreshOnLoad).toEqual({
      raw: "maybe",
      effective: null,
      defaulted: false,
    });
  const next = snapshot();
  importPivotRefresh(parts, mapping, next.sheets);
  expect(() => resolvePivotRefreshTarget(parts, mapping, next, "s0", "0")).toThrow();
});

test("namespace/relationship evidence and x14 cache-id mapping cannot be replaced with equal-looking IDs", () => {
  const parts = fixture();
  parts[cachePart] = bytesOf(
    textOf(parts[cachePart]!).replace('pivotCacheId="1"', 'pivotCacheId="0"'),
  );
  expect(pivotMetadata(parts).slicerCaches[0]).toMatchObject({ linked: false });
  const rel = "xl/pivotTables/_rels/pivotTable1.xml.rels";
  parts[rel] = bytesOf(
    textOf(parts[rel]!).replace(
      'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"',
      'xmlns="urn:foreign"',
    ),
  );
  expect(pivotMetadata(parts).pivotCaches[0]!.editable).toBe(false);
});

test("unknown, moved, removed, renamed and multiply-mapped refresh flags fail before a plan is returned", () => {
  const { parts, before, next } = imported();
  flags(next)["0"] = "1";
  flags(next).unknown = "1";
  expect(() => planPivotRefreshPatches(parts, mapping, next, before)).toThrow();
  delete flags(next).unknown;
  delete flags(next)["0"];
  expect(() => planPivotRefreshPatches(parts, mapping, next, before)).toThrow();
  flags(next)["0"] = "1";
  next.sheets.s0!.name = "Renamed";
  expect(() => planPivotRefreshPatches(parts, mapping, next, before)).toThrow();
  next.sheets.s0!.name = "Sheet1";
  next.sheets.copy = { ...structuredClone(next.sheets.s0!), id: "copy" };
  next.sheetOrder.push("copy");
  expect(() => planPivotRefreshPatches(parts, mapping, next, before)).toThrow();
  expect(() =>
    resolvePivotRefreshTarget(parts, { ...mapping, copy: mapping.s0 }, next, "s0", "0"),
  ).toThrow();
});
