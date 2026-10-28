import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ChatModeTabs } from "../src/components/chat/ChatModeTabs";
import { effectiveChatMode, useChatStore } from "../src/stores/chat-store";

test("a reader shows read-only mode without changing the main agent preference", () => {
  const initial = useChatStore.getInitialState();
  const before = {
    session: initial.session,
    chatMode: initial.chatMode,
    viewAgentId: initial.viewAgentId,
  };
  initial.session = {
    ...before.session,
    roster: {
      ...before.session.roster,
      reader: { id: "reader", role: "reader" } as (typeof initial.session.roster)[string],
    },
  };
  initial.chatMode = "write";
  initial.viewAgentId = "reader";
  try {
    expect(effectiveChatMode(initial, "reader")).toBe("ask");
    expect(effectiveChatMode(initial, "main")).toBe("write");
    const html = renderToStaticMarkup(createElement(ChatModeTabs));
    expect(html).toMatch(/role="radio" aria-checked="false" disabled=""/);
    expect(html).toContain('aria-checked="true"');
    expect(initial.chatMode).toBe("write");
    initial.chatMode = "plan";
    expect(effectiveChatMode(initial, "reader")).toBe("plan");
  } finally {
    Object.assign(initial, before);
  }
});
