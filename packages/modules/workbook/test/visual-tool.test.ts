import type { IWorksheetData } from "@univerjs/core";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { ChangeOp, compileOps } from "../src/ops.ts";
import { CF_RESOURCE, rulesResource, setRulesResource } from "../src/rule-codec.ts";
import { buildLayout } from "../src/render.ts";
import { importXlsx } from "../src/xlsx.ts";

test("agent visual rules survive export and paint actual bars and scale colors", () => {
  const { snapshot } = importCsv(
    new TextEncoder().encode("n,score\n0.3,45\n0.7,72\n1,95\n0.5,60\n"),
    "a.csv",
  );
  const ops = [
    { op: "cf.add", range: "A2:A5", kind: "dataBar", values: [0, 1], fill: "#4472C4" },
    {
      op: "cf.add",
      range: "B2:B5",
      kind: "colorScale",
      values: [0, 60, 100],
      colors: ["#FF0000", "#FFFF00", "#00FF00"],
    },
  ].map((op) => ChangeOp.parse(op));
  const compiled = compileOps({ snapshot, unitId: snapshot.id }, ops);
  const sid = snapshot.sheetOrder[0]!;
  setRulesResource(snapshot, CF_RESOURCE, {
    [sid]: compiled.commands.map((c) => c.params.rule as Record<string, unknown>),
  });
  const disk = importXlsx(minimalXlsx(snapshot), "a.xlsx").snapshot;
  const rules = rulesResource(disk, CF_RESOURCE)[sid]!;
  expect(rules.map((r) => r.rule.type)).toEqual(["dataBar", "colorScale"]);
  expect(rules[0]!.rule.config).toMatchObject({
    min: { type: "num", value: 0 },
    max: { type: "num", value: 1 },
  });
  expect(rules[1]!.rule.config.map((v: any) => v.value.value)).toEqual([0, 60, 100]);
  const layout = buildLayout(disk, disk.sheets[sid] as IWorksheetData, "A1:B5").layout;
  expect(layout.cells.filter((c) => c.dataBar)).toHaveLength(4);
  expect(layout.cells.find((c) => c.text === "0.3")?.dataBar).toMatchObject({
    end: 0.3,
    color: "#4472C4",
  });
  expect(layout.cells.find((c) => c.text === "60")?.fill?.toUpperCase()).toBe("#FFFF00");
});
test("filter clear with selected values is rejected rather than silently removing the filter", () => {
  const { snapshot } = importCsv(new TextEncoder().encode("region\nEast\nWest\n"), "a.csv");
  expect(() =>
    compileOps({ snapshot, unitId: snapshot.id }, [
      ChangeOp.parse({
        op: "filter.set",
        range: "A1:A3",
        clear: true,
        columns: [{ column: 1, values: ["East"] }],
      }),
    ]),
  ).toThrow(/clear/);
});
test("screenshots omit filter-hidden rows and keep object anchor aligned", () => {
  const { snapshot } = importCsv(new TextEncoder().encode("n\n10\n20\n30\n"), "a.csv");
  const sid = snapshot.sheetOrder[0]!,
    sheet = snapshot.sheets[sid]!;
  snapshot.resources = [
    { name: "SHEET_FILTER_PLUGIN", data: JSON.stringify({ [sid]: { cachedFilteredOut: [1] } }) },
  ];
  sheet.custom = {
    excelmanusObjects: {
      charts: [
        {
          id: "c",
          title: "chart",
          type: "column",
          range: "A1:A4",
          anchor: "B4",
          width: 100,
          height: 100,
        },
      ],
      images: [],
    },
  };
  const layout = buildLayout(snapshot, sheet as IWorksheetData, "A1:B4");
  expect(layout.rows.find((r) => r.row === 2)?.h).toBe(0);
  expect(layout.layout.cells.some((c) => c.text === "10")).toBe(false);
  expect(layout.rows.find((r) => r.row === 3)?.y).toBe(46);
  expect(layout.layout.charts?.[0]?.y).toBe(70);
});
