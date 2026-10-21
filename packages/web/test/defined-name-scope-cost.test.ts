import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  index: 0,
  names: [] as Array<{
    id: string;
    name: string;
    formulaOrRefString: string;
    localSheetId: string;
  }>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [[true, h.names, null, false, ""][h.index++], vi.fn()],
  useEffect: () => {},
}));
vi.mock("@/components/ui/overlay-card", () => ({
  OverlayCard: ({ children }: { children: ReactNode }) => children,
  OverlayCardBody: ({ children }: { children: ReactNode }) => children,
  OverlayCardHeader: () => null,
}));

import { DefinedNames } from "../src/components/excel/DefinedNames";

beforeEach(() => {
  h.index = 0;
  h.names = [];
});
function render(sheets: Array<{ id: string; name: string }>) {
  h.index = 0;
  const api = {
    wb: {
      getSheets: () => sheets.map((s) => ({ getSheetId: () => s.id, getSheetName: () => s.name })),
    },
  };
  return renderToString(
    createElement(DefinedNames, { api } as unknown as Parameters<typeof DefinedNames>[0]),
  );
}
test("name scope labels avoid a complete sheet search for each name", () => {
  const sheets = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, name: `Sheet ${i}` }));
  h.names = sheets.map((s, i) => ({
    id: `n${i}`,
    name: `Name${i}`,
    formulaOrRefString: "A1",
    localSheetId: s.id,
  }));
  const original = Array.prototype.find;
  let comparisons = 0;
  const spy = vi.spyOn(Array.prototype, "find").mockImplementation(function (
    this: unknown[],
    predicate,
    thisArg,
  ) {
    const isSheets = this.length === 500 && (this[0] as { name?: string })?.name === "Sheet 0";
    return original.call(this, (value, index, list) => {
      if (isSheets) comparisons++;
      return predicate.call(thisArg, value, index, list);
    });
  });
  try {
    const html = render(sheets);
    expect(html).toContain("Sheet 499");
    expect(html).toContain("Name499");
    expect(comparisons).toBeLessThan(2000);
  } finally {
    spy.mockRestore();
  }
});
test("scope labels keep workbook fallback and read renamed sheets on the next render", () => {
  h.names = [
    { id: "a", name: "Local", formulaOrRefString: "A1", localSheetId: "s" },
    { id: "b", name: "Global", formulaOrRefString: "B1", localSheetId: "AllDefaultWorkbook" },
    { id: "c", name: "Unknown", formulaOrRefString: "C1", localSheetId: "gone" },
  ];
  expect(render([{ id: "s", name: "Before" }])).toContain("Before");
  const html = render([{ id: "s", name: "After" }]);
  expect(html).toContain("After");
  expect(html).not.toContain("Before");
  expect(html.match(/工作簿/g)).toHaveLength(2);
});
