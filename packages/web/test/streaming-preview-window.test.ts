import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import StreamingTextPreview from "../src/components/chat/StreamingTextPreview";

for (const toolName of ["write", "edit"]) {
  test(`${toolName} long preview initially builds only visible tail rows`, () => {
    const content = Array.from({ length: 10000 }, (_, i) => `unique-line-${i}-end`).join("\n");
    const rawArgs = JSON.stringify(
      toolName === "write"
        ? { path: "qa.txt", content }
        : { path: "qa.txt", oldText: content, newText: content },
    );
    const html = renderToStaticMarkup(createElement(StreamingTextPreview, { toolName, rawArgs }));
    expect((html.match(/<tr/g) ?? []).length).toBeLessThan(60);
    expect(html).toContain("unique-line-9999-end");
    expect(html).not.toContain("unique-line-0-end");
    expect(html).toContain("查看完整内容");
    expect(html).toContain("复制");
  });
}
