import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { LazyRegion } from "../src/components/ui/LazyRegion";

const View = ({ name }: { name: string }) => createElement("p", null, `当前文件 ${name}`);
const render = (load: () => Promise<{ default: typeof View }>, name: string) =>
  renderToStaticMarkup(
    createElement(LazyRegion<{ name: string }>, { load, componentProps: { name }, label: "预览" }),
  );
async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("reopening a loaded region renders immediately without a fresh loading placeholder", async () => {
  const load = vi.fn(async () => ({ default: View }));
  expect(render(load, "first")).toContain("正在加载预览");
  await settle();
  const reopened = render(load, "second");
  expect(reopened).toContain("当前文件 second");
  expect(reopened).not.toContain("正在加载预览");
  expect(load).toHaveBeenCalledTimes(1);
});
test("successful module reuse keeps current props and separate loaders independent", async () => {
  const first = vi.fn(async () => ({ default: View }));
  const Other = ({ name }: { name: string }) => createElement("p", null, `另一种预览 ${name}`);
  const second = vi.fn(async () => ({ default: Other }));
  render(first, "old");
  await settle();
  expect(render(first, "new")).not.toContain("当前文件 old");
  expect(render(second, "image")).toContain("正在加载预览");
  await settle();
  expect(render(second, "image")).toContain("另一种预览 image");
  expect(render(first, "latest")).toContain("当前文件 latest");
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});
test("a rejected load is not cached and reopening can recover", async () => {
  const load = vi
    .fn<() => Promise<{ default: typeof View }>>()
    .mockRejectedValueOnce(new Error("chunk unavailable"))
    .mockResolvedValue({ default: View });
  render(load, "before");
  await settle();
  expect(render(load, "retry")).toContain("正在加载预览");
  await settle();
  expect(render(load, "recovered")).toContain("当前文件 recovered");
  expect(load).toHaveBeenCalledTimes(2);
});
