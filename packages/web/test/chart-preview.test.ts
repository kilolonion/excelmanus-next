import { expect, test, vi } from "vitest";
import { chartPreviewOption } from "../src/lib/workbook/chart-preview";

const cells = {
  0: { 0: { v: "地区" }, 1: { v: "金额" }, 2: { v: "利润" } },
  1: { 0: { v: "东" }, 1: { v: 10 }, 2: { v: 2 } },
  2: { 0: { v: "西" }, 1: { v: -5 }, 2: { v: 1 } },
  3: { 0: { v: "空" }, 1: { v: "" } },
};
const chart = {
  id: "c1",
  type: "column" as const,
  title: "地区",
  range: "A1:C4",
  anchor: "E2",
  width: 640,
  height: 360,
};
test("chart preview preserves signed values and missing data, reads live source cells", () => {
  const option = chartPreviewOption(chart, cells);
  expect("xAxis" in option ? option.xAxis : undefined).toMatchObject({
    type: "category",
    data: ["东", "西", "空"],
  });
  expect(option.series).toMatchObject([
    { name: "金额", type: "bar", data: [10, -5, null] },
    { name: "利润", data: [2, 1, null] },
  ]);
  const changed = structuredClone(cells);
  changed[1][1].v = 30;
  expect(chartPreviewOption(chart, changed).series).toMatchObject([{ data: [30, -5, null] }, {}]);
});
test("scatter uses numeric x and combo keeps last series as line", () => {
  expect(
    chartPreviewOption({ ...chart, type: "scatter", range: "B1:C3" }, cells).series,
  ).toMatchObject([
    {
      type: "scatter",
      data: [
        [10, 2],
        [-5, 1],
      ],
    },
  ]);
  expect(chartPreviewOption({ ...chart, type: "combo" }, cells).series).toMatchObject([
    { type: "bar" },
    { type: "line" },
  ]);
});

test("pie preview does not calculate unused series from additional columns", () => {
  const unused = vi.fn(() => 99);
  const option = chartPreviewOption(
    { ...chart, type: "pie" },
    {
      ...cells,
      1: {
        ...cells[1],
        2: {
          get v() {
            return unused();
          },
        },
      },
    },
  );
  expect(option.series).toMatchObject([
    {
      data: [
        { name: "东", value: 10 },
        { name: "西", value: -5 },
        { name: "空", value: 0 },
      ],
    },
  ]);
  expect(unused).not.toHaveBeenCalled();
});

test("scatter shares numeric x values across series without formatting unused categories", () => {
  const xReads = vi.fn();
  const invalidYReads = vi.fn(() => 5);
  const format = vi.fn(() => "not numeric");
  const source = {
    0: { 0: { v: "X" }, 1: { v: "A" }, 2: { v: "B" } },
    1: {
      0: {
        get v() {
          xReads();
          return -2;
        },
      },
      1: { v: 3 },
      2: { v: 4 },
    },
    2: {
      0: {
        get v() {
          xReads();
          return { toString: format };
        },
      },
      1: {
        get v() {
          return invalidYReads();
        },
      },
      2: {
        get v() {
          return invalidYReads();
        },
      },
    },
    3: {
      0: {
        get v() {
          xReads();
          return 0;
        },
      },
      1: { v: NaN },
      2: { v: -1 },
    },
  };
  const option = chartPreviewOption({ ...chart, type: "scatter" }, source);
  expect(option.series).toMatchObject([
    { data: [[-2, 3]] },
    {
      data: [
        [-2, 4],
        [0, -1],
      ],
    },
  ]);
  expect(xReads).toHaveBeenCalledTimes(3);
  expect(format).not.toHaveBeenCalled();
  expect(invalidYReads).not.toHaveBeenCalled();
});
