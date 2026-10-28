import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  memos: [] as { deps: unknown[]; value: unknown }[],
  si: 0,
  ri: 0,
  mi: 0,
  textarea: null as null | {
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    ref: { current: unknown };
    onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
  },
  draft: "@dir/sales.xlsx @other/cost.csv",
  matches: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  function memo(fn: () => unknown, deps: unknown[] = []) {
    const i = h.mi++,
      old = h.memos[i];
    if (!old || deps.length !== old.deps.length || deps.some((d, j) => !Object.is(d, old.deps[j])))
      h.memos[i] = { deps, value: fn() };
    return h.memos[i].value;
  }
  return {
    ...react,
    useState: (initial: unknown) => {
      const i = h.si++;
      if (!(i in h.states)) h.states[i] = typeof initial === "function" ? initial() : initial;
      return [
        h.states[i],
        (v: unknown) => {
          h.states[i] = typeof v === "function" ? v(h.states[i]) : v;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const i = h.ri++;
      h.refs[i] ??= { current: initial };
      return h.refs[i];
    },
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
});
vi.mock("@/lib/composer-drafts", async (original) => ({
  ...(await original<typeof import("@/lib/composer-drafts")>()),
  readDraft: () => h.draft,
}));
vi.mock("@/lib/draft-storage", () => ({
  persistentDraftStorage: () => ({ getItem: () => null, setItem: () => {} }),
}));
vi.mock("../src/components/chat/chat-input-insert", async (original) => {
  const actual = await original<typeof import("../src/components/chat/chat-input-insert")>();
  h.matches.mockImplementation(actual.mentionOccurrences);
  h.replace.mockImplementation(actual.applyDisplayReplacements);
  return { ...actual, mentionOccurrences: h.matches, applyDisplayReplacements: h.replace };
});
vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: NonNullable<typeof h.textarea>) => {
    h.textarea = props;
    return createElement("textarea", { value: props.value, readOnly: true });
  },
}));

import { ChatInput } from "../src/components/chat/ChatInput";

function render(disabled = false) {
  h.si = 0;
  h.ri = 0;
  h.mi = 0;
  return renderToString(createElement(ChatInput, { disabled }));
}
beforeEach(() => {
  h.draft = "@dir/sales.xlsx @other/cost.csv";
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  h.states = [];
  h.refs = [];
  h.memos = [];
  h.matches.mockClear();
  h.replace.mockClear();
});
test("unrelated composer updates reuse highlighted text and the initial full-path draft", () => {
  expect(render()).toContain("@sales.xlsx");
  const matches = h.matches.mock.calls.length,
    replacements = h.replace.mock.calls.length;
  expect(matches).toBeGreaterThan(0);
  expect(replacements).toBeGreaterThan(0);
  expect(render(true)).toContain("@sales.xlsx");
  expect(h.matches).toHaveBeenCalledTimes(matches);
  expect(h.replace).toHaveBeenCalledTimes(replacements);
});

afterEach(() => vi.unstubAllGlobals());
test("deleting one repeated mention checks the remainder once and preserves confirmed identity", () => {
  h.draft = "@dir/sales.xlsx @dir/sales.xlsx";
  render();
  const confirmed = h.states.find((v) => v instanceof Set);
  if (!h.textarea) throw Error("missing textarea");
  h.textarea.ref.current = { selectionStart: 11, selectionEnd: 11 };
  h.matches.mockClear();
  h.textarea.onKeyDown({ key: "Backspace", preventDefault: vi.fn() });
  expect(h.matches).toHaveBeenCalledTimes(2);
  expect(h.states).toContain(confirmed);
  render();
  expect(h.textarea.value).toBe("@sales.xlsx");
});
test("deleting the final mention clears the visible text and confirmed label", () => {
  h.draft = "@dir/sales.xlsx";
  render();
  if (!h.textarea) throw Error("missing textarea");
  h.textarea.ref.current = { selectionStart: 0, selectionEnd: 0 };
  h.matches.mockClear();
  h.textarea.onKeyDown({ key: "Delete", preventDefault: vi.fn() });
  expect(h.matches).toHaveBeenCalledTimes(2);
  render();
  expect(h.textarea.value).toBe("");
  expect((h.states.find((v) => v instanceof Set) as Set<string>).size).toBe(0);
});

test("editing text refreshes highlighting and removes only absent confirmed labels", () => {
  render();
  if (!h.textarea) throw Error("missing textarea");
  h.matches.mockClear();
  h.textarea.onChange({ target: { value: "@sales.xlsx revised" } });
  const html = render();
  expect(html).toContain("@sales.xlsx");
  expect(html).not.toContain("@cost.csv");
  expect(h.matches).toHaveBeenCalledOnce();
  expect([...(h.states.find((v) => v instanceof Set) as Set<string>)]).toEqual(["@sales.xlsx"]);
});

test("typing leaves sizing to the committed layout instead of adding a second frame job", () => {
  render();
  vi.mocked(requestAnimationFrame).mockClear();
  h.textarea?.onChange({ target: { value: "plain text" } });
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});
