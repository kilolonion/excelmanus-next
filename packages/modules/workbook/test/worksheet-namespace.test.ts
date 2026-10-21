import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx, verifyXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";
import { bytesOf, textOf } from "../src/xml.ts";
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function fixture(transform: (xml: string) => string) {
  const snapshot = importCsv(bytesOf("Code,Qty,Amount\n00017,3,\n"), "source.csv").snapshot;
  snapshot.sheets[snapshot.sheetOrder[0]!]!.cellData![1]![2] = { f: "=B2*12.5", v: 37.5 };
  const parts: Record<string, Uint8Array> = unzipSync(minimalXlsx(snapshot));
  parts["xl/worksheets/sheet1.xml"] = bytesOf(
    transform(textOf(parts["xl/worksheets/sheet1.xml"]!)),
  );
  return zipSync(parts);
}
function prefix(xml: string) {
  return xml
    .replace('xmlns="' + NS + '"', 'xmlns:ns0="' + NS + '"')
    .replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g, "<$1ns0:$2");
}
test("合法 ns0 工作表导入、写回与无关部件保留", () => {
  const input = fixture(prefix);
  const imported = importXlsx(input, "prefixed.xlsx");
  const sid = imported.snapshot.sheetOrder[0]!;
  const sheet = imported.snapshot.sheets[sid]!;
  expect(sheet.cellData?.[1]?.[1]?.v).toBe(3);
  expect(sheet.cellData?.[1]?.[2]?.f).toBe("=B2*12.5");
  const after = structuredClone(imported.snapshot);
  after.sheets[sid]!.cellData![1]![1]!.v = 4;
  after.sheets[sid]!.cellData![1]![2]!.v = 50;
  const output = exportXlsx(imported, after);
  expect(() => verifyXlsx(output, after)).not.toThrow();
  const original = unzipSync(input),
    written = unzipSync(output);
  for (const [path, data] of Object.entries(original))
    if (path !== "xl/worksheets/sheet1.xml") expect(written[path], path).toEqual(data);
  expect(importXlsx(output, "out.xlsx").snapshot.sheets[sid]?.cellData?.[1]?.[2]?.v).toBe(50);
});
test.each(["urn:foreign", ""])("外来 worksheet namespace 不伪装主工作表：%s", (uri) => {
  const bytes = fixture((xml) => xml.replace(NS, uri));
  expect(() => importXlsx(bytes, "foreign.xlsx")).toThrow();
});
test("外来前缀 worksheet 不得因 localName 被接纳", () => {
  const input = fixture((xml) => prefix(xml).replace(NS, "urn:foreign"));
  expect(() => importXlsx(input, "foreign-prefix.xlsx")).toThrow();
});
test("前缀局部重绑定的外来同名 cell 不进入数据", () => {
  const input = fixture((xml) =>
    prefix(xml).replace(
      "</ns0:row>",
      '<ns0:c xmlns:ns0="urn:foreign" r="Z1"><ns0:v>999</ns0:v></ns0:c></ns0:row>',
    ),
  );
  const imported = importXlsx(input, "mixed.xlsx");
  const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!;
  expect(sheet.cellData?.[0]?.[25]).toBeUndefined();
  expect(sheet.cellData?.[1]?.[1]?.v).toBe(3);
});
test("外来 drawing 不得落入旧对象解析器", () => {
  const input = fixture((xml) =>
    prefix(xml).replace("</ns0:worksheet>", '<f:drawing xmlns:f="urn:foreign"/></ns0:worksheet>'),
  );
  expect(() => importXlsx(input, "foreign-drawing.xlsx")).toThrow();
});
test("前缀工作表只读打开不改源，显式编辑缓存可写回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worksheet-ns-"));
  const input = fixture(prefix);
  writeFileSync(join(dir, "book.xlsx"), input);
  const db = openDb(join(dir, "db.sqlite"), [
    BACKUPS_MIGRATION,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  try {
    const { meta } = await service.open("w", dir, "book.xlsx");
    const entry = await service.entry(meta.id, dir);
    await entry.live.boot.waitCalc(5000);
    await service.snapshot(meta.id, dir);
    await service.checkpoint(meta.id, dir);
    expect(readFileSync(join(dir, "book.xlsx"))).toEqual(Buffer.from(input));
    const result = await service.submit(meta.id, dir, {
      baseRev: 0,
      source: { kind: "agent", id: "main" },
      ops: [{ op: "cells.set", range: "B2", values: [[4]] }],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await entry.live.boot.waitCalc(5000);
    await service.checkpoint(meta.id, dir);
    const imported = importXlsx(readFileSync(join(dir, "book.xlsx")), "written.xlsx");
    const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!;
    expect(sheet.cellData?.[1]?.[1]?.v).toBe(4);
    expect(sheet.cellData?.[1]?.[2]?.v).toBe(50);
    expect(sheet.cellData?.[1]?.[2]?.f).toBe("=B2*12.5");
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
