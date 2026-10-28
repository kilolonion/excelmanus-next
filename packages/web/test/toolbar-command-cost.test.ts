import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
  setters: [] as ReturnType<typeof vi.fn>[],
  refs: [] as Array<{ current: unknown }>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => undefined | (() => void)) => h.effects.push(effect),
  useLayoutEffect: () => {},
  useRef: (value: unknown) => {
    const ref = { current: value };
    h.refs.push(ref);
    return ref;
  },
  useState: (value: unknown) => {
    const set = vi.fn();
    h.setters.push(set);
    return [typeof value === "function" ? value() : value, set];
  },
}));

import { FormatToolbar, type SheetApi } from "../src/components/excel/FormatToolbar";
import { WorkbookZoom } from "../src/components/excel/WorkbookZoom";

let frames: Map<number, FrameRequestCallback>, serial: number;
beforeEach(() => {
  h.effects = [];
  h.refs = [];
  h.setters = [];
  frames = new Map();
  serial = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn: FrameRequestCallback) => {
      frames.set(++serial, fn);
      return serial;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
});
afterEach(() => vi.unstubAllGlobals());
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn(0);
}
function mount(kind: "format" | "zoom") {
  let notify!: (command: { id: string }) => void;
  let style = { bl: 0 },
    zoom = 1;
  const readStyle = vi.fn(() => style),
    readZoom = vi.fn(() => zoom),
    dispose = vi.fn();
  const api = {
    wb: {
      getActiveSheet: () => ({
        getZoom: readZoom,
        getSelection: () => ({
          getActiveRange: () => ({
            getCellStyleData: readStyle,
            getRange: () => ({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }),
            isPartOfMerge: () => false,
          }),
        }),
      }),
      onCommandExecuted: (fn: typeof notify) => {
        notify = fn;
        return { dispose };
      },
    },
  } as unknown as SheetApi;
  if (kind === "format") FormatToolbar({ api, csv: true });
  else WorkbookZoom({ api, ready: 1 });
  const close = h.effects[0]();
  flush();
  readStyle.mockClear();
  readZoom.mockClear();
  vi.mocked(requestAnimationFrame).mockClear();
  vi.mocked(cancelAnimationFrame).mockClear();
  h.setters.forEach((s) => {
    s.mockClear();
  });
  return {
    notify: (id: string) => notify({ id }),
    close,
    readStyle,
    readZoom,
    dispose,
    style: (bl: number) => {
      style = { bl };
    },
    zoom: (v: number) => {
      zoom = v;
    },
  };
}
test("scroll notifications do not schedule format reads", () => {
  const p = mount("format");
  for (let i = 0; i < 100; i++) p.notify("sheet.operation.set-scroll");
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  flush();
  expect(p.readStyle).not.toHaveBeenCalled();
  p.close?.();
});
test("a mutation burst schedules one format read using the latest selection style", () => {
  const p = mount("format");
  for (let i = 0; i < 100; i++) p.notify("sheet.mutation.set-range-values");
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  expect(cancelAnimationFrame).not.toHaveBeenCalled();
  p.style(1);
  flush();
  expect(p.readStyle).toHaveBeenCalledTimes(1);
  expect(h.setters[0]).toHaveBeenLastCalledWith(expect.objectContaining({ bold: true }));
  p.notify("sheet.operation.set-selections");
  flush();
  expect(p.readStyle).toHaveBeenCalledTimes(2);
  p.close?.();
});
test("scroll and selection bursts do not repeatedly read zoom", () => {
  const p = mount("zoom");
  for (let i = 0; i < 100; i++) {
    p.notify("sheet.operation.set-scroll");
    p.notify("sheet.operation.set-selections");
  }
  flush();
  expect(p.readZoom).not.toHaveBeenCalled();
  p.close?.();
});
test("zoom and sheet switches share one frame and publish the final active zoom", () => {
  const p = mount("zoom");
  for (let i = 0; i < 100; i++) p.notify("sheet.operation.set-zoom-ratio");
  p.zoom(1.5);
  p.notify("sheet.operation.set-worksheet-active");
  expect(p.readZoom).not.toHaveBeenCalled();
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  flush();
  expect(p.readZoom).toHaveBeenCalledTimes(1);
  expect(h.setters[0]).toHaveBeenLastCalledWith(150);
  expect(h.setters[1]).toHaveBeenLastCalledWith("150%");
  p.close?.();
});
test.each(["format", "zoom"] as const)("closing %s cancels its pending read", (kind) => {
  const p = mount(kind);
  p.notify("sheet.mutation.set-range-values");
  p.close?.();
  flush();
  expect(p.readStyle).not.toHaveBeenCalled();
  expect(p.readZoom).not.toHaveBeenCalled();
  expect(p.dispose).toHaveBeenCalledTimes(1);
});

test("queued zoom refresh preserves an in-progress percentage draft", () => {
  const p = mount("zoom");
  h.refs[0].current = true;
  p.zoom(2);
  p.notify("sheet.operation.set-zoom-ratio");
  flush();
  expect(h.setters[0]).toHaveBeenLastCalledWith(200);
  expect(h.setters[1]).not.toHaveBeenCalled();
  p.close?.();
});
test("format reads with unchanged values do not update React state", () => {
  const p = mount("format");
  p.notify("sheet.operation.set-selections");
  flush();
  expect(p.readStyle).toHaveBeenCalledTimes(1);
  expect(h.setters[0]).not.toHaveBeenCalled();
  p.close?.();
});

test("mobile format shows named groups directly instead of width-based overflow", () => {
  type Node = { type: unknown; props: Record<string, any> };
  const walk = (value: unknown): Node[] => {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (!value || typeof value !== "object") return [];
    const node = value as Node;
    return [node, ...walk(node.props?.children)];
  };
  const tree = walk(FormatToolbar({ api: null, csv: false, mobile: true }));
  expect(tree[0].props["aria-label"]).toBe("手机格式工具");
  expect(tree.filter((n) => n.type === "h4").map((n) => n.props.children)).toEqual([
    "撤销与重做",
    "字体与字号",
    "文字样式",
    "文字与填充颜色",
    "对齐与换行",
    "数字格式",
    "边框与合并",
    "清除格式",
  ]);
  expect(tree.some((n) => n.props?.["aria-label"] === "更多格式")).toBe(false);
  expect(tree.filter((n) => n.type === "details")).toHaveLength(1);
  const csv = walk(FormatToolbar({ api: null, csv: true, mobile: true }));
  expect(csv.filter((n) => n.type === "h4").map((n) => n.props.children)).toEqual(["撤销与重做"]);
  expect(csv.filter((n) => n.type === "details")).toHaveLength(0);
});
