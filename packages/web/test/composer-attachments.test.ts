import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import {
  attachmentVisibleCount,
  FileAttachmentChips,
} from "../src/components/chat/FileAttachmentChips";

test("attachment capacity follows composer width, not window width", () => {
  expect(attachmentVisibleCount(276)).toBe(2);
  expect(attachmentVisibleCount(600)).toBe(6);
});
test("collapsed failures retain counts and restored images retain vision warning", () => {
  const files = Array.from({ length: 6 }, (_, i) => ({
    id: String(i),
    name: `file-${i}.png`,
    size: 123,
    status: "error" as const,
    canRetry: true,
    error: "temporary",
    ref: { sha256: "a".repeat(64), mediaType: "image/png" as const, name: "image.png", size: 123 },
  }));
  const html = renderToStaticMarkup(
    createElement(FileAttachmentChips, { files, visionCapable: false }),
  );
  expect(html).toContain("6 个未就绪");
  expect(html).toContain("展开 4 项");
  expect(html).toContain("无法查看图片内容");
  expect(html).toContain("重试失败的附件");
  expect(html).not.toContain("文字说明代替");
});
