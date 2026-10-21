import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ memo: null as null | { deps: unknown[]; value: unknown } }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    if (h.memo && deps.every((d, i) => Object.is(d, h.memo?.deps[i]))) return h.memo.value;
    const value = fn();
    h.memo = { deps, value };
    return value;
  },
}));

import { ComposerRecoveryBar } from "../src/components/chat/ComposerRecoveryBar";

beforeEach(() => {
  h.memo = null;
});
function render(hint: string) {
  return ComposerRecoveryBar({ hint, onContinue: () => {} }).props.children[0];
}
test("the full hover hint is normalized once and reused by unchanged renders", () => {
  const hint = "失败原因 \n".repeat(10000);
  const full = hint.replace(/\s+/g, " ").trim();
  const replace = vi.spyOn(String.prototype, "replace");
  let calls = 0;
  let title = "";
  let visible = "";
  try {
    const span = render(hint);
    title = span.props.title;
    visible = span.props.children[1].props.children;
    render(hint);
    calls = replace.mock.calls.length;
  } finally {
    replace.mockRestore();
  }
  expect(calls).toBe(1);
  expect(title).toBe(full);
  expect(visible).toBe(`${full.slice(0, 10)}…`);
});
test("changed hints and blank hints refresh both visible and complete text", () => {
  render("旧错误");
  const current = render(" \n新错误 原因\t ");
  expect(current.props.title).toBe("新错误 原因");
  expect(current.props.children[1].props.children).toBe("新错误 原因");
  const empty = render(" \n ");
  expect(empty.props.title).toBe("回复未完成");
  expect(empty.props.children[1].props.children).toBe("回复未完成");
});
