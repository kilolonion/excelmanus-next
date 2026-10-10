import { execFileSync } from "node:child_process";
import { OBJECT_LAYER_MUTATION } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { bootUniver, createBook, MutationCapture } from "../src/engine.ts";

test("对象层 mutation 在真实引擎内可捕获、保存、重建", async () => {
  const boot = bootUniver();
  try {
    const imported = importCsv(new TextEncoder().encode("地区,金额\n东,10\n西,20\n"), "chart.csv");
    const book = createBook(boot, imported.snapshot);
    const sheetId = imported.snapshot.sheetOrder[0]!;
    const capture = new MutationCapture(boot);
    capture.begin();
    const objects = {
      images: [],
      charts: [
        {
          id: "c1",
          type: "column",
          title: "地区",
          range: "A1:B3",
          anchor: "E2",
          width: 640,
          height: 360,
        },
      ],
    };
    expect(
      await boot.executeCommand(OBJECT_LAYER_MUTATION, {
        unitId: book.unitId,
        subUnitId: sheetId,
        objects,
      }),
    ).toBe(true);
    expect(capture.end().some((m) => m.id === OBJECT_LAYER_MUTATION)).toBe(true);
    expect(book.workbook.save().sheets[sheetId]?.custom?.excelmanusObjects).toEqual(objects);
  } finally {
    await boot.dispose();
  }
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { unzipSync, zipSync } from "fflate";
import { minimalXlsx } from "../src/checkpoint.ts";
import { objectsOf } from "../src/objects.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

test("原生八类图表随 actor 修订保存、重新导入，更新和删除可回滚，尺寸和排序实际生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-chart-"));
  const db = openDb(join(dir, "test.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
  ]);
  const service = new DocumentService(db);
  try {
    writeFileSync(
      join(dir, "chart.xlsx"),
      minimalXlsx(
        importCsv(new TextEncoder().encode("地区,销售,利润\n西,20,2\n东,10,1\n"), "chart.csv")
          .snapshot,
      ),
    );
    const opened = await service.open("w", dir, "chart.xlsx");
    const docId = opened.meta.id;
    const sheetId = opened.imported.snapshot.sheetOrder[0]!;
    const sheet = opened.imported.snapshot.sheets[sheetId]!.name!;
    for (const type of [
      "column",
      "bar",
      "line",
      "pie",
      "doughnut",
      "scatter",
      "area",
      "combo",
    ] as const) {
      const result = await service.submit(docId, dir, {
        baseRev: (await service.snapshot(docId, dir)).meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        ops: [
          {
            op: "chart.add",
            anchor: "E2",
            width: 640,
            height: 360,
            sheet,
            type,
            title: `${type}图`,
            range:
              type === "scatter"
                ? "B1:C3"
                : type === "pie" || type === "doughnut"
                  ? "A1:B3"
                  : "A1:C3",
          },
        ],
      });
      expect(result, result.ok ? "" : result.message).toMatchObject({ ok: true });
      if (result.ok)
        expect(result.changes.structural.some((label) => label.includes("新增图表"))).toBe(true);
    }
    await service.checkpoint(docId, dir);
    const bytes = readFileSync(join(dir, "chart.xlsx"));
    writeFileSync(join(tmpdir(), "excelmanus-chart-debug.xlsx"), bytes);
    const parts = unzipSync(bytes);
    const chartParts = Object.keys(parts).filter((p) => /^xl\/charts\/chart-em_.*\.xml$/.test(p));
    expect(chartParts).toHaveLength(8);
    expect(
      Object.keys(parts).filter((p) => /^xl\/drawings\/drawing-.*\.xml$/.test(p)),
    ).toHaveLength(1);
    verifyWithLibreOffice(dir, "chart.xlsx");
    const imported = importXlsx(bytes, "roundtrip.xlsx");
    expect(
      objectsOf(imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]).charts,
    ).toHaveLength(8);
    const snap = await service.snapshot(docId, dir);
    const id = objectsOf(snap.snapshot.sheets[sheetId]).charts[0]!.id;
    const dry = await service.submit(docId, dir, {
      baseRev: snap.meta.rev,
      source: { kind: "agent", id: "main" },
      sessionId: "s",
      dryRun: true,
      ops: [{ op: "chart.update", sheet, id, title: "预览标题" }],
    });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    expect(
      objectsOf((await service.snapshot(docId, dir)).snapshot.sheets[sheetId]).charts[0]?.title,
    ).toBe("column图");
    const edit = await service.submit(docId, dir, {
      baseRev: snap.meta.rev,
      source: { kind: "agent", id: "main" },
      sessionId: "s",
      ops: [
        { op: "chart.update", sheet, id, title: "已更新" },
        { op: "cols.width", sheet, at: 1, count: 1, pixels: 180 },
        { op: "rows.height", sheet, at: 1, count: 1, pixels: 35 },
      ],
    });
    expect(edit, JSON.stringify(edit)).toMatchObject({ ok: true });
    await service.checkpoint(docId, dir);
    const updated = importXlsx(readFileSync(join(dir, "chart.xlsx")), "updated.xlsx");
    expect(
      objectsOf(updated.snapshot.sheets[updated.snapshot.sheetOrder[0]!]).charts[0]?.title,
    ).toBe("已更新");
    // Imported third-party charts: patch only title/data nodes, preserve unknown XML.
    const foreign = unzipSync(readFileSync(join(dir, "chart.xlsx")));
    const owned = objectsOf(updated.snapshot.sheets[updated.snapshot.sheetOrder[0]!]).charts[0]!;
    const part = owned.chartPart!;
    const foreignPart = "xl/charts/foreign.xml";
    foreign[foreignPart] = new TextEncoder().encode(
      new TextDecoder()
        .decode(foreign[part])
        .replace(
          "</c:chartSpace>",
          '<c:extLst><c:ext uri="urn:test:preserve"/></c:extLst></c:chartSpace>',
        ),
    );
    delete foreign[part];
    for (const path of Object.keys(foreign))
      if (path.endsWith(".rels") || path === "[Content_Types].xml")
        foreign[path] = new TextEncoder().encode(
          new TextDecoder()
            .decode(foreign[path])
            .replaceAll(part.split("/").at(-1)!, "foreign.xml"),
        );
    writeFileSync(join(dir, "foreign.xlsx"), zipSync(foreign));
    const external = await service.open("w", dir, "foreign.xlsx");
    const eSnap = (await service.snapshot(external.meta.id, dir)).snapshot;
    const eSheet = eSnap.sheets[eSnap.sheetOrder[0]!]!;
    const changed = await service.submit(external.meta.id, dir, {
      baseRev: external.meta.rev,
      source: { kind: "agent", id: "main" },
      sessionId: "s",
      ops: [{ op: "chart.update", sheet: eSheet.name!, id: owned.id, title: "第三方标题" }],
    });
    expect(changed, JSON.stringify(changed)).toMatchObject({ ok: true });
    await service.checkpoint(external.meta.id, dir);
    const patched = unzipSync(readFileSync(join(dir, "foreign.xlsx")));
    expect(new TextDecoder().decode(patched[foreignPart])).toContain("urn:test:preserve");
    expect(new TextDecoder().decode(patched[foreignPart])).toContain("第三方标题");
    for (const [path, value] of Object.entries(foreign))
      if (path !== foreignPart) expect(patched[path], path).toEqual(value);
    const deletion = await service.submit(docId, dir, {
      baseRev: (await service.snapshot(docId, dir)).meta.rev,
      source: { kind: "agent", id: "main" },
      sessionId: "s",
      ops: [{ op: "chart.delete", sheet, id }],
    });
    expect(deletion, JSON.stringify(deletion)).toMatchObject({ ok: true });
    await service.checkpoint(docId, dir);
    const deleted = unzipSync(readFileSync(join(dir, "chart.xlsx")));
    expect(Object.keys(deleted).filter((p) => /^xl\/charts\/.+\.xml$/.test(p))).toHaveLength(7);
    expect(new TextDecoder().decode(deleted["[Content_Types].xml"])).not.toContain(part);
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

import { ChangeOp } from "../src/ops.ts";
import { CF_RESOURCE, DV_RESOURCE, rulesResource } from "../src/rule-codec.ts";

test("条件格式与数据验证经真实 actor 写入、回读、修改和预览回滚，排序和尺寸写入一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-rules-"));
  const db = openDb(join(dir, "test.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
  ]);
  const service = new DocumentService(db);
  try {
    writeFileSync(
      join(dir, "rules.xlsx"),
      minimalXlsx(
        importCsv(new TextEncoder().encode("项目,金额\nB,20\nA,10\nC,\n"), "rules.csv").snapshot,
      ),
    );
    const opened = await service.open("w", dir, "rules.xlsx"),
      id = opened.meta.id;
    const sid = opened.imported.snapshot.sheetOrder[0]!,
      sheet = opened.imported.snapshot.sheets[sid]!.name!;
    const submit = async (ops: unknown[], dryRun = false) =>
      service.submit(id, dir, {
        baseRev: (await service.snapshot(id, dir)).meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        dryRun,
        ops: ops.map((op) => ChangeOp.parse(op)),
      });
    const grouping = await submit([
      { op: "axis.group", sheet, axis: "rows", at: 2, count: 2, level: 1 },
      { op: "axis.group", sheet, axis: "cols", at: 2, count: 1, level: 2 },
      { op: "axis.hide", sheet, axis: "rows", at: 3, count: 1, hidden: true },
    ]);
    expect(grouping, JSON.stringify(grouping)).toMatchObject({ ok: true });
    await service.checkpoint(id, dir);
    const grouped = importXlsx(readFileSync(join(dir, "rules.xlsx")), "rules.xlsx").snapshot;
    const groupedSheet = grouped.sheets[grouped.sheetOrder[0]!]!;
    expect(groupedSheet.rowData?.[1]?.custom?.excelmanusOutlineLevel).toBe(1);
    expect(groupedSheet.columnData?.[1]?.custom?.excelmanusOutlineLevel).toBe(2);
    expect(groupedSheet.rowData?.[2]?.hd).toBe(1);
    expect(
      await submit([{ op: "axis.group", sheet, axis: "rows", at: 2, count: 2, level: 0 }], true),
    ).toMatchObject({ ok: true, dryRun: true });
    expect(
      (await service.snapshot(id, dir)).snapshot.sheets[sid]?.rowData?.[1]?.custom
        ?.excelmanusOutlineLevel,
    ).toBe(1);
    const applied = await submit([
      {
        op: "style.set",
        range: `${sheet}!A1:B1`,
        fontFamily: "Arial",
        indent: 2,
        fontSize: 14,
        vAlign: "center",
        borders: { bottom: { style: "thin", color: "#123456" } },
      },
      { op: "cf.add", id: "cf1", range: `${sheet}!B2:B4`, kind: "blank", fill: "#FFFF00" },
      {
        op: "dv.add",
        id: "dv1",
        range: `${sheet}!B2:B4`,
        type: "decimal",
        operator: "between",
        formula1: "0",
        formula2: "100",
      },
      { op: "cols.width", sheet, at: 1, count: 1, pixels: 180 },
      { op: "rows.height", sheet, at: 1, count: 1, pixels: 35 },
    ]);
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
    const snapshot = (await service.snapshot(id, dir)).snapshot;
    expect(rulesResource(snapshot, CF_RESOURCE)[sid]).toHaveLength(1);
    expect(rulesResource(snapshot, DV_RESOURCE)[sid]).toHaveLength(1);
    expect(snapshot.sheets[sid]?.columnData?.[0]?.w).toBe(180);
    expect(snapshot.sheets[sid]?.rowData?.[0]?.h).toBe(35);
    const dry = await submit(
      [
        {
          op: "cf.add",
          id: "cf1",
          range: `${sheet}!B2:B4`,
          kind: "number",
          operator: "greaterThan",
          values: [15],
          fill: "#FF0000",
        },
      ],
      true,
    );
    expect(dry, JSON.stringify(dry)).toMatchObject({ ok: true, dryRun: true });
    expect(rulesResource((await service.snapshot(id, dir)).snapshot, CF_RESOURCE)[sid]).toEqual(
      rulesResource(snapshot, CF_RESOURCE)[sid],
    );
    await service.checkpoint(id, dir);
    let bytes = readFileSync(join(dir, "rules.xlsx"));
    let imported = importXlsx(bytes, "roundtrip.xlsx");
    const styleCell =
      imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!.cellData?.[0]?.[0];
    const style =
      typeof styleCell?.s === "string" ? imported.snapshot.styles[styleCell.s] : styleCell?.s;
    expect(style).toMatchObject({
      ff: "Arial",
      pd: { l: 42 },
      fs: 14,
      vt: 2,
      bd: { b: { s: 1, cl: { rgb: "#123456" } } },
    });
    const key = imported.snapshot.sheetOrder[0]!;
    expect(rulesResource(imported.snapshot, CF_RESOURCE)[key]).toHaveLength(1);
    expect(rulesResource(imported.snapshot, DV_RESOURCE)[key]).toHaveLength(1);
    verifyWithLibreOffice(dir, "rules.xlsx");
    const parts = unzipSync(bytes),
      sheetXml = new TextDecoder().decode(parts["xl/worksheets/sheet1.xml"]);
    expect(sheetXml).toContain("<conditionalFormatting");
    expect(sheetXml).toContain("<dataValidations");
    expect(sheetXml).toContain("LEN(TRIM(B2))=0");
    const update = await submit([
      {
        op: "cf.add",
        id: "cf1",
        range: `${sheet}!B2:B4`,
        kind: "number",
        operator: "greaterThan",
        values: [15],
        fill: "#FF0000",
      },
      {
        op: "dv.add",
        id: "dv1",
        range: `${sheet}!B2:B4`,
        type: "whole",
        operator: "between",
        formula1: "0",
        formula2: "50",
      },
    ]);
    expect(update, JSON.stringify(update)).toMatchObject({ ok: true });
    await service.checkpoint(id, dir);
    bytes = readFileSync(join(dir, "rules.xlsx"));
    imported = importXlsx(bytes, "updated.xlsx");
    expect(rulesResource(imported.snapshot, CF_RESOURCE)[key]).toHaveLength(1);
    expect(rulesResource(imported.snapshot, DV_RESOURCE)[key]).toHaveLength(1);
    expect(rulesResource(imported.snapshot, DV_RESOURCE)[key]?.[0]?.formula2).toBe("50");
    const remove = await submit([
      { op: "cf.remove", sheet, id: "cf1" },
      { op: "dv.remove", sheet, id: "dv1" },
    ]);
    expect(remove, JSON.stringify(remove)).toMatchObject({ ok: true });
    expect(
      await submit([{ op: "axis.hide", sheet, axis: "rows", at: 3, count: 1, hidden: false }]),
    ).toMatchObject({ ok: true });
    const sorted = await submit([
      {
        op: "sort",
        range: `${sheet}!A1:B4`,
        header: true,
        keys: [{ column: 1, order: "asc" }],
      },
    ]);
    expect(sorted, JSON.stringify(sorted)).toMatchObject({ ok: true });
    const after = (await service.snapshot(id, dir)).snapshot;
    expect(after.sheets[sid]?.cellData?.[1]?.[0]?.v).toBe("A");
    expect(after.sheets[sid]?.cellData?.[1]?.[1]?.v).toBe(10);
    expect(
      await submit([
        { op: "cells.set", range: `${sheet}!D1`, values: [["a.b A.B", "=1+1"]] },
        { op: "find_replace", range: `${sheet}!D1:E1`, find: "a.b", replacement: "$&literal" },
      ]),
    ).toMatchObject({ ok: true });
    const replaced = (await service.snapshot(id, dir)).snapshot.sheets[sid]!;
    expect(replaced.cellData?.[0]?.[3]?.v).toBe("$&literal $&literal");
    expect(replaced.cellData?.[0]?.[4]?.f).toBe("=1+1");
    expect(
      await submit(
        [{ op: "find_replace", range: `${sheet}!D1:E1`, find: "literal", replacement: "PREVIEW" }],
        true,
      ),
    ).toMatchObject({ ok: true, dryRun: true });
    expect((await service.snapshot(id, dir)).snapshot.sheets[sid]?.cellData?.[0]?.[3]?.v).toBe(
      "$&literal $&literal",
    );
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

function verifyWithLibreOffice(dir: string, file: string) {
  let available = false;
  try {
    execFileSync("soffice", ["--version"], { timeout: 10000 });
    available = true;
  } catch {}
  if (available) {
    const out = join(dir, "lo-verified");
    execFileSync(
      "soffice",
      [
        `-env:UserInstallation=file://${dir}/lo-profile`,
        "--headless",
        "--convert-to",
        "xlsx",
        "--outdir",
        out,
        join(dir, file),
      ],
      { timeout: 30000 },
    );
    const imported = importXlsx(readFileSync(join(out, file)), file);
    expect(imported.snapshot.sheetOrder.length).toBeGreaterThan(0);
    const parsed = unzipSync(readFileSync(join(out, file)));
    if (file === "chart.xlsx")
      expect(
        Object.keys(parsed).filter((path) => /^xl\/charts\/chart.*\.xml$/.test(path)),
      ).toHaveLength(8);
    if (file === "rules.xlsx") {
      const xml = new TextDecoder().decode(parsed["xl/worksheets/sheet1.xml"]);
      expect(xml).toContain("conditionalFormatting");
      expect(xml).toContain("dataValidation");
    }
  }
  process.stdout.write(
    `V1 native objects LibreOffice: ${JSON.stringify({ file, opened: available })}\n`,
  );
}
