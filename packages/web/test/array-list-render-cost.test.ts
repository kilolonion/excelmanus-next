import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ index: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => {
    const arrays = [0, 2].map((row) => ({
      id: String(row),
      mode: "dynamic",
      formula: "=SEQUENCE(2)",
      range: { startRow: row, endRow: row + 1, startColumn: 0, endColumn: 0 },
    }));
    return [[true, arrays, null, "", ""][state.index++], vi.fn()];
  },
  useEffect: () => {},
}));
vi.mock("@/components/ui/overlay-card", () => ({
  OverlayCard: ({ children }: { children: ReactNode }) => children,
  OverlayCardBody: ({ children }: { children: ReactNode }) => children,
  OverlayCardHeader: () => null,
}));

import { ArrayFormulas } from "../src/components/excel/ArrayFormulas";

test("array list checks spill errors without saving the workbook for each row", () => {
  const data = { cellData: { 0: { 0: { v: "#SPILL!" } }, 2: { 0: { v: 1 } } } };
  const save = vi.fn(() => ({ sheets: { s: data } }));
  const api = {
    wb: {
      save,
      getId: () => "unit",
      getActiveSheet: () => ({
        getSheetId: () => "s",
        getSheetName: () => "Data",
        getSheet: () => ({ getSnapshot: () => data }),
      }),
    },
  };
  state.index = 0;
  const html = renderToString(
    createElement(ArrayFormulas, { api } as unknown as Parameters<typeof ArrayFormulas>[0]),
  );
  expect(html).toContain("A1:A2");
  expect(html).toContain("A3:A4");
  expect(html.match(/溢出被阻挡/g)).toHaveLength(1);
  expect(save).not.toHaveBeenCalled();
});
