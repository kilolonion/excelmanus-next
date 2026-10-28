import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { WorkbookObject } from "../src/components/excel/WorkbookObject";
import { printObjectLayout } from "../src/lib/workbook/print-objects";

const shape = {
  id: "shape",
  type: "rect",
  title: "测试矩形",
  text: "<OK>",
  anchor: "B2",
  width: 160,
  height: 60,
  offsetX: 13,
  offsetY: 7,
  fill: "#4472C4",
  stroke: "#2F528F",
  textColor: "#FFFFFF",
};

test("workbook overlay renders an embedded shape without requiring an image fetch", () => {
  const html = renderToString(createElement(WorkbookObject, { popup: { extraProps: { shape } } }));
  expect(html).toContain('data-em-workbook-object="shape"');
  expect(html).toContain("data:image/svg+xml");
  expect(html).toContain('alt="测试矩形"');
});

test("print projection includes flat shapes and image offsets in both position and extent", () => {
  const sheet = {
    cellData: { 0: { 0: { v: "x" } } },
    defaultColumnWidth: 80,
    defaultRowHeight: 20,
    custom: {
      excelmanusObjects: {
        charts: [],
        images: [
          {
            id: "image",
            title: "图",
            anchor: "B2",
            width: 160,
            height: 60,
            offsetX: 11,
            offsetY: 5,
            mediaType: "image/png",
          },
        ],
        shapes: [shape],
      },
    },
  };
  const out = printObjectLayout(sheet);
  expect(out.objects).toHaveLength(2);
  expect(out.objects[0]).toMatchObject({ left: 91, top: 25 });
  expect(out.objects[1]).toMatchObject({ left: 93, top: 27, object: shape });
  expect(out.range.endColumn).toBe(3);
  expect(out.range.endRow).toBe(4);
});
