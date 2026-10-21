import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  effects: [] as (() => undefined | (() => void))[],
  setters: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => undefined | (() => void)) => {
    h.effects.push(effect);
  },
  useState: (initial: unknown) => {
    const setter = vi.fn();
    h.setters.push(setter);
    return [typeof initial === "function" ? initial() : initial, setter];
  },
}));

import { useIsDesktop, useIsMediumScreen, useIsMobile, useIsTablet } from "../src/hooks/use-mobile";

const hooks = [useIsMobile, useIsTablet, useIsDesktop, useIsMediumScreen];
let cleanups: (() => void)[] = [];
const queries = new Map<
  string,
  {
    matches: boolean;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  }
>();
let matchMedia: ReturnType<typeof vi.fn>;
function mount(hook = useIsMobile) {
  h.effects = [];
  function View() {
    return createElement("span", null, String(hook()));
  }
  const html = renderToString(createElement(View));
  for (const run of h.effects) {
    const cleanup = run();
    if (cleanup) cleanups.push(cleanup);
  }
  return html;
}
beforeEach(() => {
  h.effects = [];
  h.setters = [];
  queries.clear();
  cleanups = [];
  matchMedia = vi.fn((query: string) => {
    let m = queries.get(query);
    if (!m) {
      m = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      queries.set(query, m);
    }
    return m;
  });
  vi.stubGlobal("window", { innerWidth: 1188, matchMedia });
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
});
test("many tool cards share one mobile query and listener until the last card leaves", () => {
  for (let i = 0; i < 100; i++) mount();
  expect(matchMedia).toHaveBeenCalledTimes(1);
  const query = [...queries.values()][0];
  expect(query.addEventListener).toHaveBeenCalledTimes(1);
  query.matches = true;
  query.addEventListener.mock.calls[0][1]();
  for (const setter of h.setters) expect(setter).toHaveBeenLastCalledWith(true);
  for (const cleanup of cleanups.splice(0, 99)) cleanup();
  expect(query.removeEventListener).not.toHaveBeenCalled();
  for (const setter of h.setters) setter.mockClear();
  query.matches = false;
  query.addEventListener.mock.calls[0][1]();
  for (const setter of h.setters.slice(0, 99)) expect(setter).not.toHaveBeenCalled();
  expect(h.setters[99]).toHaveBeenLastCalledWith(false);
  expect(cleanups).toHaveLength(1);
  cleanups.pop()?.();
  expect(query.removeEventListener).toHaveBeenCalledTimes(1);
});
test("all four responsive ranges share independently and rebuild after unmount", () => {
  for (const hook of hooks) {
    mount(hook);
    mount(hook);
  }
  expect(matchMedia).toHaveBeenCalledTimes(4);
  expect([...queries.keys()]).toEqual([
    "(max-width: 767px)",
    "(min-width: 768px) and (max-width: 1023px)",
    "(min-width: 1280px)",
    "(min-width: 1024px) and (max-width: 1279px)",
  ]);
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const q of queries.values()) expect(q.removeEventListener).toHaveBeenCalledTimes(1);
  const mobile = [...queries.values()][0];
  mobile.matches = true;
  mount();
  expect(matchMedia).toHaveBeenCalledTimes(5);
  expect(h.setters.at(-1)).toHaveBeenLastCalledWith(true);
});
test("server rendering stays false and does not create browser subscriptions", () => {
  vi.unstubAllGlobals();
  function Server() {
    return createElement("span", null, hooks.map((hook) => String(hook())).join(","));
  }
  expect(renderToString(createElement(Server))).toContain("false,false,false,false");
  expect(matchMedia).not.toHaveBeenCalled();
});
