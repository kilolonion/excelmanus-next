import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LazyRegion, RegionStatus } from "../src/components/ui/LazyRegion";

test("pending region immediately names the operation and offers close without hiding siblings", () => {
  const html = renderToStaticMarkup(
    createElement(
      "main",
      null,
      createElement("textarea", { defaultValue: "保留我的草稿" }),
      createElement(LazyRegion, {
        load: () => new Promise<never>(() => {}),
        componentProps: {},
        label: "表格",
        onClose: () => {},
      }),
    ),
  );
  expect(html).toContain("正在加载表格");
  expect(html).toContain('role="status"');
  expect(html).toContain("关闭");
  expect(html).toContain("保留我的草稿");
});

test("region failure offers a local retry, not a page reload", () => {
  const html = renderToStaticMarkup(
    createElement(RegionStatus, {
      label: "文件列表",
      failed: true,
      onRetry: () => {},
      onClose: () => {},
    }),
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("文件列表暂时无法显示");
  expect(html).toContain("重试");
  expect(html).not.toContain("重新加载页面");
});
