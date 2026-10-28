import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  state: 0,
  ref: 0,
  drag: vi.fn(),
  select: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const hooks = {
    useEffect: () => {},
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useRef: (initial: unknown) => {
      const i = h.ref++;
      if (!h.refs[i]) h.refs[i] = { current: initial };
      return h.refs[i];
    },
    useState: (initial: unknown) => {
      const i = h.state++;
      if (!(i in h.states)) h.states[i] = initial;
      return [
        h.states[i],
        (value: unknown) => {
          h.states[i] = typeof value === "function" ? value(h.states[i]) : value;
        },
      ];
    },
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});
vi.mock("react-dom", () => ({ createPortal: (children: ReactNode) => children }));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: "div", aside: "aside" },
  useDragControls: () => ({ start: h.drag }),
  useReducedMotion: () => false,
}));
vi.mock("@/components/chat/ModelPickerContent", () => ({ ModelPickerContent: () => null }));
vi.mock("@/components/settings/model/ProviderLogo", () => ({ ProviderAvatar: () => null }));
vi.mock("@/lib/use-workspace-image", () => ({
  useWorkspaceImage: () => ({ blobUrl: null, loading: false, error: "" }),
}));
vi.mock("@/stores/files-store", () => ({ useFilesStore: () => 0, downloadWorkspaceFile: vi.fn() }));

import { ImagePreviewModal } from "../src/components/chat/ImagePreviewModal";
import { ModelListBottomSheet } from "../src/components/chat/ModelListBottomSheet";
import type { PickerModel } from "../src/hooks/use-model-selection";

type Node = { type: unknown; props: Record<string, any> };
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function renderImage() {
  h.state = 0;
  h.ref = 0;
  return nodes(ImagePreviewModal({ imagePath: "image.png", filename: "image.png", open: true }));
}
function retrySheet() {
  const models = [false, true].map(
    (unhealthy, i) =>
      ({
        id: `${i}`,
        label: `Model ${i}`,
        profileName: `Model ${i}`,
        brand: "openai",
        unhealthy,
      }) as PickerModel,
  );
  const element = ModelListBottomSheet({
    open: true,
    onOpenChange: h.close,
    onSelect: h.select,
    currentModel: null,
    models,
    mode: "retry",
  });
  const component = element.type as (props: typeof element.props) => ReactNode;
  return nodes(component(element.props));
}
beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.state = 0;
  h.ref = 0;
  vi.clearAllMocks();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => vi.unstubAllGlobals());

test("mobile retry keeps unhealthy models disabled like the desktop picker", () => {
  const buttons = retrySheet().filter(
    (n) => n.type === "button" && n.props.onClick && n.props.className.includes("w-full"),
  );
  expect(buttons[1].props.disabled).toBe(true);
  buttons[1].props.onClick();
  expect(h.select).not.toHaveBeenCalled();
  buttons[0].props.onClick();
  expect(h.select).toHaveBeenCalledExactlyOnceWith("0");
  expect(h.close).toHaveBeenCalledExactlyOnceWith(false);
});
test("retry list scrolling is not intercepted by sheet drag or capture handlers", () => {
  const tree = retrySheet(),
    sheet = tree.find((n) => n.props.drag === "y")!;
  expect(sheet.props.dragListener).toBe(false);
  expect(sheet.props.style?.touchAction).not.toBe("none");
  const list = tree.find((n) => n.props.className?.includes("model-selector-scroll"))!;
  expect(list.props.onPointerDownCapture).toBeUndefined();
  const handle = tree.find((n) => n.props.onPointerDown)!;
  expect(handle.props.style.touchAction).toBe("none");
  const event = {};
  handle.props.onPointerDown(event);
  expect(h.drag).toHaveBeenCalledWith(event);
  sheet.props.onDragEnd({}, { offset: { y: 90 }, velocity: { y: 0 } });
  expect(h.close).toHaveBeenCalledWith(false);
});
function area(tree: Node[]) {
  return tree.find((n) => n.props.className?.includes("em-preview-content"))!;
}
function pointer(id: number, x = 10, y = 20) {
  return {
    pointerId: id,
    isPrimary: true,
    button: 0,
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() },
    target: { setPointerCapture: vi.fn() },
  };
}
function zoomIn() {
  renderImage()
    .find((n) => n.props.title === "放大")!
    .props.onClick();
}
test("image panning owns one pointer and ignores other fingers", () => {
  zoomIn();
  const first = pointer(1);
  area(renderImage()).props.onPointerDown(first);
  expect(first.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
  area(renderImage()).props.onPointerMove(pointer(2, 100, 200));
  expect(h.states[5]).toEqual({ x: 0, y: 0 });
  area(renderImage()).props.onPointerMove(pointer(1, 40, 60));
  expect(h.states[5]).toEqual({ x: 30, y: 40 });
});
test("image gesture cancellation ends panning and permits the next gesture", () => {
  zoomIn();
  const box = area(renderImage());
  expect(box.props.style.touchAction).toBe("none");
  box.props.onPointerDown(pointer(1));
  area(renderImage()).props.onPointerCancel?.(pointer(1));
  area(renderImage()).props.onPointerMove(pointer(1, 80, 90));
  expect(h.states[5]).toEqual({ x: 0, y: 0 });
  expect(area(renderImage()).props.style.cursor).toBe("grab");
  area(renderImage()).props.onPointerDown(pointer(3));
  area(renderImage()).props.onPointerMove(pointer(3, 30, 40));
  expect(h.states[5]).toEqual({ x: 20, y: 20 });
  area(renderImage()).props.onLostPointerCapture?.(pointer(3));
  expect(area(renderImage()).props.style.cursor).toBe("grab");
});
test("unzoomed images retain browser gestures and ignore drag initiation", () => {
  const box = area(renderImage());
  expect(box.props.style.touchAction).not.toBe("none");
  const event = pointer(1);
  box.props.onPointerDown(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
});
