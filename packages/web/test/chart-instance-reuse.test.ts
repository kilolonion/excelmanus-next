import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  effects: [] as Array<{ run: () => void | (() => void); deps: unknown[] }>,
  image: vi.fn(),
  init: vi.fn(),
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => {
    const i = mocks.refIndex++;
    if (!mocks.refs[i]) mocks.refs[i] = { current: value };
    return mocks.refs[i];
  },
  useState: (initial: unknown) => {
    const i = mocks.stateIndex++;
    if (!(i in mocks.states)) mocks.states[i] = initial;
    return [
      mocks.states[i],
      (value: unknown) => {
        mocks.states[i] = typeof value === "function" ? value(mocks.states[i]) : value;
      },
    ];
  },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    mocks.effects.push({ run, deps });
  },
}));
vi.mock("echarts/core", () => ({ init: mocks.init, use: vi.fn() }));
vi.mock("echarts/charts", () => ({ BarChart: {}, LineChart: {}, PieChart: {}, ScatterChart: {} }));
vi.mock("echarts/components", () => ({
  TitleComponent: {},
  TooltipComponent: {},
  LegendComponent: {},
  GridComponent: {},
}));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));
vi.mock("@/lib/backend/api", () => ({
  api: () => ({ getDocImage: mocks.image }),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: { getState: () => ({ workspaceId: "ws" }) },
}));

import { WorkbookObject } from "../src/components/excel/WorkbookObject";

const flush = () => new Promise((done) => setTimeout(done, 0));
const base = {
  id: "chart",
  type: "column",
  title: "test",
  range: "A1:B2",
  width: 200,
  height: 100,
};
let mounted: Array<{ deps: unknown[]; cleanup: void | (() => void) }> = [];
function render(
  value: number,
  width = 200,
  docId = "doc",
  title = base.title,
  stable?: Record<string, unknown>,
) {
  mocks.stateIndex = 0;
  mocks.refIndex = 0;
  mocks.effects = [];
  renderToString(
    createElement(WorkbookObject, {
      popup: {
        extraProps: {
          docId,
          sheetId: "sheet",
          chart: { ...base, width, title },
          cells: {
            0: { 0: { v: "name" }, 1: { v: "value" } },
            1: { 0: { v: "a" }, 1: { v: value } },
          },
          ...stable,
        },
      },
    }),
  );
  mocks.refs[0].current ??= {};
  mocks.effects.forEach((effect, i) => {
    if (mounted[i] && effect.deps.every((dep, index) => Object.is(dep, mounted[i].deps[index])))
      return;
    mounted[i]?.cleanup?.();
    mounted[i] = { deps: effect.deps, cleanup: effect.run() };
  });
}
function close() {
  for (const effect of mounted) effect.cleanup?.();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.refs = [];
  mounted = [];
  mocks.image.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  mocks.init.mockReturnValue({
    setOption: mocks.setOption,
    resize: mocks.resize,
    dispose: mocks.dispose,
  });
});
test("chart data updates reuse the instance while replacing options and resizing when needed", async () => {
  render(1);
  await flush();
  render(2);
  await flush();
  expect(mocks.init).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(mocks.setOption.mock.lastCall?.[0].series[0].data).toEqual([2]);
  expect(mocks.setOption.mock.lastCall?.[1]).toEqual({ notMerge: true });
  render(3, 300);
  await flush();
  expect(mocks.init).toHaveBeenCalledTimes(1);
  expect(mocks.resize).toHaveBeenCalledTimes(1);
  close();
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
});
test("closing before chart modules settle skips initialization", async () => {
  render(1);
  close();
  await flush();
  expect(mocks.init).not.toHaveBeenCalled();
});

test("switching documents disposes the old chart instance", async () => {
  render(1, 200, "old");
  await flush();
  render(2, 200, "new");
  await flush();
  expect(mocks.init).toHaveBeenCalledTimes(2);
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
  close();
  expect(mocks.dispose).toHaveBeenCalledTimes(2);
});
test("a failed chart update releases its instance and retry creates a fresh one", async () => {
  render(1);
  await flush();
  mocks.setOption.mockImplementationOnce(() => {
    throw new Error("render failed");
  });
  render(2);
  await flush();
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.states).toContain("render failed");
  mocks.states[2] = 1;
  render(2);
  await flush();
  expect(mocks.init).toHaveBeenCalledTimes(2);
  close();
  expect(mocks.dispose).toHaveBeenCalledTimes(2);
});

test("unrelated refreshes do not submit identical chart options again", async () => {
  render(1);
  await flush();
  render(1);
  await flush();
  render(1, 300);
  await flush();
  expect(mocks.setOption).toHaveBeenCalledTimes(1);
  expect(mocks.resize).toHaveBeenCalledTimes(1);
  render(2, 300);
  await flush();
  expect(mocks.setOption).toHaveBeenCalledTimes(2);
  render(2, 300, "doc", "Renamed chart");
  await flush();
  expect(mocks.setOption).toHaveBeenCalledTimes(3);
  expect(mocks.setOption.mock.lastCall?.[0].title.text).toBe("Renamed chart");
  close();
});

test("cell revision updates charts even when metadata and live cell map retain identity", async () => {
  const stable = {
    chart: base,
    cells: { 0: { 0: { v: "name" }, 1: { v: "value" } }, 1: { 0: { v: "a" }, 1: { v: 1 } } },
    revision: 1,
  };
  render(1, 200, "doc", base.title, stable);
  await flush();
  stable.cells[1][1].v = 9;
  stable.revision = 2;
  render(1, 200, "doc", base.title, stable);
  await flush();
  expect(mocks.init).toHaveBeenCalledTimes(1);
  expect(mocks.setOption.mock.lastCall?.[0].series[0].data).toEqual([9]);
  close();
});

test("ordinary cell revisions retain loaded image bytes while image replacement reloads", async () => {
  const image = { id: "image", title: "QA", width: 100, height: 100 };
  const stable = { chart: undefined, cells: undefined, image, revision: 1 };
  render(0, 200, "doc", base.title, stable);
  await flush();
  stable.revision = 2;
  render(0, 200, "doc", base.title, stable);
  await flush();
  expect(mocks.image).toHaveBeenCalledTimes(1);
  stable.image = { ...image };
  render(0, 200, "doc", base.title, stable);
  await flush();
  expect(mocks.image).toHaveBeenCalledTimes(2);
  close();
});
