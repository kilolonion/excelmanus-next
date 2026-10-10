import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

const ui = await import("../src/components/ui/page-layout.tsx").catch(() => null);

describe("共享页面框架", () => {
  test("应用框架拥有单一主区域并可完全移除收起的侧栏", () => {
    expect(ui?.ApplicationFrame).toBeDefined();
    const html = renderToStaticMarkup(
      createElement(
        ui!.ApplicationFrame,
        {
          sidebar: "navigation",
          collapsed: true,
          sidebarLabel: "导航",
          label: "工作区",
        },
        "content",
      ),
    );
    expect(html).toContain("<main");
    expect(html).not.toContain("<aside");
    expect(html).toContain("content");
  });
  test("页面标题与操作槽语义统一，未传操作时不制造按钮", () => {
    expect(ui).not.toBeNull();
    const html = renderToStaticMarkup(
      createElement(ui!.PageHeader, { title: "文件", description: "本地工作区" }),
    );
    expect(html).toContain('data-slot="page-header"');
    expect(html).toContain("<h2");
    expect(html).toContain("本地工作区");
    expect(html).not.toContain("<button");
  });
  test("列表详情框架保持两个区域，窄屏显式区分已选详情", () => {
    expect(ui).not.toBeNull();
    const html = renderToStaticMarkup(
      createElement(ui!.ListDetailLayout, {
        list: "files",
        detail: "preview",
        selected: true,
        label: "文件浏览",
      }),
    );
    expect(html).toContain('data-slot="list-detail"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-label="文件浏览"');
    expect(html).toContain("files");
    expect(html).toContain("preview");
  });
  test("错误状态可被辅助技术感知，加载状态不伪装完成", () => {
    expect(ui).not.toBeNull();
    expect(
      renderToStaticMarkup(
        createElement(ui!.PageState, { kind: "error", title: "读取失败", description: "请重试" }),
      ),
    ).toContain('role="alert"');
    const loading = renderToStaticMarkup(
      createElement(ui!.PageState, { kind: "loading", title: "加载中" }),
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('data-state="completed"');
  });
});
