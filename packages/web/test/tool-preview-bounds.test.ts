import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PublishPlan, ValuesGrid, WorkbookReadResult } from "../src/components/chat/tool-results";

test("table previews only read displayed rows while preserving the total count", () => {
  let reads = 0;
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    get value() {
      reads++;
      return `ROW_${i}_END`;
    },
  }));
  const html = renderToStaticMarkup(
    createElement(WorkbookReadResult, { data: { mode: "table", columns: ["value"], rows } }),
  );
  expect(reads).toBe(50);
  expect(html).toContain("1000 行 × 1 列");
  expect(html).toContain("ROW_49_END");
  expect(html).not.toContain("ROW_50_END");
});

test("range cells format their value once for both tooltip and visible text", () => {
  let formats = 0;
  const value = {
    toJSON() {
      formats++;
      return { value: 42 };
    },
  };
  const html = renderToStaticMarkup(
    createElement(ValuesGrid, { range: "B3:B3", values: [[value]], formulas: [["=A1"]] }),
  );
  expect(formats).toBe(1);
  expect(html).toContain("=A1\n= {&quot;value&quot;:42}");
  expect(html).toContain("B</th>");
  expect(html).toContain("{&quot;value&quot;:42}</td>");
});

test("table cells format their value once for tooltip and text", () => {
  let formats = 0;
  const value = {
    toJSON() {
      formats++;
      return { value: 7 };
    },
  };
  const html = renderToStaticMarkup(
    createElement(WorkbookReadResult, {
      data: { mode: "table", columns: ["value"], rows: [{ value }], total: 1234 },
    }),
  );
  expect(formats).toBe(1);
  expect(html).toContain("1234 行 × 1 列");
  expect(html).toContain("{&quot;value&quot;:7}</td>");
});

test("publish previews convert only the three displayed range labels", () => {
  let conversions = 0;
  const ranges = Array.from({ length: 1000 }, (_, i) => ({
    toString() {
      conversions++;
      return `Sheet1!A${i + 1}`;
    },
  }));
  const html = renderToStaticMarkup(
    createElement(PublishPlan, {
      items: [{ kind: "workbook", path: "book.xlsx", opsCount: 1000, changes: { ranges } }],
    }),
  );
  expect(conversions).toBe(3);
  expect(html).toContain("Sheet1!A1、Sheet1!A2、Sheet1!A3");
  expect(html).not.toContain("Sheet1!A4");
  expect(html).toContain("1000 项操作");
});
