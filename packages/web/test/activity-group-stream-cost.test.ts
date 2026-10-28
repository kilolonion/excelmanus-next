import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { SessionState } from "../src/lib/session/types";

const state = vi.hoisted(() => ({
  session: null as unknown as SessionState,
  selectors: [] as Array<(s: { session: SessionState }) => unknown>,
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: (s: { session: SessionState }) => unknown) => {
    state.selectors.push(select);
    return select({ session: state.session });
  },
}));
vi.mock("../src/components/chat/ToolCallCard", () => ({ ToolCallCard: () => null }));

import { ActivityGroup } from "../src/components/chat/ActivityGroup";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";

test("completed tool groups do not subscribe to unrelated streamed text", () => {
  state.session = initialSessionState();
  state.session.tools.one = {
    id: "one",
    name: "workbook_read",
    phase: "done",
    status: "ok",
    args: {},
  } as never;
  state.selectors = [];
  expect(
    renderToString(createElement(ActivityGroup, { toolIds: ["one"], defaultCollapsed: true })),
  ).toContain("已完成 1 个步骤");
  const previous = { session: state.session };
  const next = {
    session: reduceSession(state.session, {
      type: "delta",
      topic: "session:s",
      agentId: "main",
      stepId: "step",
      part: 1,
      kind: "text",
      payload: "hello",
    }),
  };
  expect(state.selectors.length).toBeGreaterThan(0);
  for (const select of state.selectors) expect(select(next)).toBe(select(previous));
});

test("tool, approval and question changes remain subscribed and pending decisions force expansion", () => {
  state.session = initialSessionState();
  state.session.tools.one = {
    id: "one",
    name: "workbook_edit",
    phase: "approval",
    approvalId: "a",
    args: {},
  } as never;
  state.session.approvals.a = { status: "pending" } as never;
  state.selectors = [];
  const render = () =>
    renderToString(createElement(ActivityGroup, { toolIds: ["one"], defaultCollapsed: true }));
  expect(render()).toContain("等待你的确认");
  expect(render()).toContain('aria-expanded="true"');
  const old = { session: state.session };
  for (const field of ["tools", "approvals", "questions"] as const) {
    const changed = { session: { ...state.session, [field]: { ...state.session[field] } } };
    expect(state.selectors.some((select) => select(old) !== select(changed))).toBe(true);
  }
  state.session = {
    ...state.session,
    approvals: { a: { ...state.session.approvals.a!, status: "approved" } },
  };
  expect(render()).not.toContain("等待你的确认");
  state.session = {
    ...state.session,
    tools: { one: { ...state.session.tools.one!, phase: "question", questionId: "q" } },
    questions: { q: { status: "pending" } as never },
  };
  expect(render()).toContain("等待你的确认");
});
