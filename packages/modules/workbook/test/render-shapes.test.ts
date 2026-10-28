import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { expect, test } from "vitest";
import { buildLayout } from "../src/render.ts";

function fixture() {
  const shape = {
    id: "shape",
    title: "矩形",
    text: "OK",
    type: "rect",
    anchor: "B2",
    width: 120,
    height: 60,
    offsetX: 13,
    offsetY: 7,
    fill: "#00FF00",
    stroke: "#000000",
    textColor: "#FF0000",
  };
  const sheet = {
    id: "s",
    name: "Objects",
    rowCount: 20,
    columnCount: 10,
    cellData: {},
    custom: {
      excelmanusObjects: {
        charts: [],
        images: [
          {
            id: "image",
            title: "图",
            anchor: "B2",
            width: 40,
            height: 30,
            offsetX: 11,
            offsetY: 5,
            mediaType: "image/png",
            data: "aGVsbG8=",
          },
        ],
        shapes: [shape],
      },
    },
  } as unknown as IWorksheetData;
  return {
    shape,
    sheet,
    snapshot: {
      id: "book",
      sheetOrder: ["s"],
      sheets: { s: sheet },
    } as unknown as IWorkbookData,
  };
}

test("rendered image position includes its source anchor pixel offsets", () => {
  const { sheet, snapshot } = fixture();
  const { layout } = buildLayout(snapshot, sheet, "A1:E8");
  expect(layout.images?.[0]).toMatchObject({ x: 143, y: 51, w: 40, h: 30 });
});

test("flat shapes retain paint properties and offset position in the render layout", () => {
  const { sheet, snapshot, shape } = fixture();
  const out = buildLayout(snapshot, sheet, "A1:E8");
  expect(out.layout).toMatchObject({
    shapes: [{ x: 145, y: 53, w: 120, h: 60, shape }],
  });
  expect(out.limitations.join(" ")).toContain("复杂形状");
});

test("partially visible shapes keep negative clip coordinates and offscreen shapes are omitted", () => {
  const { sheet, snapshot } = fixture();
  const out = buildLayout(snapshot, sheet, "C3:E8");
  expect(out.layout).toMatchObject({ shapes: [{ x: -31, y: 5, w: 120, h: 60 }] });
  expect(buildLayout(snapshot, sheet, "F9:H12").layout).toMatchObject({ shapes: [] });
});

test("sheet default dimensions position cells and drawings consistently with explicit dimensions", () => {
  const { sheet, snapshot, shape } = fixture();
  sheet.defaultColumnWidth = 60;
  sheet.defaultRowHeight = 20;
  sheet.columnData = { 0: { w: 100 } };
  sheet.rowData = { 0: { h: 30 } };
  shape.anchor = "C3";
  const out = buildLayout(snapshot, sheet, "A1:E8");
  expect(out.layout).toMatchObject({
    width: 384,
    height: 192,
    shapes: [{ x: 217, y: 79 }],
  });
  expect(out.columns[1]?.w).toBe(60);
  expect(out.rows[1]?.h).toBe(20);
  expect(buildLayout(snapshot, sheet, "B2:E8").layout).toMatchObject({
    shapes: [{ x: 117, y: 49 }],
  });
});
