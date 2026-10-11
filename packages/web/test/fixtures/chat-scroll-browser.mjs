// 先启动 chat-scroll-server.ts，再运行：
// PLAYWRIGHT_MODULE=<Playwright index.mjs 路径> node packages/web/test/fixtures/chat-scroll-browser.mjs <url> <evidenceDir>
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.argv[2];
const evidence = resolve(process.argv[3] ?? ".agents/tasks/chat-scroll-2026-10-01");
assert(url, "fixture URL required");
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
const page = await context.newPage();
const results = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const viewport = page.getByRole("region", { name: "对话历史", exact: true });
const metrics = () => viewport.evaluate((element) => {
  const top = element.getBoundingClientRect().top;
  const anchor = [...element.querySelectorAll("[data-chat-item]")].find(
    (child) => child.getBoundingClientRect().bottom > top,
  );
  return {
    top: element.scrollTop,
    height: element.clientHeight,
    total: element.scrollHeight,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop,
    anchor: anchor?.getAttribute("data-chat-item"),
    offset: anchor?.getBoundingClientRect().top - top,
    outerTop: document.documentElement.scrollTop,
  };
});
const record = async (name) => results.push({ name, ...(await metrics()) });
const stable = async (name, duration = 450) => {
  await page.waitForTimeout(100);
  const before = await metrics();
  await page.waitForTimeout(duration);
  const after = await metrics();
  assert(Math.abs(before.top - after.top) < 2, `${name}: reading position moved`);
  assert.equal(before.anchor, after.anchor, `${name}: anchor changed`);
  assert.equal(after.outerTop, 0, `${name}: outer page scrolled`);
  await record(name);
};
const followButton = () => page.getByRole("button", { name: /回到最新/ });
const wheel = async (delta) => {
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(150);
};
const follow = async () => {
  if (await followButton().count()) await followButton().click();
  await page.waitForTimeout(150);
  assert((await metrics()).gap < 48, "follow did not reach latest");
};

try {
  await page.goto(url);
  await viewport.waitFor();
  await page.getByRole("button", { name: /^流式滚动验收/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-chat-item]").length >= 16);
  await page.waitForTimeout(150);
  assert((await metrics()).gap < 2);
  await record("initial history follows latest");

  await page.locator("textarea").fill("持续滚动验收");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await viewport.locator('[data-chat-item="streaming"]').waitFor();
  await page.waitForTimeout(400);
  const generating = await metrics();
  await page.waitForTimeout(400);
  assert((await metrics()).total > generating.total, "fixture is not streaming");
  assert((await metrics()).gap < 48);
  await record("streaming automatically follows");

  await wheel(-8);
  assert(await followButton().isVisible(), "small upward wheel did not release");
  await stable("upward wheel inside bottom threshold stays released");
  await follow();
  await record("explicit button resumes following");

  await wheel(-600);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -40);
  await stable("rapid upward wheels during stream");
  await page.locator("textarea").fill("编辑草稿不抢占历史位置\n第二行");
  await stable("composer editing preserves history");
  await page.locator("textarea").press("ArrowUp");
  await stable("composer arrow keys preserve history");

  const priorResize = await metrics();
  await page.setViewportSize({ width: 1280, height: 780 });
  await page.waitForTimeout(200);
  const resized = await metrics();
  assert.equal(resized.anchor, priorResize.anchor);
  assert(Math.abs(resized.offset - priorResize.offset) < 2);
  await stable("viewport resize preserves visible message offset");

  await viewport.evaluate((element) => element.focus({ preventScroll: true }));
  const keyBefore = await metrics();
  await page.keyboard.press("PageUp");
  await page.waitForTimeout(350);
  assert((await metrics()).top < keyBefore.top, "PageUp did not browse history");
  await stable("keyboard PageUp stays released");

  await page.keyboard.press("End");
  await page.waitForTimeout(450);
  assert(!(await followButton().count()), "End did not restore follow");
  assert((await metrics()).gap < 48);
  await record("manual End at bottom resumes following");

  await wheel(-700);
  const touchBefore = await metrics();
  const box = await viewport.boundingBox();
  const cdp = await context.newCDPSession(page);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 3);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x, y: y + i * 18 }],
    });
    await page.waitForTimeout(30);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(600);
  assert((await metrics()).top < touchBefore.top, "touch did not browse history");
  await stable("native touch scroll stays released");

  const scrollbar = viewport.locator("..").locator('[data-orientation="vertical"]');
  await viewport.hover();
  await scrollbar.waitFor({ state: "visible" });
  const thumb = await scrollbar.locator("div").first().boundingBox();
  const dragBefore = await metrics();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 - 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert((await metrics()).top < dragBefore.top, "scrollbar drag did not browse history");
  await stable("scrollbar drag stays released");

  const visibleParagraph = await viewport.evaluate((element) => {
    const view = element.getBoundingClientRect();
    const paragraph = [...element.querySelectorAll("p")].find((node) => {
      const bounds = node.getBoundingClientRect();
      return node.textContent.includes("用于检查历史") && bounds.y > view.y + 30 && bounds.y < view.bottom - 50;
    });
    if (!paragraph) return null;
    const bounds = paragraph.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y };
  });
  assert(visibleParagraph, "no visible message to select");
  await page.mouse.move(visibleParagraph.x + 8, visibleParagraph.y + 8);
  await page.mouse.down();
  await page.mouse.move(visibleParagraph.x + 160, visibleParagraph.y + 8, { steps: 8 });
  await page.mouse.up();
  assert(await page.evaluate(() => Boolean(window.getSelection()?.toString())), "message selection failed");
  await stable("message text selection stays released");

  await wheel(100_000);
  for (let i = 0; i < 10 && await followButton().count(); i++) await page.waitForTimeout(100);
  assert(!(await followButton().count()), `downward wheel to bottom did not restore follow: ${JSON.stringify(await metrics())}`);
  await record("manual downward wheel restores following");

  // 可见的历史思考块展开后，后续增量不得折叠它或抢回底部。
  await viewport.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);
  const thought = viewport.getByRole("button", { name: /思考了/ }).first();
  await thought.click();
  assert.equal(await thought.getAttribute("aria-expanded"), "true");
  await stable("historical reasoning disclosure stays readable");

  const tool = viewport.locator('[data-chat-item^="tool-"]').first();
  await tool.getByRole("button", { name: /参数与结果/ }).click();
  const args = tool.getByRole("region").first();
  await args.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const argsBounds = await args.boundingBox();
  const nestedBefore = await metrics();
  await page.mouse.move(argsBounds.x + argsBounds.width / 2, argsBounds.y + argsBounds.height / 2);
  await page.mouse.wheel(0, 100_000);
  await page.waitForTimeout(150);
  assert(await args.evaluate((element) => element.scrollTop > 0), "tool details did not scroll");
  await page.mouse.wheel(0, -100_000);
  await page.waitForTimeout(150);
  assert(Math.abs((await metrics()).top - nestedBefore.top) < 2, "tool details scrolled outer history");
  await args.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("End");
  await page.waitForTimeout(250);
  assert(Math.abs((await metrics()).top - nestedBefore.top) < 2, "nested keyboard End scrolled outer history");
  await stable("nested tool arguments scroll independently");

  // 新视图默认跟随，返回旧会话按消息 ID 与偏移恢复。
  const saved = await metrics();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.waitForTimeout(400);
  assert(!(await followButton().count()), "new view inherited released state");
  await page.getByRole("button", { name: /^流式滚动验收/ }).click();
  await viewport.locator('[data-chat-item="streaming"]').waitFor();
  await page.waitForTimeout(400);
  const restored = await metrics();
  assert.equal(restored.anchor, saved.anchor);
  assert(Math.abs(restored.offset - saved.offset) < 2);
  await stable("switching sessions restores reading position");

  await page.screenshot({ path: resolve(evidence, "history-reading.png") });
  await page.keyboard.press("Control+.");
  await viewport.locator('[data-chat-item="streaming"]').waitFor({ state: "detached", timeout: 15000 });
  await page.waitForTimeout(600);
  await stable("stop and streaming finalization preserve reading position");
  await follow();
  await record("follow after stream ends");
  await page.screenshot({ path: resolve(evidence, "following-latest.png") });

  await wheel(-800);
  await page.getByRole("radio", { name: /^文件/ }).click();
  await page.getByRole("button", { name: /^scroll.csv/ }).click();
  await page.getByRole("button", { name: "收起对话（表格全屏）", exact: true }).waitFor();
  await page.waitForTimeout(200);
  const beforeHidden = await metrics();
  await page.getByRole("button", { name: "收起对话（表格全屏）", exact: true }).click();
  await viewport.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "展开对话", exact: true }).click();
  await viewport.waitFor();
  await page.waitForTimeout(200);
  const afterHidden = await metrics();
  assert.equal(afterHidden.anchor, beforeHidden.anchor);
  assert(Math.abs(afterHidden.offset - beforeHidden.offset) < 2);
  await stable("hidden panel remount restores reading position");

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await viewport.waitFor();
  await page.waitForTimeout(200);
  const beforeTab = await metrics();
  await page.getByRole("tab", { name: "表格", exact: true }).click();
  await viewport.waitFor({ state: "detached" });
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await viewport.waitFor();
  await page.waitForTimeout(200);
  assert.equal((await metrics()).anchor, beforeTab.anchor);
  assert(Math.abs((await metrics()).offset - beforeTab.offset) < 2);
  await stable("narrow sheet chat tabs restore reading position");
  assert.deepEqual(errors, [], "browser runtime errors");
  console.log(JSON.stringify({ passed: results.length, results, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(evidence, "failure.png") });
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(evidence, "browser-results.json"), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
