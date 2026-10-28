import { expect, test } from "vitest";
import { workbookShapeSource, workbookShapeSvg } from "../src/workbook-shape.ts";

const shape = { type: "rect", width: 80, height: 40, text: "<OK>&" } as const;

test("shape SVG escapes plain text and keeps absent fills transparent", () => {
  const svg = workbookShapeSvg(shape);
  expect(svg).toContain("&lt;OK&gt;&amp;");
  expect(svg).toContain('fill="none" stroke="none"');
  expect(decodeURIComponent(workbookShapeSource(shape).split(",").slice(1).join(","))).toBe(svg);
});

test("headless shape SVG rasterizes at requested pixel density without changing geometry", () => {
  const svg = workbookShapeSvg(shape, "DejaVu Sans", 2);
  expect(svg).toContain('width="160" height="80" viewBox="0 0 80 40"');
  expect(svg).toContain('x="40" y="20"');
});
