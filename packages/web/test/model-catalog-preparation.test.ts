import { beforeEach, expect, test, vi } from "vitest";
import type { PickerModel } from "../src/hooks/use-model-selection";

const h = vi.hoisted(() => ({ states: [] as any[], memos: [] as any[], si: 0, mi: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "picker",
  useRef: () => ({ current: null }),
  useLayoutEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useState: (initial: any) => {
    const i = h.si++;
    if (!(i in h.states)) h.states[i] = initial;
    return [
      h.states[i],
      (v: any) => {
        h.states[i] = v;
      },
    ];
  },
  useMemo: (read: () => unknown, deps: unknown[]) => {
    const i = h.mi++,
      old = h.memos[i];
    if (old && deps.length === old.deps.length && deps.every((v, j) => Object.is(v, old.deps[j])))
      return old.value;
    const value = read();
    h.memos[i] = { deps, value };
    return value;
  },
}));

import { ModelPickerContent } from "../src/components/chat/ModelPickerContent";
import { ModelIdCombobox } from "../src/components/settings/model/ModelIdCombobox";

function render(fn: () => any) {
  h.si = h.mi = 0;
  return fn();
}
function nodes(node: any, match: (n: any) => boolean): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n, match));
  return [...(match(node) ? [node] : []), ...nodes(node.props?.children, match)];
}
const base = {
  value: "Vendor/M9",
  usedModelIds: new Set<string>(),
  onOpenChange: vi.fn(),
  onChange: vi.fn(),
  onSelect: vi.fn(),
};
beforeEach(() => {
  h.states = [];
  h.memos = [];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
test("closed and disabled model lists do not prepare option hints", () => {
  let reads = 0;
  const models = Array.from({ length: 500 }, (_, i) => ({
    id: `Vendor/M${i}`,
    get contextWindow() {
      reads++;
      return 128000;
    },
  }));
  for (const flags of [{ open: false }, { open: true, disabled: true }]) {
    const tree = render(() => ModelIdCombobox({ ...base, models, ...flags }));
    expect(nodes(tree, (n) => n.props?.role === "option")).toHaveLength(0);
  }
  expect(reads).toBe(0);
});
test("model option hints and search keys are reused while navigating and typing", () => {
  let reads = 0;
  const models = Array.from({ length: 500 }, (_, i) => ({
    id: `Vendor/M${i}`,
    get contextWindow() {
      reads++;
      return 128000;
    },
  }));
  const draw = () => render(() => ModelIdCombobox({ ...base, models, open: true }));
  expect(nodes(draw(), (n) => n.props?.role === "option")).toHaveLength(500);
  h.states[0] = "vendor";
  draw();
  reads = 0;
  const lower = vi.spyOn(String.prototype, "toLowerCase");
  h.states[0] = " VENDOR/M49 ";
  h.states[1] = "Vendor/M49";
  const options = nodes(draw(), (n) => n.props?.role === "option");
  expect(options.map((n) => n.props.title)).toEqual([
    "Vendor/M49",
    ...Array.from({ length: 10 }, (_, i) => `Vendor/M49${i}`),
  ]);
  expect(reads).toBe(0);
  expect(lower.mock.calls.length).toBeLessThan(10);
  options[0].props.onClick();
  expect(base.onSelect).toHaveBeenCalledWith(models[49]);
});
test("chat model searches reuse field normalization and preserve field boundaries", () => {
  const models: PickerModel[] = Array.from({ length: 500 }, (_, i) => ({
    id: `p${i}`,
    label: `Model ${i}`,
    profileName: "Custom",
    model: `vendor/M${i}`,
    provider: "openai",
    providerLabel: "供应商",
    brand: "openai",
    isDefault: false,
    unhealthy: false,
    vision: null,
  }));
  const draw = (list = models) =>
    render(() =>
      ModelPickerContent({ models: list, currentModel: "p9", onSelect: vi.fn(), onClose: vi.fn() }),
    );
  h.states[0] = "vendor";
  draw();
  const lower = vi.spyOn(String.prototype, "toLocaleLowerCase");
  h.states[0] = " M499 ";
  expect(nodes(draw(), (n) => n.props?.["data-model-row"] !== undefined).map((n) => n.key)).toEqual(
    ["p499"],
  );
  expect(lower.mock.calls.length).toBeLessThan(10);
  h.states[0] = "custom vendor";
  expect(nodes(draw(), (n) => n.props?.["data-model-row"] !== undefined)).toHaveLength(0);
  h.states[0] = "replacement";
  expect(
    nodes(
      draw([{ ...models[0], label: "replacement" }]),
      (n) => n.props?.["data-model-row"] !== undefined,
    ),
  ).toHaveLength(1);
});
test("catalog refresh and reopening keep current models, hints and manual IDs", () => {
  const first = [{ id: "old", contextWindow: 1000 }];
  const next = [{ id: "new", contextWindow: 2000 }];
  const draw = (models = first, open = true) =>
    render(() => ModelIdCombobox({ ...base, value: "manual", models, open }));
  expect(nodes(draw(), (n) => n.props?.role === "option").map((n) => n.props.title)).toEqual([
    "old",
  ]);
  draw(first, false);
  const tree = draw(next);
  expect(nodes(tree, (n) => n.props?.role === "option").map((n) => n.props.title)).toEqual(["new"]);
  const input = nodes(tree, (n) => n.props?.role === "combobox")[0];
  input.props.onKeyDown({ key: "Enter", nativeEvent: {}, preventDefault: vi.fn() });
  expect(base.onSelect).not.toHaveBeenCalled();
  expect(base.onOpenChange).toHaveBeenCalledWith(false);
});
test("keyboard navigation still chooses the filtered model and escape closes", () => {
  const models = [{ id: "alpha" }, { id: "beta" }];
  const draw = () =>
    render(() => ModelIdCombobox({ ...base, value: "custom", models, open: true }));
  const input = () => nodes(draw(), (n) => n.props?.role === "combobox")[0];
  const key = (key: string) => ({
    key,
    nativeEvent: {},
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  input().props.onKeyDown(key("ArrowDown"));
  input().props.onKeyDown(key("Enter"));
  expect(base.onSelect).toHaveBeenCalledWith(models[0]);
  input().props.onKeyDown(key("Escape"));
  expect(base.onOpenChange).toHaveBeenLastCalledWith(false);
});
