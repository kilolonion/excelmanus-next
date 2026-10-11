// 写回保真回归（审计 P0-04/05/06、P1-24/25/26/27/28/33/35/36）：纯导出路径 + 真实 DocumentService。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import type { IWorkbookData } from "@univerjs/core";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, test } from "vitest";
import {
  assertCellsWritable,
  exportXlsx,
  pendingChanges,
  remapSheetIndexes,
} from "../src/checkpoint.ts";
import { exportCsv, importCsv } from "../src/csv.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/package/2006/relationships";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

function book(sheets: string[], extra: { calcChain?: boolean; styles?: string } = {}): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": enc(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${extra.calcChain ? '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' : ""}</Types>`,
    ),
    "_rels/.rels": enc(
      `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": enc(
      `<workbook xmlns="${NS}" xmlns:r="${R}"><sheets>${sheets.map((_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029"/></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": enc(
      `<Relationships xmlns="${P}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}${extra.calcChain ? `<Relationship Id="rId90" Type="${R}/calcChain" Target="calcChain.xml"/>` : ""}${extra.styles ? `<Relationship Id="rId91" Type="${R}/styles" Target="styles.xml"/>` : ""}</Relationships>`,
    ),
  };
  if (extra.styles)
    parts["xl/styles.xml"] = enc(`<styleSheet xmlns="${NS}">${extra.styles}</styleSheet>`);
  if (extra.calcChain)
    parts["xl/calcChain.xml"] = enc(`<calcChain xmlns="${NS}"><c r="B1" i="1"/></calcChain>`);
  sheets.forEach((x, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = enc(`<worksheet xmlns="${NS}">${x}</worksheet>`);
  });
  return zipSync(parts);
}
type Cells = Record<number, Record<number, Record<string, unknown>>>;
function edit(
  bytes: Uint8Array,
  fn: (s: IWorkbookData) => void,
  /** 写集；undefined = 无写集（以外部包为底的快照差异回退路径）。 */
  ranges: Array<[string, number, number]> | undefined,
) {
  const imported = importXlsx(bytes, "t.xlsx");
  const after = structuredClone(imported.snapshot);
  fn(after);
  const changes =
    ranges === undefined
      ? undefined
      : pendingChanges([
          {
            writeSet: {
              ranges: ranges.map(([sheetId, r, c]) => ({ sheetId, r0: r, c0: c, r1: r, c1: c })),
              structural: [],
            },
            sourceKind: "agent",
          },
        ]);
  return unzipSync(exportXlsx(imported, after, imported.snapshot, changes));
}
const cells = (s: IWorkbookData, id: string) => s.sheets[id]?.cellData as Cells;
const sheetData = (x: string) => /<sheetData>[\s\S]*<\/sheetData>/.exec(x)?.[0];

describe("xlsx 写回保真", () => {
  test("未在写集中的表逐字节保留，即使引擎重算改了其公式值（P0-04）", () => {
    const bytes = book([
      `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>`,
      `<sheetData><row r="1"><c r="A1"><f>TODAY()</f><v>40000</v></c></row></sheetData>`,
    ]);
    const out = edit(
      bytes,
      (s) => {
        cells(s, "s0")[0]![0] = { v: 5, t: 2 };
        cells(s, "s1")[0]![0] = { f: "=TODAY()", v: 46000, t: 2 };
      },
      [["s0", 0, 0]],
    );
    expect(dec(out["xl/worksheets/sheet2.xml"])).toBe(
      dec(unzipSync(bytes)["xl/worksheets/sheet2.xml"]),
    );
  });

  test("仅有引擎修订时写回公式缓存，不把结果误判成作者结构改动（P0-04）", () => {
    const bytes = book([
      `<sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData>`,
    ]);
    const imported = importXlsx(bytes, "t.xlsx");
    const after = structuredClone(imported.snapshot);
    const cell = cells(after, "s0")[0]?.[0];
    if (!cell) throw new Error("fixture cell missing");
    cell.f = "=1+1";
    cell.v = 3;
    const out = exportXlsx(
      imported,
      after,
      imported.snapshot,
      pendingChanges([
        {
          writeSet: {
            ranges: [{ sheetId: "s0", r0: 0, c0: 0, r1: 0, c1: 0 }],
            structural: [],
          },
          sourceKind: "engine",
        },
      ]),
    );
    expect(dec(unzipSync(out)["xl/worksheets/sheet1.xml"])).toMatch(
      /<c r="A1"[^>]*><f>1\+1<\/f><v>3<\/v><\/c>/,
    );
  });

  test("追加行保留原行开标签与分组；行内单元格按列排序（P0-05/06）", () => {
    const bytes = book([
      `<dimension ref="A1:C2"/><sheetData><row r="1" spans="1:3" s="1" customFormat="1"><c r="A1"><v>1</v></c><c r="B1" s="1"/><c r="C1"><v>3</v></c></row><row r="2" outlineLevel="1" hidden="1"><c r="A2"><v>2</v></c></row></sheetData>`,
    ]);
    const out = edit(
      bytes,
      (s) => {
        cells(s, "s0")[0]![2] = { v: 30, t: 2 };
        cells(s, "s0")[4] = { 0: { v: "合计", t: 1 } };
        s.sheets.s0!.rowCount = 5;
      },
      [
        ["s0", 0, 2],
        ["s0", 4, 0],
      ],
    );
    expect(sheetData(dec(out["xl/worksheets/sheet1.xml"]))).toBe(
      `<sheetData><row r="1" spans="1:3" s="1" customFormat="1"><c r="A1"><v>1</v></c><c r="B1" s="1"/><c r="C1"><v>30</v></c></row><row r="2" outlineLevel="1" hidden="1"><c r="A2"><v>2</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t xml:space="preserve">合计</t></is></c></row></sheetData>`,
    );
  });

  test("错误值/共享公式只在被改写时拒绝；新公式带计算缓存、设打开时重算、删 calcChain（P1-24/27/28）", () => {
    const bytes = book(
      [
        `<sheetData><row r="1"><c r="A1"><v>10</v></c><c r="B1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row><row r="2"><c r="A2"><f t="shared" ref="A2:A3" si="0">A1*2</f><v>20</v></c></row><row r="3"><c r="A3"><f t="shared" si="0"/><v>0</v></c></row></sheetData>`,
      ],
      { calcChain: true },
    );
    const out = edit(
      bytes,
      (s) => {
        cells(s, "s0")[0]![2] = { f: "=A1+1", v: 11, t: 2 };
      },
      [["s0", 0, 2]],
    );
    const xml = dec(out["xl/worksheets/sheet1.xml"]);
    expect(xml).toContain(
      `<c r="B1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="C1"><f>A1+1</f><v>11</v></c>`,
    );
    expect(xml).toContain(`<f t="shared" ref="A2:A3" si="0">A1*2</f>`);
    expect(dec(out["xl/workbook.xml"])).toContain(`fullCalcOnLoad="1"`);
    expect(out["xl/calcChain.xml"]).toBeUndefined();
    expect(dec(out["xl/_rels/workbook.xml.rels"])).not.toContain("calcChain");
    expect(dec(out["[Content_Types].xml"])).not.toContain("calcChain");
    expect(() =>
      edit(
        bytes,
        (s) => {
          cells(s, "s0")[1]![0] = { v: 1, t: 2 };
        },
        [["s0", 1, 0]],
      ),
    ).toThrow("共享公式主单元格");
  });

  test("表顺序变化重映射 localSheetId / activeTab，指向被删表则拒绝（P1-33）", () => {
    const wb = `<workbook><bookViews><workbookView activeTab="1"/></bookViews><definedNames><definedName name="a" localSheetId="1">T!$A$1</definedName><definedName name="b">S!$A$1</definedName></definedNames></workbook>`;
    expect(remapSheetIndexes(wb, ["s", "t"], ["n", "s", "t"])).toBe(
      `<workbook><bookViews><workbookView activeTab="2"/></bookViews><definedNames><definedName name="a" localSheetId="2">T!$A$1</definedName><definedName name="b">S!$A$1</definedName></definedNames></workbook>`,
    );
    expect(() => remapSheetIndexes(wb, ["s", "t"], ["s"])).toThrow("localSheetId");
  });

  test("无写集回退路径（以外部包为底）按坐标写回：行数变化不整表重建，原行属性保留", () => {
    const bytes = book([
      `<sheetData><row r="1" s="1" customFormat="1"><c r="A1"><v>1</v></c></row><row r="2" outlineLevel="1"><c r="A2"><v>2</v></c></row></sheetData>`,
    ]);
    const out = edit(
      bytes,
      (s) => {
        cells(s, "s0")[4] = { 0: { v: 5, t: 2 } };
        s.sheets.s0!.rowCount = 2000;
      },
      undefined,
    );
    expect(sheetData(dec(out["xl/worksheets/sheet1.xml"]))).toBe(
      `<sheetData><row r="1" s="1" customFormat="1"><c r="A1"><v>1</v></c></row><row r="2" outlineLevel="1"><c r="A2"><v>2</v></c></row><row r="5"><c r="A5"><v>5</v></c></row></sheetData>`,
    );
  });

  test("覆盖共享公式跟随格（模型中无 f）后删除 calcChain", () => {
    const bytes = book(
      [
        `<sheetData><row r="1"><c r="A1"><v>10</v></c></row><row r="2"><c r="A2"><f t="shared" ref="A2:A3" si="0">A1*2</f><v>20</v></c></row><row r="3"><c r="A3"><f t="shared" si="0"/><v>0</v></c></row></sheetData>`,
      ],
      { calcChain: true },
    );
    const out = edit(
      bytes,
      (s) => {
        cells(s, "s0")[2]![0] = { v: 7, t: 2 };
      },
      [["s0", 2, 0]],
    );
    expect(dec(out["xl/worksheets/sheet1.xml"])).toContain(`<c r="A3"><v>7</v></c>`);
    expect(out["xl/calcChain.xml"]).toBeUndefined();
  });

  test("大工作簿提交时只按写集命中格做保真检查，与检查点同规则（不推迟到检查点失败）", () => {
    const bytes = book([
      `<sheetData><row r="1"><c r="A1"><v>10</v></c><c r="D1" cm="1"><f t="array" ref="D1:E2">SEQUENCE(2,2)</f><v>1</v></c></row><row r="2"><c r="A2"><f t="shared" ref="A2:A3" si="0">A1*2</f><v>20</v></c></row><row r="3"><c r="A3"><f t="shared" si="0"/><v>0</v></c></row></sheetData>`,
    ]);
    const imported = importXlsx(bytes, "t.xlsx");
    const run = (fn: (c: Cells) => void, r: number, c: number) => {
      const after = structuredClone(imported.snapshot);
      fn(cells(after, "s0"));
      const range = { sheetId: "s0", r0: r, c0: c, r1: r, c1: c };
      assertCellsWritable(imported, after, imported.snapshot, [range], new Set());
    };
    expect(() =>
      run(
        (c) => {
          c[0]![1] = { v: 1, t: 2 };
        },
        0,
        1,
      ),
    ).not.toThrow();
    expect(() =>
      run(
        (c) => {
          c[2]![0] = { v: 1, t: 2 };
        },
        2,
        0,
      ),
    ).not.toThrow();
    expect(() =>
      run(
        (c) => {
          c[1]![0] = { v: 1, t: 2 };
        },
        1,
        0,
      ),
    ).toThrow("共享公式主单元格");
    expect(() =>
      run(
        (c) => {
          c[1]![4] = { v: 1, t: 2 };
        },
        1,
        4,
      ),
    ).toThrow("数组公式区域");
  });
});

const BOLD_STYLES = `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`;
const svcDirs: string[] = [];
const services: Array<{ svc: DocumentService; db: ReturnType<typeof openDb> }> = [];
afterAll(async () => {
  for (const x of services) {
    await x.svc.close().catch(() => {});
    x.db.close();
  }
  for (const d of svcDirs) rmSync(d, { recursive: true, force: true });
});
async function openBook(bytes: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-fix-writeback-"));
  svcDirs.push(dir);
  writeFileSync(join(dir, "book.xlsx"), bytes);
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  services.push({ svc, db });
  const { meta } = await svc.open("ws", dir, "book.xlsx");
  const unitId = (await svc.entry(meta.id, dir)).live.unitId;
  const sheetXml = async () => {
    await svc.checkpoint(meta.id, dir);
    expect(svc.meta(meta.id)?.checkpointError).toBeUndefined();
    return dec(unzipSync(readFileSync(join(dir, "book.xlsx")))["xl/worksheets/sheet1.xml"]);
  };
  return { dir, svc, id: meta.id, unitId, sheetXml };
}
const agent = { kind: "agent" as const, id: "session/main" };
const user = { kind: "user" as const, id: "u1" };

describe("xlsx 写回保真（真实 DocumentService + SQLite + 公式引擎）", () => {
  test("已有值/已有公式的格写公式：引擎结果并入修订后仍写回公式与计算缓存（P0-04/P1-27）", async () => {
    const { dir, svc, id, unitId, sheetXml } = await openBook(
      book([
        `<sheetData><row r="1"><c r="A1"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c><c r="C1"><v>5</v></c></row></sheetData>`,
      ]),
    );
    const r1 = await svc.submit(id, dir, {
      baseRev: 0,
      source: agent,
      sessionId: "session",
      ops: [{ op: "cells.set", range: "S0!B1:C1", values: [["=A1*3", "=A1+1"]] }],
    });
    expect(r1).toMatchObject({ ok: true, rev: 1 });
    // 引擎结果确实随修订入日志（被测路径的前提）
    expect(
      svc
        .opsAfter(id, 0)
        .flatMap((o) => o.mutations)
        .some((m) => JSON.stringify(m.params).includes('"v":11')),
    ).toBe(true);
    const r2 = await svc.submit(id, dir, {
      baseRev: 1,
      source: user,
      mutations: [
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId,
            subUnitId: "s0",
            trigger: "sheet.command.set-range-values",
            cellValue: { 0: { 3: { f: "=A1+2" } } },
          },
        },
      ],
    });
    expect(r2).toMatchObject({ ok: true, rev: 2 });
    const xml = await sheetXml();
    expect(xml).toContain(`<c r="B1"><f>A1*3</f><v>30</v></c>`);
    expect(xml).toContain(`<c r="C1"><f>A1+1</f><v>11</v></c>`);
    expect(xml).toContain(`<c r="D1"><f>A1+2</f><v>12</v></c>`);
  });

  test("用户调列宽/行高/隐藏行可写回，保留原 col/row 属性（P1-25）", async () => {
    const { dir, svc, id, unitId, sheetXml } = await openBook(
      book(
        [
          `<cols><col min="1" max="2" width="10" customWidth="1" style="1"/></cols><sheetData><row r="1" s="1" customFormat="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>`,
        ],
        { styles: BOLD_STYLES },
      ),
    );
    const range = (r: number, c: number) => ({
      startRow: r,
      endRow: r,
      startColumn: c,
      endColumn: c,
    });
    const r = await svc.submit(id, dir, {
      baseRev: 0,
      source: user,
      mutations: [
        {
          id: "sheet.mutation.set-worksheet-col-width",
          params: { unitId, subUnitId: "s0", ranges: [range(0, 1)], colWidth: 140 },
        },
        {
          id: "sheet.mutation.set-worksheet-row-height",
          params: { unitId, subUnitId: "s0", ranges: [range(0, 0)], rowHeight: 30 },
        },
        {
          id: "sheet.mutation.set-row-hidden",
          params: { unitId, subUnitId: "s0", ranges: [range(1, 0)] },
        },
      ],
    });
    expect(r).toMatchObject({ ok: true });
    const xml = await sheetXml();
    expect(xml).toContain(`<col min="1" max="1" width="10" customWidth="1" style="1"/>`);
    expect(xml).toMatch(/<col min="2" max="2" width="20" customWidth="1" style="1"\/>/);
    expect(xml).toMatch(/<row r="1" s="1" customFormat="1" ht="30" customHeight="1">/);
    expect(xml).toMatch(/<row r="2" hidden="1">/);
  });

  test('导入粗体样式；清除格式写回 s="0"（P1-26）', async () => {
    const { dir, svc, id, sheetXml } = await openBook(
      book(
        [
          `<sheetData><row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>2</v></c></row></sheetData>`,
        ],
        { styles: BOLD_STYLES },
      ),
    );
    const { snapshot: snap } = await svc.snapshot(id, dir);
    const s = cells(snap, "s0")[0]![0]!.s;
    const style = typeof s === "string" ? snap.styles?.[s] : s;
    expect(style).toMatchObject({ bl: 1 });
    const r = await svc.submit(id, dir, {
      baseRev: 0,
      source: agent,
      sessionId: "session",
      ops: [{ op: "cells.clear", range: "S0!A1", what: "formats" }],
    });
    expect(r).toMatchObject({ ok: true });
    const xml = await sheetXml();
    expect(xml).toContain(`<c r="A1" s="0"><v>1</v></c>`);
    expect(xml).toContain(`<c r="B1" s="1"><v>2</v></c>`);
  });
});

describe("CSV", () => {
  test("规范数字按数值导入、原文逐字写回；另存 CSV 输出值而非公式（P1-35/36）", () => {
    const text = "name,amount,code\na,9,007\nb,1000,1e3\n";
    const imported = importCsv(enc(text), "t.csv");
    const c = cells(imported.snapshot, "s0");
    expect(c[1]![1]).toEqual({ v: 9, t: 2 });
    expect(c[1]![2]).toEqual({ v: "007", t: 1 });
    expect(c[2]![2]).toEqual({ v: "1e3", t: 1 });
    expect(dec(exportCsv(imported.snapshot, { ...imported.csv, trailingNewline: true }))).toBe(
      text,
    );
    c[1]![1] = { f: "=1+1", v: 2, t: 2 };
    expect(dec(exportCsv(imported.snapshot))).toContain("a,2,007");
  });
});
