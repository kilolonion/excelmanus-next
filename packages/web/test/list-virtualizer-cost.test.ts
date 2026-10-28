import type { FileEntry } from "@excelmanus/protocol";
import type { Virtualizer, VirtualizerOptions } from "@tanstack/react-virtual";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  mi: 0,
  states: [] as unknown[],
  si: 0,
  refs: [] as Array<{ current: unknown }>,
  ri: 0,
  virtual: null as Virtualizer<Element, Element> | null,
  estimates: 0,
  visible: null as number[] | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = hooks.mi++,
      old = hooks.memos[i];
    if (old && deps.length === old.deps.length && deps.every((v, j) => Object.is(v, old.deps[j])))
      return old.value;
    const value = fn();
    hooks.memos[i] = { deps, value };
    return value;
  };
  return {
    ...react,
    memo: (fn: unknown) => fn,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useEffect: () => {},
    useRef: (value: unknown) => (hooks.refs[hooks.ri++] ??= { current: value }),
    useState: (initial: unknown) => {
      const i = hooks.si++;
      if (!(i in hooks.states))
        hooks.states[i] = typeof initial === "function" ? initial() : initial;
      return [
        hooks.states[i],
        (v: unknown) => {
          hooks.states[i] = typeof v === "function" ? v(hooks.states[i]) : v;
        },
      ];
    },
  };
});
vi.mock("@tanstack/react-virtual", async (original) => {
  const actual = await original<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (options: VirtualizerOptions<Element, Element>) => {
      const next = {
        ...options,
        scrollToFn: () => {},
        observeElementRect: () => {},
        observeElementOffset: () => {},
        estimateSize: (i: number) => {
          hooks.estimates++;
          return options.estimateSize(i);
        },
      };
      if (!hooks.virtual) hooks.virtual = new actual.Virtualizer(next);
      else hooks.virtual.setOptions(next);
      hooks.virtual.getTotalSize();
      if (hooks.visible) {
        vi.spyOn(hooks.virtual, "getVirtualItems").mockImplementation(() =>
          (hooks.visible ?? []).map((index) => ({
            index,
            key: options.getItemKey?.(index) ?? index,
            start: index * 44,
            end: (index + 1) * 44,
            size: 44,
            lane: 0,
          })),
        );
      }
      return hooks.virtual;
    },
  };
});
vi.mock("@/stores/session-store", async (original) => {
  const actual = await original<typeof import("../src/stores/session-store")>();
  return {
    ...actual,
    useSessionStore: Object.assign(
      (select: (s: unknown) => unknown) => select(actual.useSessionStore.getState()),
      actual.useSessionStore,
    ),
  };
});
vi.mock("@/stores/app-store", async (original) => {
  const actual = await original<typeof import("../src/stores/app-store")>();
  return {
    ...actual,
    useAppStore: Object.assign(
      (select: (s: unknown) => unknown) => select(actual.useAppStore.getState()),
      actual.useAppStore,
    ),
  };
});
vi.mock("@/stores/chat-store", async (original) => {
  const actual = await original<typeof import("../src/stores/chat-store")>();
  return {
    ...actual,
    useChatStore: Object.assign(
      (select: (s: unknown) => unknown) => select(actual.useChatStore.getState()),
      actual.useChatStore,
    ),
  };
});
vi.mock("@/stores/files-store", async (original) => {
  const actual = await original<typeof import("../src/stores/files-store")>();
  return {
    ...actual,
    useFilesStore: Object.assign(
      (select: (s: unknown) => unknown) => select(actual.useFilesStore.getState()),
      actual.useFilesStore,
    ),
  };
});
vi.mock("@/stores/ui-store", async (original) => {
  const actual = await original<typeof import("../src/stores/ui-store")>();
  return {
    ...actual,
    useUIStore: Object.assign(
      (select: (s: unknown) => unknown) => select(actual.useUIStore.getState()),
      actual.useUIStore,
    ),
  };
});
vi.mock("@/stores/workbook-store", async (original) => {
  const actual = await original<typeof import("../src/stores/workbook-store")>();
  return {
    ...actual,
    useWorkbookStore: Object.assign(
      (select: (s: unknown) => unknown) => select(actual.useWorkbookStore.getState()),
      actual.useWorkbookStore,
    ),
  };
});

import { CommandPopover, type PopoverItem } from "../src/components/chat/CommandPopover";
import { OpenWorkbookDialog } from "../src/components/excel/OpenWorkbookDialog";
import { FlatFileListView } from "../src/components/sidebar/FlatFileListView";
import { SessionList } from "../src/components/sidebar/SessionList";
import { useAppStore } from "../src/stores/app-store";
import { useSessionStore } from "../src/stores/session-store";
import { useUIStore } from "../src/stores/ui-store";

const files: FileEntry[] = Array.from({ length: 200 }, (_, i) => ({
  kind: "file",
  name: `file${i}.xlsx`,
  path: `file${i}.xlsx`,
}));
function render<T>(fn: () => T): T {
  hooks.mi = 0;
  hooks.si = 0;
  hooks.ri = 0;
  return fn();
}
beforeEach(() => {
  hooks.memos = [];
  hooks.states = [];
  hooks.refs = [];
  hooks.virtual = null;
  hooks.estimates = 0;
  hooks.visible = null;
});

test("file selection changes reuse measurements; reordered files and pinned rows still update", () => {
  const props = {
    files,
    sort: "name" as const,
    marks: new Map(),
    openPaths: new Set<string>(),
    selectedPaths: new Set<string>(),
    selectMode: false,
    scrollRef: { current: null },
    onOpen() {},
    onInfo() {},
    dragEntries: (f: FileEntry) => [f],
  };
  render(() => FlatFileListView(props));
  expect(hooks.estimates).toBe(200);
  hooks.estimates = 0;
  props.selectedPaths = new Set([files[1].path]);
  props.selectMode = true;
  render(() => FlatFileListView(props));
  expect(hooks.estimates).toBe(0);
  hooks.states[0] = files[199].path;
  render(() => FlatFileListView(props));
  expect(
    hooks.virtual?.options.rangeExtractor?.({
      startIndex: 0,
      endIndex: 2,
      overscan: 0,
      count: 200,
    }),
  ).toContain(199);
  props.files = files.slice(1);
  render(() => FlatFileListView(props));
  expect(hooks.virtual?.options.getItemKey?.(0)).toBe(files[1].path);
});

test("command keyboard selection does not remeasure every candidate", () => {
  const items: PopoverItem[] = files.map((f) => ({
    command: f.path,
    description: f.name,
    icon: null,
  }));
  const props = {
    popover: "at-sub" as const,
    popoverItems: items,
    selectedIndex: 0,
    setSelectedIndex() {},
    selectPopoverItem() {},
    popoverRef: { current: null },
    activeSlashCmd: null,
    atCategory: "文件",
    onBackToSlash() {},
    onBackToAt() {},
  };
  render(() => CommandPopover(props));
  expect(hooks.estimates).toBe(200);
  hooks.estimates = 0;
  props.selectedIndex = 1;
  render(() => CommandPopover(props));
  expect(hooks.estimates).toBe(0);
  props.popoverItems = items.slice(1);
  render(() => CommandPopover(props));
  expect(hooks.virtual?.options.getItemKey?.(0)).toBe(files[1].path);
});

test("workbook picker opening status keeps candidate measurements; search updates keys", () => {
  useUIStore.setState({ workbookPicker: "panel" });
  hooks.states = [files, "workspace", "", false, null, null, 0];
  render(() => OpenWorkbookDialog());
  expect(hooks.estimates).toBe(200);
  hooks.estimates = 0;
  hooks.states[5] = "正在打开 file1.xlsx…";
  render(() => OpenWorkbookDialog());
  expect(hooks.estimates).toBe(0);
  hooks.states[2] = "file199";
  render(() => OpenWorkbookDialog());
  expect(hooks.virtual?.options.count).toBe(1);
  expect(hooks.virtual?.options.getItemKey?.(0)).toBe("file199.xlsx");
});

test("session row menu and edit text reuse measurements; search and pinned row remain current", () => {
  useAppStore.setState({ workspaces: [{ id: "w", name: "W", path: "/w" }] as never });
  useSessionStore.setState({
    sessions: Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      workspaceId: "w",
      title: `session${i}`,
    })) as never,
    order: { sessions: {}, collapsed: [] },
  });
  const show = () => render(() => SessionList({}));
  show();
  expect(hooks.estimates).toBe(201);
  hooks.estimates = 0;
  hooks.states[9] = "s199";
  show();
  expect(hooks.estimates).toBe(0);
  expect(
    hooks.virtual?.options.rangeExtractor?.({
      startIndex: 0,
      endIndex: 2,
      overscan: 0,
      count: 201,
    }),
  ).toContain(200);
  hooks.states[3] = "new edit text";
  show();
  expect(hooks.estimates).toBe(0);
  hooks.states[1] = "session199";
  show();
  expect(hooks.virtual?.options.count).toBe(2);
  expect(hooks.virtual?.options.getItemKey?.(1)).toBe("w:s199");
});

test("session grouping reads each workspace membership once regardless of workspace count", () => {
  let reads = 0;
  useAppStore.setState({
    workspaces: Array.from({ length: 40 }, (_, i) => ({
      id: `w${i}`,
      name: `W${i}`,
      path: `/w${i}`,
    })) as never,
  });
  useSessionStore.setState({
    sessions: Array.from({ length: 400 }, (_, i) => ({
      id: `s${i}`,
      title: `S${i}`,
      get workspaceId() {
        reads++;
        return `w${i % 40}`;
      },
    })) as never,
    order: { sessions: {}, collapsed: [] },
  });
  render(() => SessionList({}));
  expect(reads).toBe(400);
  expect(hooks.virtual?.options.count).toBe(440);
  expect(hooks.virtual?.options.getItemKey?.(1)).toBe("w0:s0");
  expect(hooks.virtual?.options.getItemKey?.(2)).toBe("w0:s40");
});

test("session menu changes look up pinned rows without scanning all session ids", () => {
  let reads = 0;
  useAppStore.setState({ workspaces: [{ id: "w", name: "W", path: "/w" }] as never });
  useSessionStore.setState({
    sessions: Array.from({ length: 400 }, (_, i) => ({
      get id() {
        reads++;
        return `s${i}`;
      },
      title: `S${i}`,
      workspaceId: "w",
    })) as never,
    order: { sessions: {}, collapsed: [] },
  });
  render(() => SessionList({}));
  reads = 0;
  hooks.states[9] = "s399";
  render(() => SessionList({}));
  expect(reads).toBe(0);
  expect(
    hooks.virtual?.options.rangeExtractor?.({
      startIndex: 0,
      endIndex: 2,
      overscan: 0,
      count: 401,
    }),
  ).toContain(400);
  hooks.states[9] = null;
  render(() => SessionList({}));
  expect(
    hooks.virtual?.options.rangeExtractor?.({
      startIndex: 0,
      endIndex: 2,
      overscan: 0,
      count: 401,
    }),
  ).not.toContain(400);
});

test("session grouping retains workspace order, saved order, new items and orphan order", () => {
  useAppStore.setState({
    workspaces: [
      { id: "b", name: "B", path: "/b" },
      { id: "a", name: "A", path: "/a" },
    ] as never,
  });
  useSessionStore.setState({
    sessions: [
      { id: "old", workspaceId: "a", title: "Old" },
      { id: "orphan1", workspaceId: "gone", title: "Orphan1" },
      { id: "new", workspaceId: "a", title: "New" },
      { id: "b1", workspaceId: "b", title: "B1" },
      { id: "orphan2", workspaceId: "gone", title: "Orphan2" },
    ] as never,
    order: { sessions: { a: ["old"] }, collapsed: [] },
  });
  render(() => SessionList({}));
  const keys = () =>
    Array.from({ length: hooks.virtual?.options.count ?? 0 }, (_, i) =>
      hooks.virtual?.options.getItemKey?.(i),
    );
  expect(keys()).toEqual([
    "group:b",
    "b:b1",
    "group:a",
    "a:new",
    "a:old",
    "group:__orphans__",
    "__orphans__:orphan1",
    "__orphans__:orphan2",
  ]);
  useSessionStore.setState({ order: { sessions: { a: ["old"] }, collapsed: ["a"] } });
  render(() => SessionList({}));
  expect(keys()).not.toContain("a:old");
  hooks.states[1] = "Old";
  render(() => SessionList({}));
  expect(keys()).toEqual(["group:b", "group:a", "a:old"]);
});

test("session pinned lookup retains editing and workspace or session drag rows", () => {
  useAppStore.setState({ workspaces: [{ id: "w", name: "W", path: "/w" }] as never });
  useSessionStore.setState({
    sessions: Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      workspaceId: "w",
      title: `S${i}`,
    })) as never,
    order: { sessions: {}, collapsed: [] },
  });
  const show = () => render(() => SessionList({}));
  const range = () =>
    hooks.virtual?.options.rangeExtractor?.({ startIndex: 2, endIndex: 3, overscan: 0, count: 21 });
  show();
  hooks.states[2] = "s19";
  hooks.states[8] = "w";
  show();
  expect(range()).toEqual([0, 2, 3, 20]);
  hooks.states[2] = null;
  hooks.states[8] = null;
  hooks.states[10] = { kind: "session", id: "s18", groupKey: "w" };
  show();
  expect(range()).toEqual([2, 3, 19]);
  hooks.states[10] = { kind: "workspace", id: "w", groupKey: "w" };
  show();
  expect(range()).toEqual([0, 2, 3]);
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

test("session group unread counts are reused during local UI renders and refreshed on read or active changes", () => {
  let reads = 0;
  useAppStore.setState({ workspaces: [{ id: "w", name: "W", path: "/w" }] as never });
  useSessionStore.setState({
    sessions: Array.from({ length: 400 }, (_, i) => ({
      id: `s${i}`,
      title: `S${i}`,
      workspaceId: "w",
      get lastSeq() {
        reads++;
        return 10;
      },
    })) as never,
    seen: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`s${i}`, 0])),
    activeSessionId: "s0",
    order: { sessions: {}, collapsed: [] },
  });
  hooks.visible = [0];
  const show = () => render(() => SessionList({}));
  const unread = (node: ReactNode) =>
    elements(node).find((e) => String(e.props["aria-label"] ?? "").endsWith("个未读对话"))?.props[
      "aria-label"
    ];
  expect(unread(show())).toBe("399 个未读对话");
  reads = 0;
  hooks.states[3] = "editing text";
  expect(unread(show())).toBe("399 个未读对话");
  expect(reads).toBe(0);
  useSessionStore.setState({ seen: { ...useSessionStore.getState().seen, s1: 10 } });
  expect(unread(show())).toBe("398 个未读对话");
  useSessionStore.setState({ activeSessionId: null });
  expect(unread(show())).toBe("399 个未读对话");
  useSessionStore.setState({ sessions: useSessionStore.getState().sessions.slice(2) });
  expect(unread(show())).toBe("398 个未读对话");
  hooks.states[1] = "no-match";
  expect(unread(show())).toBeUndefined();
  hooks.states[1] = "";
  expect(unread(show())).toBe("398 个未读对话");
});

test("successive session searches reuse normalized titles and refreshed titles still match", () => {
  let reads = 0;
  useAppStore.setState({ workspaces: [{ id: "w", name: "W", path: "/w" }] as never });
  useSessionStore.setState({
    sessions: Array.from({ length: 400 }, (_, i) => ({
      id: `s${i}`,
      get title() {
        reads++;
        return `Alpha ${i}`;
      },
      workspaceId: "w",
      lastSeq: 0,
    })) as never,
    order: { sessions: {}, collapsed: [] },
  });
  const show = () => render(() => SessionList({}));
  hooks.states[1] = "a";
  show();
  reads = 0;
  hooks.states[1] = "a399";
  show();
  expect(hooks.virtual?.options.count).toBe(2);
  expect(hooks.virtual?.options.getItemKey?.(1)).toBe("w:s399");
  expect(reads).toBe(0);
  useSessionStore.setState({
    sessions: [{ id: "renamed", title: "  BETA  ", workspaceId: "w", lastSeq: 0 }] as never,
  });
  hooks.states[1] = "bt";
  show();
  expect(hooks.virtual?.options.getItemKey?.(1)).toBe("w:renamed");
  hooks.states[1] = "a399";
  show();
  expect(hooks.virtual?.options.count).toBe(1);
});

test("workspace drag hover uses prepared group endpoints without filtering all session rows", () => {
  useAppStore.setState({
    workspaces: [
      { id: "a", name: "A", path: "/a" },
      { id: "b", name: "B", path: "/b" },
    ] as never,
  });
  useSessionStore.setState({
    sessions: Array.from({ length: 400 }, (_, i) => ({
      id: `s${i}`,
      title: `S${i}`,
      workspaceId: i < 200 ? "a" : "b",
      lastSeq: 0,
    })) as never,
    order: { sessions: {}, collapsed: [] },
  });
  hooks.states[10] = { kind: "workspace", id: "a", groupKey: "a" };
  hooks.visible = [202];
  const show = () => render(() => SessionList({}));
  const hover = (node: ReactNode, row: string, y: number) => {
    const target = elements(node).find((e) => e.props["data-sidebar-row"] === row);
    const fn = target?.props.onDragOver as (event: unknown) => void;
    fn({
      preventDefault() {},
      clientY: y,
      dataTransfer: {},
      currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 44 }) },
    });
  };
  const root = show();
  const filter = vi.spyOn(Array.prototype, "filter");
  try {
    for (let i = 0; i < 20; i++) hover(root, "b:s200", 30);
    // None of these pointer events should scan the 402 flattened rows.
    expect(
      filter.mock.contexts.filter((value) => Array.isArray(value) && value.length === 402),
    ).toHaveLength(0);
  } finally {
    filter.mockRestore();
  }
  expect(hooks.states[12]).toEqual({ id: "b", side: "after", rowKey: "b:s399" });
  useSessionStore.setState({ order: { sessions: {}, collapsed: ["b"] } });
  hooks.visible = [201];
  hover(show(), "group:b", 30);
  expect(hooks.states[12]).toEqual({ id: "b", side: "after", rowKey: "group:b" });
  hover(show(), "group:b", 1);
  expect(hooks.states[12]).toEqual({ id: "b", side: "before", rowKey: "group:b" });
});
