import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TopModelSelector } from "../src/components/chat/TopModelSelector";
import { useAppStore } from "../src/stores/app-store";
import { useChatStore } from "../src/stores/chat-store";

test("loading a conversation does not briefly advertise the unrelated default model", () => {
  const chat = useChatStore.getInitialState();
  const app = useAppStore.getInitialState();
  const before = { loading: chat.loading, sessionId: chat.sessionId, profiles: app.profiles };
  try {
    chat.loading = true;
    chat.sessionId = "loading-session";
    app.profiles = [
      {
        id: "default",
        model: "unrelated-default",
        name: "default",
        provider: "custom-openai-compatible",
        isDefault: true,
      },
    ] as never;
    const html = renderToStaticMarkup(createElement(TopModelSelector));
    expect(html).toContain("正在加载模型");
    expect(html).not.toContain("unrelated-default");
    expect(html).toContain('disabled=""');
  } finally {
    chat.loading = before.loading;
    chat.sessionId = before.sessionId;
    app.profiles = before.profiles;
  }
});
