import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { unzipSync, zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import {
  assertLegacyWorkbookWriteSupported,
  readWorkbookManifest,
} from "../src/workbook-manifest.ts";
import { importXlsx } from "../src/xlsx.ts";
import { bytesOf, textOf } from "../src/xml.ts";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const original = Buffer.from(
  readFileSync(new URL("./fixtures/book1.xlsx.base64", import.meta.url), "utf8"),
  "base64",
);
function fixture(transform: (xml: string) => string) {
  const parts: Record<string, Uint8Array> = unzipSync(original);
  parts["xl/workbook.xml"] = bytesOf(transform(textOf(parts["xl/workbook.xml"]!)));
  return zipSync(parts);
}
const defaultNames = (xml: string) => xml.replaceAll("x:", "").replace("xmlns:x=", "xmlns=");

test("legacy writer eligibility is per actual target QName, not only the workbook root", () => {
  const xml = defaultNames(textOf(unzipSync(original)["xl/workbook.xml"]!));
  expect(readWorkbookManifest(xml).legacyWriter).toEqual({ sheets: true, calcPr: true });
  const variants = [
    { xml: textOf(unzipSync(original)["xl/workbook.xml"]!), sheets: false, calcPr: false },
    {
      xml: xml
        .replace("<sheets>", `<m:sheets xmlns:m="${MAIN}">`)
        .replace("</sheets>", "</m:sheets>"),
      sheets: false,
      calcPr: true,
    },
    { xml: xml.replace("<sheet ", `<m:sheet xmlns:m="${MAIN}" `), sheets: false, calcPr: true },
    {
      xml: xml.replace("r:id", "link:id").replace("xmlns:r", "xmlns:link"),
      sheets: false,
      calcPr: true,
    },
    {
      xml: xml.replace("</workbook>", `<m:calcPr xmlns:m="${MAIN}"/></workbook>`),
      sheets: true,
      calcPr: false,
    },
    {
      xml: xml.replace("</workbook>", '<calcPr xmlns="urn:foreign"/></workbook>'),
      sheets: true,
      calcPr: false,
    },
    {
      xml: xml.replace("</workbook>", `<m:extLst xmlns:m="${MAIN}"/></workbook>`),
      sheets: true,
      calcPr: false,
    },
  ];
  for (const variant of variants) {
    expect(readWorkbookManifest(variant.xml).legacyWriter).toEqual({
      sheets: variant.sheets,
      calcPr: variant.calcPr,
    });
    expect(() => assertLegacyWorkbookWriteSupported(variant.xml, {})).not.toThrow();
    for (const field of ["sheets", "calcPr"] as const) {
      if (variant[field])
        expect(() =>
          assertLegacyWorkbookWriteSupported(variant.xml, { [field]: true }),
        ).not.toThrow();
      else
        expect(() => assertLegacyWorkbookWriteSupported(variant.xml, { [field]: true })).toThrow(
          expect.objectContaining({ code: "UNSUPPORTED_FEATURE" }),
        );
    }
  }
});

test.each([
  ["actual fully prefixed companion", (xml: string) => xml],
  [
    "prefix aliases and relationship attribute alias",
    (xml: string) =>
      xml
        .replaceAll("x:", "main:")
        .replaceAll("xmlns:x=", "xmlns:main=")
        .replaceAll("r:id", "link:id")
        .replaceAll("xmlns:r=", "xmlns:link="),
  ],
  [
    "default root and prefixed sheets",
    (xml: string) =>
      xml
        .replace("<x:workbook", `<workbook xmlns="${MAIN}"`)
        .replace("</x:workbook>", "</workbook>"),
  ],
  [
    "default root/sheets with prefixed sheet",
    (xml: string) => defaultNames(xml).replace("<sheet ", `<m:sheet xmlns:m="${MAIN}" `),
  ],
] as const)("QName manifest imports %s without altering package bytes", (_name, transform) => {
  const bytes = fixture(transform);
  const imported = importXlsx(bytes, "book1.xlsx");
  const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!;
  expect(sheet.name).toBe("Sheet1");
  expect(sheet.cellData?.[0]?.[0]?.v).toBe("hello world");
  expect(imported.preservation?.parts["xl/workbook.xml"]).toEqual(
    unzipSync(bytes)["xl/workbook.xml"],
  );
});

test.each([
  ["foreign root", (xml: string) => defaultNames(xml).replace(MAIN, "urn:foreign")],
  [
    "foreign unprefixed sheets",
    (xml: string) => defaultNames(xml).replace("<sheets>", '<sheets xmlns="urn:foreign">'),
  ],
  [
    "foreign unprefixed sheet",
    (xml: string) => defaultNames(xml).replace("<sheet ", '<sheet xmlns="urn:foreign" '),
  ],
  [
    "relationship attribute has foreign URI",
    (xml: string) => defaultNames(xml).replace(REL, "urn:foreign"),
  ],
  [
    "relationship attribute is unqualified",
    (xml: string) => defaultNames(xml).replace("r:id=", "id="),
  ],
  [
    "local prefix rebinding",
    (xml: string) => xml.replace("<x:sheet ", '<x:sheet xmlns:x="urn:foreign" '),
  ],
  ["DTD", (xml: string) => xml.replace("?><", '?><!DOCTYPE workbook [<!ENTITY x "bad">]><')],
] as const)(
  "foreign or unsupported workbook identities are not treated as sheets: %s",
  (_name, transform) => {
    expect(() => importXlsx(fixture(transform), "not-sheets.xlsx")).toThrow();
  },
);

test("foreign same-name children and nested extension sheets are ignored", () => {
  const bytes = fixture((xml) =>
    defaultNames(xml)
      .replace("</sheets>", '<f:sheet xmlns:f="urn:foreign" name="Fake" sheetId="2"/></sheets>')
      .replace(
        "</workbook>",
        `<extLst><ext uri="test"><sheets><sheet name="Nested" sheetId="3"/></sheets></ext></extLst></workbook>`,
      ),
  );
  const imported = importXlsx(bytes, "book1.xlsx");
  expect(imported.snapshot.sheetOrder).toHaveLength(1);
  expect(imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!.name).toBe("Sheet1");
});

test.each(["A1", "A2"])(
  "actual prefixed companion %s value checkpoint leaves workbook XML and unrelated parts unchanged",
  async (cell) => {
    const dir = mkdtempSync(join(tmpdir(), "workbook-ns-"));
    writeFileSync(join(dir, "book1.xlsx"), original);
    const db = openDb(join(dir, "test.sqlite"), [
      BACKUPS_MIGRATION,
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ]);
    const service = new DocumentService(db);
    try {
      const { meta } = await service.open("w", dir, "book1.xlsx");
      expect(readFileSync(join(dir, "book1.xlsx"))).toEqual(original);
      const result = await service.submit(meta.id, dir, {
        baseRev: 0,
        source: { kind: "agent", id: "namespace" },
        ops: [{ op: "cells.set", range: `Sheet1!${cell}`, values: [[77]] }],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      await service.checkpoint(meta.id, dir);
      const output = readFileSync(join(dir, "book1.xlsx"));
      const before = unzipSync(original),
        after = unzipSync(output);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      for (const part of Object.keys(before))
        if (part !== "xl/worksheets/sheet1.xml") expect(after[part], part).toEqual(before[part]);
      const imported = importXlsx(output, "book1.xlsx");
      const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!;
      expect(sheet.cellData?.[0]?.[0]?.v).toBe(cell === "A1" ? 77 : "hello world");
      expect(sheet.cellData?.[1]?.[0]?.v).toBe(cell === "A2" ? 77 : undefined);
    } finally {
      await service.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);

test.each(["rename", "raw order", "new formula"] as const)(
  "prefixed workbook actor rejects %s before any mixed-batch command or backup",
  async (action) => {
    // A targeted copy of the real sheet makes reordering meaningful without replacing the fixture.
    const parts: Record<string, Uint8Array> = unzipSync(original);
    if (action === "raw order") {
      parts["xl/workbook.xml"] = bytesOf(
        textOf(parts["xl/workbook.xml"]!).replace(
          "</x:sheets>",
          `<x:sheet name="Second" sheetId="2" xmlns:r="${REL}" r:id="testSecond"/></x:sheets>`,
        ),
      );
      parts["xl/_rels/workbook.xml.rels"] = bytesOf(
        textOf(parts["xl/_rels/workbook.xml.rels"]!).replace(
          "</Relationships>",
          `<Relationship Id="testSecond" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
        ),
      );
      parts["[Content_Types].xml"] = bytesOf(
        textOf(parts["[Content_Types].xml"]!).replace(
          "</Types>",
          '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        ),
      );
      parts["xl/worksheets/sheet2.xml"] = parts["xl/worksheets/sheet1.xml"]!;
    }
    const input = action === "raw order" ? zipSync(parts) : original;
    const dir = mkdtempSync(join(tmpdir(), "workbook-ns-actor-"));
    writeFileSync(join(dir, "book1.xlsx"), input);
    const db = openDb(join(dir, "test.sqlite"), [
      BACKUPS_MIGRATION,
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ]);
    const service = new DocumentService(db);
    let execute: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const opened = await service.open("w", dir, "book1.xlsx");
      const before = await service.snapshot(opened.meta.id, dir);
      expect(before.snapshot.sheetOrder.length).toBe(action === "raw order" ? 2 : 1);
      const entry = await service.entry(opened.meta.id, dir);
      execute = vi.spyOn(entry.live.boot, "executeCommand");
      const result = await service.submit(opened.meta.id, dir, {
        baseRev: before.meta.rev,
        source: { kind: "user", id: "namespace-actor" },
        ...(action === "raw order"
          ? {
              mutations: [
                {
                  id: "sheet.mutation.set-range-values",
                  params: {
                    unitId: before.snapshot.id,
                    subUnitId: before.snapshot.sheetOrder[0],
                    trigger: "sheet.command.set-range-values",
                    cellValue: { 0: { 0: { v: 77 } } },
                  },
                },
                {
                  id: "sheet.mutation.set-worksheet-order",
                  params: {
                    unitId: before.snapshot.id,
                    subUnitId: before.snapshot.sheetOrder[0],
                    fromOrder: 0,
                    toOrder: 1,
                  },
                },
              ],
            }
          : {
              ops: [
                { op: "cells.set" as const, range: "Sheet1!A1", values: [[77]] },
                ...(action === "rename"
                  ? [{ op: "sheet.rename" as const, sheet: "Sheet1", name: "Renamed" }]
                  : [{ op: "cells.set" as const, range: "Sheet1!A2", values: [["=1+1"]] }]),
              ],
            }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_FEATURE",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(service.headRev(opened.meta.id)).toBe(before.meta.rev);
      expect((await service.snapshot(opened.meta.id, dir)).snapshot).toEqual(before.snapshot);
      expect(
        db.prepare("SELECT count(*) AS n FROM doc_ops WHERE doc_id=?").get(opened.meta.id),
      ).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(dir, "book1.xlsx"))).toEqual(Buffer.from(input));
    } finally {
      execute?.mockRestore();
      await service.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);

test("prefixed workbook actor rejects formula find_replace before commands, revision, or backup", async () => {
  // Keep the real prefixed workbook; add only a legal local formula in its existing sheet.
  const parts: Record<string, Uint8Array> = unzipSync(original);
  parts["xl/worksheets/sheet1.xml"] = bytesOf(
    textOf(parts["xl/worksheets/sheet1.xml"]!).replace(
      "</x:row>",
      '<x:c r="B1"><x:f>1+1</x:f><x:v>2</x:v></x:c></x:row>',
    ),
  );
  const input = zipSync(parts);
  const dir = mkdtempSync(join(tmpdir(), "workbook-ns-replace-"));
  writeFileSync(join(dir, "book1.xlsx"), input);
  const db = openDb(join(dir, "test.sqlite"), [
    BACKUPS_MIGRATION,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  let execute: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const opened = await service.open("w", dir, "book1.xlsx");
    const before = await service.snapshot(opened.meta.id, dir);
    const sid = before.snapshot.sheetOrder[0]!;
    expect(before.snapshot.sheets[sid]!.cellData?.[0]?.[1]?.f).toBe("=1+1");
    const entry = await service.entry(opened.meta.id, dir);
    execute = vi.spyOn(entry.live.boot, "executeCommand");
    const result = await service.submit(opened.meta.id, dir, {
      baseRev: before.meta.rev,
      source: { kind: "agent", id: "namespace-formula-replace" },
      ops: [
        {
          op: "find_replace",
          range: "Sheet1!B1",
          find: "1+1",
          replacement: "2+2",
          regex: false,
          caseSensitive: false,
          formulas: true,
        },
      ],
    });
    expect.soft(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FEATURE",
    });
    expect.soft(execute).not.toHaveBeenCalled();
    expect.soft(service.headRev(opened.meta.id)).toBe(before.meta.rev);
    expect.soft((await service.snapshot(opened.meta.id, dir)).snapshot).toEqual(before.snapshot);
    expect
      .soft(db.prepare("SELECT count(*) AS n FROM doc_ops WHERE doc_id=?").get(opened.meta.id))
      .toEqual({ n: 0 });
    expect.soft(db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
    expect.soft(readFileSync(join(dir, "book1.xlsx"))).toEqual(Buffer.from(input));
  } finally {
    execute?.mockRestore();
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
