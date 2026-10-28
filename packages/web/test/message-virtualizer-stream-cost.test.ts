import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { SessionState, UserItem } from "../src/lib/session/types";

const hooks = vi.hoisted(() => ({
  session: null as unknown as SessionState,
  optimistic: [],
  memo: [] as Array<{ deps: unknown[]; value: unknown }>,
  index: 0,
  virtualizer: null as unknown as import("@tanstack/react-virtual").Virtualizer<Element, Element>,
  estimates: 0,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = hooks.index++,
      old = hooks.memo[i];
    if (old && deps.length === old.deps.length && deps.every((v, j) => Object.is(v, old.deps[j])))
      return old.value;
    const value = fn();
    hooks.memo[i] = { deps, value };
    return value;
  };
  return {
    ...actual,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
  };
});
vi.mock("@/stores/chat-store", async (original) => ({
  ...(await original<typeof import("../src/stores/chat-store")>()),
  useChatStore: (select: (s: unknown) => unknown) =>
    select({
      session: hooks.session,
      sessionId: "s",
      viewAgentId: "main",
      optimistic: hooks.optimistic,
      compacting: {},
      loading: false,
      hasOlder: false,
      loadingOlder: false,
      olderError: null,
    }),
}));
vi.mock("@tanstack/react-virtual", async (original) => {
  const actual = await original<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (
      options: import("@tanstack/react-virtual").VirtualizerOptions<Element, Element>,
    ) => {
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
      if (!hooks.virtualizer) hooks.virtualizer = new actual.Virtualizer(next);
      else hooks.virtualizer.setOptions(next);
      return hooks.virtualizer;
    },
  };
});
vi.mock("../src/components/chat/UserMessage", () => ({ UserMessage: () => null }));
vi.mock("../src/components/chat/AssistantMessage", () => ({ AssistantMessage: () => null }));
vi.mock("../src/components/chat/RollbackConfirmDialog", () => ({
  RollbackConfirmDialog: () => null,
}));

import { MessageStream } from "../src/components/chat/MessageStream";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";

const user = (id: string, seq: number): UserItem => ({
  kind: "user",
  id,
  seq,
  agentId: "main",
  at: "2026-01-01T00:00:00Z",
  text: id,
  mode: "queue",
  status: "applied",
  clientMessageId: id,
  attachments: [],
  context: [],
});

test("stream text reuses virtual history measurements; appended and prepended rows retain correct keys", () => {
  hooks.session = initialSessionState();
  hooks.session.timelines.main = Array.from({ length: 100 }, (_, i) => user(String(i), i + 1));
  const render = () => {
    hooks.index = 0;
    renderToString(createElement(MessageStream));
  };
  render();
  expect(hooks.estimates).toBe(99);
  hooks.estimates = 0;
  hooks.session = reduceSession(hooks.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "hello",
  });
  render();
  expect(hooks.estimates).toBe(0);
  hooks.session = {
    ...hooks.session,
    timelines: { main: [user("older", 0), ...hooks.session.timelines.main!, user("new", 101)] },
  };
  render();
  expect(hooks.estimates).toBeGreaterThan(0);
  expect(hooks.virtualizer.options.getItemKey?.(0)).toBe("user:older");
  expect(hooks.virtualizer.options.getItemKey?.(100)).toBe("user:99");
});
