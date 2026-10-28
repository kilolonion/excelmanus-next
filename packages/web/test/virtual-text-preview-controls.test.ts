import { createElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  effects: [] as (() => void)[],
  writes: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => (h.slots[h.index++] ??= { current: value }),
  useState: (value: unknown) => {
    const i = h.index++;
    if (!(i in h.slots)) h.slots[i] = value;
    return [
      h.slots[i],
      (next: any) => {
        h.writes.push(next);
        h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next;
      },
    ];
  },
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const i = h.index++,
      prior = h.slots[i];
    if (!prior || deps.some((d, j) => !Object.is(d, prior.deps[j])))
      h.slots[i] = { deps, value: factory() };
    return h.slots[i].value;
  },
  useLayoutEffect: (effect: () => void, deps: unknown[]) => {
    const i = h.index++,
      prior = h.slots[i];
    if (!prior || deps.some((d, j) => !Object.is(d, prior[j]))) h.effects.push(effect);
    h.slots[i] = deps;
  },
}));

import { VirtualTextPreview } from "../src/components/chat/VirtualTextPreview";

function nodes(node: any, type: string): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
const row = vi.fn((i: number) =>
  createElement("tr", { "data-row": i }, createElement("td", null, `line ${i}`)),
);
let el: { scrollTop: number; scrollHeight: number; clientHeight: number };
function render(
  count = 10000,
  version: unknown = count,
  initialScroll?: { following: boolean; rowOffset: number },
) {
  h.index = 0;
  const tree = VirtualTextPreview({
    count,
    initialScroll,
    columns: 2,
    height: 160,
    expandedHeight: 400,
    contentVersion: version,
    copies: [{ label: "复制完整内容", text: "完整\n内容" }],
    renderRow: row,
  });
  const region = nodes(tree, "div").find((n) => n.props.role === "region");
  region.props.ref.current = el;
  for (const effect of h.effects.splice(0)) effect();
  return {
    tree,
    region,
    indices: nodes(tree, "tr")
      .filter((n) => n.props["data-row"] !== undefined)
      .map((n) => n.props["data-row"]),
  };
}
function button(tree: any, label: string) {
  return nodes(tree, "button").find((n) => n.props.children === label);
}
beforeEach(() => {
  h.slots = [];
  h.writes = [];
  row.mockClear();
  h.effects = [];
  h.index = 0;
  el = { scrollTop: 0, scrollHeight: 200000, clientHeight: 160 };
});
test("initial tail, upward reading, append while paused, and returning to bottom", () => {
  const first = render();
  expect(first.indices.at(-1)).toBe(9999);
  expect(first.indices.length).toBeLessThan(30);
  first.region.props.onWheelCapture({ deltaY: -1 });
  el.scrollTop = 200;
  first.region.props.onScroll({ currentTarget: el });
  const up = render();
  expect(up.indices[0]).toBe(4);
  el.scrollHeight += 20;
  const appended = render(10001);
  expect(el.scrollTop).toBe(200);
  expect(appended.indices[0]).toBe(4);
  el.scrollTop = el.scrollHeight - el.clientHeight;
  appended.region.props.onScroll({ currentTarget: el });
  el.scrollHeight += 20;
  expect(render(10002).indices.at(-1)).toBe(10001);
  expect(el.scrollTop).toBe(el.scrollHeight);
});
test("full view renders every line, starts at top, preserves reading and returns to live tail", () => {
  const first = render();
  button(first.tree, "查看完整内容").props.onClick();
  const full = render();
  expect(full.indices).toHaveLength(10000);
  expect(el.scrollTop).toBe(0);
  el.scrollTop = 300;
  full.region.props.onScroll({ currentTarget: el });
  render(10001);
  expect(el.scrollTop).toBe(300);
  button(full.tree, "返回流式预览").props.onClick();
  const virtual = render(10001);
  expect(virtual.indices.length).toBeLessThan(30);
  expect(virtual.indices.at(-1)).toBe(10000);
});
test("expansion changes visible capacity; copying includes all text rather than visible rows", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  try {
    const first = render();
    button(first.tree, "展开更大区域").props.onClick();
    const expanded = render();
    expect(expanded.region.props.style.height).toBe(400);
    expect(expanded.indices.length).toBeGreaterThan(first.indices.length);
    await button(expanded.tree, "复制完整内容").props.onClick();
    expect(copy).toHaveBeenCalledWith("完整\n内容");
    expect(JSON.stringify(render().tree)).toContain("已复制");
    copy.mockRejectedValueOnce(new Error("denied"));
    await button(expanded.tree, "复制完整内容").props.onClick();
    expect(JSON.stringify(render().tree)).toContain("复制失败");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("crossing into virtual rendering preserves the earlier reading row", () => {
  const view = render(401, 401, { following: false, rowOffset: 20 });
  expect(el.scrollTop).toBe(400);
  expect(view.indices[0]).toBe(14);
  expect(render(402).indices[0]).toBe(14);
  expect(el.scrollTop).toBe(400);
});

test("scrolling full content does not schedule state updates or rebuild all rows", () => {
  const first = render();
  button(first.tree, "查看完整内容").props.onClick();
  const full = render();
  row.mockClear();
  h.writes = [];
  for (let i = 1; i <= 60; i++) {
    el.scrollTop = i * 10;
    full.region.props.onScroll({ currentTarget: el });
  }
  expect(h.writes).toEqual([]);
  render();
  expect(row.mock.calls.length).toBe(0);
});
test("scrolling within the same virtual row window reuses rows but crossing it refreshes", () => {
  const first = render(10000, 1, { following: false, rowOffset: 10.05 });
  row.mockClear();
  el.scrollTop = 202;
  first.region.props.onScroll({ currentTarget: el });
  render(10000, 1);
  expect(row.mock.calls.length).toBe(0);
  el.scrollTop = 240;
  first.region.props.onScroll({ currentTarget: el });
  const moved = render(10000, 1);
  expect(row).toHaveBeenCalled();
  expect(moved.indices[0]).toBe(6);
});
test("copy feedback reuses full rows while changed content with the same line count refreshes", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  try {
    const first = render(10000, 1);
    button(first.tree, "查看完整内容").props.onClick();
    const full = render(10000, 1);
    row.mockClear();
    await button(full.tree, "复制完整内容").props.onClick();
    render(10000, 1);
    expect(row.mock.calls.length).toBe(0);
    render(10000, 2);
    expect(row).toHaveBeenCalledTimes(10000);
  } finally {
    vi.unstubAllGlobals();
  }
});
