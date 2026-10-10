import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ResourceBrowser } from "../src/components/ui/resource-browser.tsx";

const props = {
  id: (item: { id: string; name: string }) => item.id,
  title: (item: { id: string; name: string }) => item.name,
  detail: (item: { id: string; name: string }) => createElement("p", null, `detail:${item.id}`),
  label: "Resources",
  emptyText: "Nothing configured",
};
describe("共享资源列表详情", () => {
  test("首项详情只渲染一次，未选择时移动端仍显示列表", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceBrowser<{ id: string; name: string }>, {
        ...props,
        items: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
        ],
      }),
    );
    expect(html).toContain('data-selected="false"');
    expect(html.match(/detail:a/g)).toHaveLength(1);
    expect(html).not.toContain("detail:b");
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
  });
  test("空列表只显示真实空态，不产生演示资源或危险操作", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceBrowser<{ id: string; name: string }>, { ...props, items: [] }),
    );
    expect(html).toContain("Nothing configured");
    expect(html).not.toContain("detail:");
    expect(html).not.toContain('aria-current="page"');
  });
});
