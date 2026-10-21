import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { chartCacheMetadata, objectsOf } from "../src/objects.ts";
import { ChangeOp, compileOps } from "../src/ops.ts";
import { importXlsx } from "../src/xlsx.ts";

test("partial chart updates retain omitted geometry and data through export", () => {
  const { snapshot } = importCsv(
    new TextEncoder().encode("月份,收入,支出\n1月,100,60\n2月,140,90\n"),
    "chart.csv",
  );
  const sid = snapshot.sheetOrder[0] ?? "";
  const sheet = snapshot.sheets[sid];
  if (!sheet) throw Error("sheet missing");
  const original = {
    id: "chart1",
    title: "季度收支",
    type: "column" as const,
    range: "A1:C3",
    anchor: "A7",
    width: 720,
    height: 410,
  };
  sheet.custom = { excelmanusObjects: { charts: [original], images: [] } };
  const update = ChangeOp.parse({
    op: "chart.update",
    sheet: sid,
    id: "chart1",
    title: "季度趋势",
    type: "line",
  });
  const compiled = compileOps({ snapshot, unitId: snapshot.id }, [update]);
  sheet.custom.excelmanusObjects = compiled.commands[0]?.params.objects;
  expect(objectsOf(sheet).charts).toEqual([{ ...original, title: "季度趋势", type: "line" }]);
  const disk = importXlsx(minimalXlsx(snapshot), "updated.xlsx").snapshot;
  expect(objectsOf(disk.sheets[disk.sheetOrder[0] ?? ""]).charts[0]).toMatchObject({
    ...original,
    title: "季度趋势",
    type: "line",
  });
  const moved = compileOps({ snapshot, unitId: snapshot.id }, [
    ChangeOp.parse({ op: "chart.update", sheet: sid, id: "chart1", anchor: "B8", width: 800 }),
  ]);
  sheet.custom.excelmanusObjects = moved.commands[0]?.params.objects;
  expect(objectsOf(sheet).charts).toEqual([
    { ...original, title: "季度趋势", type: "line", anchor: "B8", width: 800 },
  ]);
});

test("chart creation still supplies its original default size and anchor", () => {
  expect(
    ChangeOp.parse({ op: "chart.add", sheet: "s0", title: "图", type: "column", range: "A1:B3" }),
  ).toMatchObject({ anchor: "E2", width: 640, height: 360 });
});

test.each(["c", "chart"])(
  "imported %s chart caches follow source edits without rewriting foreign styling",
  (prefix) => {
    const { snapshot } = importCsv(
      new TextEncoder().encode("月份,甲,乙\n一月,120,80\n二月,150,110"),
      "chart.csv",
    );
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;
    sheet.custom = {
      excelmanusObjects: {
        charts: [
          {
            id: "chart1",
            title: "销售",
            type: "column",
            range: "A1:C3",
            anchor: "E1",
            width: 480,
            height: 300,
          },
        ],
        images: [],
      },
    };
    const parts = unzipSync(minimalXlsx(snapshot));
    const owned = Object.keys(parts).find((p) => p.startsWith("xl/charts/") && p.endsWith(".xml"))!;
    const foreign = "xl/charts/chart1.xml";
    parts[foreign] = strToU8(
      strFromU8(parts[owned]!).replace(
        "</c:chartSpace>",
        '<c:extLst><c:ext uri="urn:keep-style"/></c:extLst></c:chartSpace>',
      ),
    );
    parts[foreign] = strToU8(
      strFromU8(parts[foreign]!)
        .replaceAll("c:", `${prefix}:`)
        .replaceAll("xmlns:c=", `xmlns:${prefix}=`),
    );
    delete parts[owned];
    for (const p of Object.keys(parts))
      if (p.endsWith(".rels") || p === "[Content_Types].xml")
        parts[p] = strToU8(strFromU8(parts[p]!).replaceAll(owned.split("/").at(-1)!, "chart1.xml"));
    const initial = importXlsx(zipSync(parts), "foreign.xlsx");
    const next = structuredClone(initial.snapshot);
    const s = next.sheets[next.sheetOrder[0]!]!;
    s.cellData![2]![1]!.v = 175;
    s.cellData![1]![2]!.v = 95;
    const exported = unzipSync(exportXlsx(initial, next));
    const result = strFromU8(exported[foreign]!);
    expect(result).toContain("urn:keep-style");
    expect(result).toContain(`<${prefix}:v>175</${prefix}:v>`);
    expect(result).toContain(`<${prefix}:v>95</${prefix}:v>`);
    expect(result).toBe(
      strFromU8(parts[foreign]!)
        .replace(`<${prefix}:v>150</${prefix}:v>`, `<${prefix}:v>175</${prefix}:v>`)
        .replace(`<${prefix}:v>80</${prefix}:v>`, `<${prefix}:v>95</${prefix}:v>`),
    );
    const cached = chartCacheMetadata(exported).charts[0]!;
    expect(cached.series[0]?.values?.points.map((p) => p.value)).toEqual(["120", "175"]);
    expect(cached.series[1]?.values?.points.map((p) => p.value)).toEqual(["95", "110"]);
    expect(objectsOf(s).charts).toEqual(objectsOf(initial.snapshot.sheets[s.id]).charts);
  },
);
