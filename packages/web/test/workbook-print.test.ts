import { expect, test } from "vitest";
import { buildPrintHtml } from "../src/lib/workbook/print";

test("print pages preserve merged text, dimensions and escaped content", () => {
  const sheet = {
    id: "s",
    name: "测试",
    rowCount: 3,
    columnCount: 3,
    cellData: {
      0: { 0: { v: "<script>你好</script>", s: { bl: 1, bg: { rgb: "#00ff00" } } } },
      1: { 0: { v: "hidden" } },
      2: { 1: { v: 12 } },
    },
    rowData: { 1: { hd: 1 } },
    columnData: { 0: { w: 120 } },
    mergeData: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }],
  };
  const html = buildPrintHtml({
    sheet,
    styles: {},
    range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
    display: [
      ["<script>你好</script>", ""],
      ["hidden", ""],
      ["", "12.00"],
    ],
    orientation: "portrait",
    title: "QA",
  });
  expect(html).toContain('colspan="2"');
  expect(html).toContain("&lt;script&gt;你好&lt;/script&gt;");
  expect(html).not.toContain(">hidden<");
  expect(html).toContain("12.00");
  expect(html).toContain("120px");
  expect(html).toContain("A4 portrait");
});

test("print includes borders and evaluated conditional format without exposing hidden values", () => {
  const html = buildPrintHtml({
    sheet: {
      cellData: { 0: { 0: { v: 42, s: { bd: { b: { s: 7, cl: { rgb: "#ff0000" } } } } } } },
    },
    styles: {},
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    display: [["42"]],
    orientation: "portrait",
    title: "QA",
    effects: {
      "0:0": {
        style: { bg: { rgb: "#00ff00" } },
        isShowValue: false,
        dataBar: {
          color: "#112233",
          value: 60,
          startPoint: 0,
          isGradient: false,
          isShowValue: false,
        },
      },
    },
  });
  expect(html).toContain("border-bottom:3px double #ff0000");
  expect(html).toContain("background:#00ff00");
  expect(html).toContain("width:60%");
  expect(html).not.toContain(">42<");
});

test("print paginates tall object layers and clips them to the exported rectangle", () => {
  const html = buildPrintHtml({
    sheet: { rowData: { 0: { h: 1500 } } },
    styles: {},
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    display: [["text"]],
    orientation: "portrait",
    title: "QA",
    objects: [
      {
        left: 10,
        top: 900,
        width: 70,
        height: 400,
        src: "data:image/png;base64,AA==",
        title: "<image>",
      },
    ],
  });
  expect(html.match(/class="print-page"/g)?.length).toBe(2);
  expect(html).toContain("data:image/png;base64,AA==");
  expect(html).toContain('alt="&lt;image&gt;"');
  expect(html).toContain("overflow:hidden");
});

test("object layout extends whole-sheet printing, while selection excludes unrelated objects", async () => {
  const { printObjectLayout } = await import("../src/lib/workbook/print-objects");
  const sheet = {
    cellData: { 0: { 0: { v: "x" } } },
    defaultColumnWidth: 100,
    defaultRowHeight: 25,
    custom: {
      excelmanusObjects: {
        charts: [],
        images: [
          {
            id: "img",
            title: "photo",
            anchor: "C3",
            width: 200,
            height: 100,
            mediaType: "image/png",
          },
        ],
      },
    },
  };
  const all = printObjectLayout(sheet);
  expect(all.range.endColumn).toBe(3);
  expect(all.range.endRow).toBe(5);
  expect(all.objects[0]).toMatchObject({ left: 200, top: 50 });
  const selected = printObjectLayout(sheet, {
    startRow: 0,
    endRow: 0,
    startColumn: 0,
    endColumn: 0,
  });
  expect(selected.objects).toHaveLength(0);
});

test("print preserves engine RGB color-scale output", () => {
  const html = buildPrintHtml({
    sheet: {},
    styles: {},
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    display: [["1"]],
    orientation: "portrait",
    title: "QA",
    effects: { "0:0": { style: { bg: { rgb: "rgb(128, 255, 0)" } } } },
  });
  expect(html).toContain("background:rgb(128, 255, 0)");
});

test("print keeps dot-dash borders distinct from dashed borders", () => {
  const html = buildPrintHtml({
    sheet: {
      cellData: { 0: { 0: { v: "a", s: { bd: { t: { s: 5, cl: { rgb: "#ff0000" } } } } } } },
    },
    styles: {},
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    display: [["a"]],
    orientation: "portrait",
    title: "QA",
  });
  expect(html).toContain('stroke-dasharray="6 3 1 3"');
  expect(html).toContain('stroke="#ff0000"');
});
