import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { SessionState } from "../src/lib/session/types";

const hooks = vi.hoisted(() => ({
  session: null as unknown as SessionState,
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  index: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const i = hooks.index++,
      old = hooks.memos[i];
    if (old && old.deps.length === deps.length && deps.every((v, j) => Object.is(v, old.deps[j])))
      return old.value;
    const value = fn();
    hooks.memos[i] = { deps, value };
    return value;
  },
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: (s: { session: SessionState }) => unknown) =>
    select({ session: hooks.session }),
}));

import { useAgentTeam } from "../src/components/chat/use-background-tasks";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";

test("team members and counts reuse unchanged roster on text deltas and update real roster changes", () => {
  hooks.session = initialSessionState();
  hooks.session.roster = {
    main: { id: "main", seq: 0, status: "running" },
    child: { id: "child", seq: 1, status: "running" },
  } as never;
  let result: ReturnType<typeof useAgentTeam>;
  function Probe() {
    result = useAgentTeam();
    return null;
  }
  const render = () => {
    hooks.index = 0;
    renderToString(createElement(Probe));
    return result;
  };
  const first = render();
  expect(first.activeCount).toBe(1);
  hooks.session = reduceSession(hooks.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "hello",
  });
  expect(render()).toBe(first);
  hooks.session = {
    ...hooks.session,
    roster: {
      ...hooks.session.roster,
      child: { ...hooks.session.roster.child!, status: "blocked" },
    },
  };
  const next = render();
  expect(next.blockedCount).toBe(1);
  expect(next.members[1]?.color).toBe(first.members[1]?.color);
  hooks.session = initialSessionState();
  expect(render().members).toEqual([]);
});
