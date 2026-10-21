import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  index: 0,
  close: vi.fn(),
  mobile: true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => {
    const i = h.index++;
    if (!h.refs[i]) h.refs[i] = { current: value };
    return h.refs[i];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("framer-motion", () => ({
  motion: { div: "div", aside: "aside" },
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => h.mobile,
  useIsTablet: () => false,
  useIsDesktop: () => !h.mobile,
  useIsMediumScreen: () => false,
}));
vi.mock("@/hooks/use-resizable-panel", () => ({
  useResizablePanel: () => ({
    panelWidth: 520,
    handleProps: {},
    isDragging: false,
    isFloatingByResize: false,
  }),
}));
vi.mock("@/lib/sidebar-motion", () => ({
  useMotionSafe: () => ({ shouldReduce: true }),
  sidebarContentVariants: {},
  panelSlideVariants: {},
  panelSlideVariantsMedium: {},
  panelSlideVariantsMobile: {},
}));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (select: (s: unknown) => unknown) =>
    select({
      sidebarOpen: true,
      setSidebarOpen: h.close,
      sidebarTab: "chats",
      setSidebarTab: vi.fn(),
    }),
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => "session" }));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: (select: (s: unknown) => unknown) =>
    select({ panelOpen: true, fullView: false }),
  setPanelOpen: h.close,
}));
vi.mock("@/components/sidebar/SessionList", () => ({ SessionList: () => null }));
vi.mock("@/components/sidebar/StatusFooter", () => ({ StatusFooter: () => null }));
vi.mock("@/components/excel/DeferredWorkbook", () => ({ DeferredWorkbook: () => null }));

import { ExcelSidePanel } from "../src/components/excel/ExcelSidePanel";
import { Sidebar } from "../src/components/sidebar/Sidebar";

type Node = { props?: Record<string, any> };
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function handlers(kind: "sidebar" | "workbook") {
  h.index = 0;
  const node = nodes(kind === "sidebar" ? Sidebar() : ExcelSidePanel()).find(
    (n) => n.props?.onTouchStart,
  );
  if (!node?.props) throw new Error("missing gesture target");
  return node.props;
}
const touch = (identifier: number, clientX = 100, clientY = 100) => ({
  identifier,
  clientX,
  clientY,
});
beforeEach(() => {
  h.refs = [];
  h.index = 0;
  h.mobile = true;
  h.close.mockClear();
});
for (const kind of ["sidebar", "workbook"] as const) {
  const end = () => (kind === "sidebar" ? touch(1, 20, 100) : touch(1, 100, 180));
  test(`${kind} cancelled gesture cannot dismiss the panel`, () => {
    const p = handlers(kind);
    p.onTouchStart({ touches: [touch(1)] });
    p.onTouchCancel?.();
    p.onTouchEnd({ touches: [], changedTouches: [end()] });
    expect(h.close).not.toHaveBeenCalled();
    p.onTouchStart({ touches: [touch(1)] });
    p.onTouchEnd({ touches: [], changedTouches: [end()] });
    expect(h.close).toHaveBeenCalledExactlyOnceWith(false);
  });
  test(`${kind} multi-touch and another finger ending do not dismiss`, () => {
    const p = handlers(kind);
    p.onTouchStart({ touches: [touch(1)] });
    p.onTouchStart({ touches: [touch(1), touch(2)] });
    p.onTouchEnd({ touches: [], changedTouches: [end()] });
    expect(h.close).not.toHaveBeenCalled();
    p.onTouchStart({ touches: [touch(1)] });
    p.onTouchEnd({ touches: [], changedTouches: [{ ...end(), identifier: 2 }] });
    expect(h.close).not.toHaveBeenCalled();
  });
}
test("mostly horizontal movement cannot dismiss the workbook vertically", () => {
  const p = handlers("workbook");
  p.onTouchStart({ touches: [touch(1)] });
  p.onTouchEnd({ touches: [], changedTouches: [touch(1, 280, 170)] });
  expect(h.close).not.toHaveBeenCalled();
});

test("full-screen workbook reserves safe areas without changing desktop width", () => {
  h.index = 0;
  const mobile = nodes(ExcelSidePanel()).find((n) => n.props?.["aria-label"] === "表格面板")!
    .props!;
  expect(mobile.style.paddingTop).toContain("safe-area-inset-top");
  expect(mobile.style.paddingBottom).toContain("safe-area-inset-bottom");
  h.mobile = false;
  h.index = 0;
  const desktop = nodes(ExcelSidePanel()).find((n) => n.props?.["aria-label"] === "表格面板")!
    .props!;
  expect(desktop.style.paddingTop).toBeUndefined();
  expect(desktop.style.width).toBe(520);
});

import { SlidePanel } from "../src/components/ui/slide-panel";

test("mobile slide panels reserve safe areas and label their close action", () => {
  const props = { open: true, onClose: h.close, title: "修订历史", children: null };
  const tree = nodes(SlidePanel(props));
  const panel = tree.find((n) => n.props?.className?.startsWith("em-slide-panel fixed"))!.props!;
  expect(panel.style.paddingTop).toContain("safe-area-inset-top");
  expect(panel.style.paddingBottom).toContain("safe-area-inset-bottom");
  const close = tree.find((n) => n.props?.["aria-label"] === "关闭修订历史")!.props!;
  close.onClick();
  expect(h.close).toHaveBeenCalledOnce();
  h.mobile = false;
  const desktop = nodes(SlidePanel(props)).find((n) =>
    n.props?.className?.startsWith("em-slide-panel fixed"),
  )!.props!;
  expect(desktop.style).toEqual({ width: "min(520px, 90vw)" });
});
