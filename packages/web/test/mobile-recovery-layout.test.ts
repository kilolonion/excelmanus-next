import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@/components/chat/RetryModelPicker", () => ({
  RetryModelPicker: ({ triggerClassName }: { triggerClassName: string }) =>
    createElement("button", { className: triggerClassName }, "换模型"),
}));

import { ComposerRecoveryBar } from "../src/components/chat/ComposerRecoveryBar";

test("recovery labels get intrinsic width and can wrap without overlapping adjacent actions", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerRecoveryBar, {
      hint: "模型请求失败，请重试",
      onContinue: () => {},
      onRetryWithModel: () => {},
    }),
  );
  expect(html).not.toContain("w-7");
  expect(html).toContain("flex-wrap");
  expect(html).toContain("whitespace-nowrap");
  expect(html).toContain("继续");
  expect(html).toContain("换模型");
});
