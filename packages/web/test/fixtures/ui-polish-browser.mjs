// 真实 HTTP/WS/SQLite 页面复核；先启动 ui-preview-server.ts 并放入 25 行、5 列的示例 CSV。
// PLAYWRIGHT_MODULE=<index.mjs> node packages/web/test/fixtures/ui-polish-browser.mjs <url> <evidenceDir>
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.argv[2];
assert(url, "preview URL required");
const evidence = resolve(process.argv[3] ?? "docs/acceptance/ui-polish-2026-10-02");
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const results = [];
const errors = [];
const warnings = [];
const scripts = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
  if (message.type() === "warning") warnings.push(message.text());
});
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (path.endsWith(".js")) scripts.push(path);
});
const input = () => page.locator("textarea[role=combobox]");
const shot = async (name) => {
  await frames();
  await page.waitForFunction(() => ![...document.querySelectorAll('.settings-body [data-slot="skeleton"]')].some((node) => node.getBoundingClientRect().height > 0));
  const workbook = page.locator(".univer-host");
  if (await workbook.count()) {
    await workbook.getByText("Sheet1", { exact: true }).first().waitFor({ timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await workbook.locator('[data-u-comp="workbench-skeleton-toolbar"]').waitFor({ state: "hidden", timeout: 15000 });
    await frames();
  }
  return page.screenshot({ path: resolve(evidence, `${name}.png`), animations: "disabled" });
};
const record = (name, data = {}) => results.push({ name, ...data });
const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const layout = async (name) => {
  await frames();
  const metric = await page.evaluate(() => {
    const dock = document.querySelector(".composer-dock");
    const panel = document.querySelector(".chat-panel");
    const header = document.querySelector(".chat-header");
    const box = dock?.getBoundingClientRect();
    return {
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      panelWidth: panel?.clientWidth, headerHeight: header?.clientHeight,
      composer: box ? { x: box.x, top: box.top, right: box.right, bottom: box.bottom } : null,
      outerTop: document.documentElement.scrollTop,
    };
  });
  assert(metric.scrollWidth <= metric.width, `${name}: horizontal overflow`);
  assert.equal(metric.outerTop, 0, `${name}: outer page scroll`);
  if (metric.composer) {
    assert(metric.composer.bottom <= metric.height + 1, `${name}: composer outside viewport`);
    assert(metric.composer.top >= 60, `${name}: composer covers header`);
    assert(metric.composer.right <= metric.width + 1, `${name}: composer horizontal overflow`);
    assert(await page.getByRole("button", { name: "发送", exact: true }).isVisible());
  }
  record(name, metric);
};

try {
  await page.goto(url);
  await input().waitFor();
  assert(!scripts.some((path) => /\/Workbench-/.test(path)), "workbook engine loaded on landing");
  record("landing avoids workbook engine", { scripts: [...scripts] });
  if (await page.getByRole("button", { name: "跳过", exact: true }).count()) {
    await shot("onboarding-1440");
    await page.getByRole("button", { name: "跳过", exact: true }).click();
  }
  if (await page.getByText("尚未配置模型", { exact: true }).count()) {
    await page.getByRole("button", { name: /^设置/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "供应商", exact: true }).click();
    await page.getByRole("option", { name: "OpenAI 兼容接口（自定义）", exact: true }).click();
    await dialog.getByRole("textbox", { name: "名称", exact: true }).fill("界面验收模型");
    await dialog.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://mock.invalid/v1");
    await dialog.getByRole("textbox", { name: "API Key", exact: true }).fill("ui-fixture-only");
    await dialog.getByRole("combobox", { name: "模型", exact: true }).fill("ui-preview");
    await dialog.getByRole("button", { name: "新增档案", exact: true }).click();
    await dialog.getByText("界面验收模型", { exact: true }).first().waitFor();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.locator(".empty-chat").waitFor();
  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [768, 768]]) {
    await page.setViewportSize({ width, height });
    await layout(`empty-${width}`);
    assert.equal(await page.locator(".starter-card").count(), 6);
    assert.equal(await page.getByRole("region", { name: "对话历史", exact: true }).evaluate((e) => e.scrollTop), 0);
    await shot(`empty-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".starter-card").first().click();
  await page.waitForFunction(() => document.getElementById("composer-input") === document.activeElement);
  assert.equal(await input().evaluate((e) => e === document.activeElement), true);
  assert((await input().inputValue()).length > 0);
  record("task card fills and focuses composer");
  await input().fill("草稿会保留\n第二行");
  await page.reload();
  await input().waitFor();
  assert.equal(await input().inputValue(), "草稿会保留\n第二行");
  await input().fill("");
  record("draft survives reload");

  await page.getByRole("button", { name: /^设置/ }).click();
  const dialog = page.getByRole("dialog");
  const tabLabels = ["模型", "订阅账号", "权限与运行", "规则", "记忆", "技能", "MCP 服务器", "工作区与备份", "外观与关于"];
  for (const label of tabLabels) {
    await dialog.locator("nav").getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await dialog.getByRole("heading", { name: label, exact: true, level: 2 }).waitFor();
    const metric = await dialog.evaluate((e) => ({ width: e.clientWidth, scroll: e.scrollWidth }));
    assert(metric.scroll <= metric.width + 1, `${label}: settings overflow`);
    record(`settings-${label}`, metric);
  }
  await dialog.locator("nav").getByRole("button", { name: /^模型/ }).click();
  await shot("settings-models-1440");
  await dialog.locator("nav").getByRole("button", { name: /^权限与运行/ }).click();
  await shot("settings-general-1440");
  for (let i = 0; i < 24; i++) await page.keyboard.press("Tab");
  assert(await dialog.evaluate((e) => e.contains(document.activeElement)), "dialog focus escaped");
  record("settings keyboard focus stays inside dialog");
  await page.setViewportSize({ width: 1024, height: 768 });
  await shot("settings-1024");
  const settingsBox = await dialog.boundingBox();
  assert(settingsBox.x >= 0 && settingsBox.x + settingsBox.width <= 1024);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("设置"));
  assert(await page.getByRole("button", { name: /^设置/ }).evaluate((e) => e === document.activeElement));
  record("settings Escape closes and restores focus");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: /^文件/ }).click();
  await page.getByRole("button", { name: /^月度销售报表\.csv/ }).click();
  await page.getByText("Sheet1", { exact: true }).first().waitFor({ timeout: 15000 });
  assert(scripts.some((path) => /\/Workbench-/.test(path)), "workbook engine did not load on open");
  await layout("workbench-1440");
  await shot("workbench-1440");
  const splitter = page.getByRole("separator", { name: "拖动调整表格与对话的宽度", exact: true });
  const ratio = await splitter.getAttribute("aria-valuenow");
  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  assert.notEqual(await splitter.getAttribute("aria-valuenow"), ratio);
  await splitter.dblclick();
  record("splitter supports keyboard and reset");
  await page.getByRole("combobox", { name: /会话权限/ }).click();
  await page.getByRole("option", { name: "谨慎", exact: true }).click();
  await input().fill("整理月度销售数据");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const confirm = page.getByRole("button", { name: /^确认此区域/ });
  await confirm.waitFor({ timeout: 15000 });
  await layout("range-confirm-1440");
  await shot("range-confirm-1440");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await layout("range-confirm-1024");
  await confirm.click();
  const approve = page.getByRole("button", { name: "批准", exact: true });
  await approve.waitFor();
  await page.getByRole("button", { name: "更多审批操作", exact: true }).click();
  await page.getByRole("menuitem", { name: /^本会话同类/ }).waitFor();
  assert.equal(await page.locator(".approval-card").count(), 1);
  await page.keyboard.press("Escape");
  await approve.waitFor();
  record("opening approval menu does not submit a decision");
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByRole("textbox", { name: /^拒绝理由/ }).fill("页面验收理由");
  await page.keyboard.press("Escape");
  await approve.waitFor();
  record("deny reason can be entered and cancelled without deciding");
  await layout("approval-1024");
  await shot("approval-1024");
  await page.setViewportSize({ width: 1280, height: 720 });
  await layout("approval-1280-short");
  const approvalBox = await approve.boundingBox();
  const pendingBox = await page.getByRole("region", { name: "查看待处理事项", exact: true }).boundingBox();
  assert(approvalBox.y >= pendingBox.y && approvalBox.y + approvalBox.height <= pendingBox.y + pendingBox.height + 1);
  record("approval actions remain visible in short viewport");
  await shot("approval-1280-short");
  await approve.click();
  await page.getByText("已在 E 列", { exact: false }).first().waitFor();
  if (await page.getByRole("tab", { name: "表格", exact: true }).count()) {
    await page.getByRole("tab", { name: "表格", exact: true }).click();
  }
  await page.getByText("已写回文件", { exact: true }).waitFor();
  assert(await page.getByText("修订 1", { exact: true }).count());
  record("approval commits revision and checkpoint through real server");
  const changes = page.getByRole("navigation", { name: "本轮改动", exact: true });
  await changes.locator(".line-through").getByText("原备注", { exact: true }).waitFor();
  assert.equal(await changes.locator(".font-semibold.text-ok-ink").innerText(), "备注");
  record("before and after values use committed server snapshot");
  await shot("sheet-1280");
  for (const [width, height] of [[1024, 768], [768, 768]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("tab", { name: "表格", exact: true }).click();
    await layout(`sheet-${width}`);
    await changes.locator(".line-through").getByText("原备注", { exact: true }).waitFor();
    assert.equal(await changes.locator(".font-semibold.text-ok-ink").innerText(), "备注");
    assert(await page.getByRole("textbox", { name: "给代理发消息…", exact: true }).isVisible());
    await shot(`sheet-${width}`);
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    await layout(`chat-${width}`);
    await shot(`chat-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  record("committed values survive sheet remounts at 1024 and 768");
  await page.getByRole("button", { name: "切换深色 / 浅色", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await layout("dark-workbench-1440");
  await shot("dark-workbench-1440");
  await page.getByRole("button", { name: /^设置/ }).click();
  await shot("dark-settings-1440");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "切换深色 / 浅色", exact: true }).click();
  await input().fill("改值");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await approve.waitFor();
  await page.getByRole("button", { name: "更多审批操作", exact: true }).click();
  const rememberedRequest = page.waitForRequest((request) => request.method() === "POST" && /\/approvals\//.test(request.url()));
  await page.getByRole("menuitem", { name: /^本会话同类/ }).click();
  assert.deepEqual((await rememberedRequest).postDataJSON(), { decision: "approve", remember: true });
  await page.getByText("已更新 D2:D3。", { exact: true }).waitFor();
  assert.match(await page.getByRole("combobox", { name: /会话权限/ }).innerText(), /谨慎/);
  record("explicit menu choice approves and remembers without changing permission mode");
  await shot("automatic-approval-result-1440");
  await page.getByRole("button", { name: "关闭工作簿", exact: true }).click();
  await page.getByRole("radio", { name: /^会话/ }).click();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.locator(".starter-card").first().waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".starter-card").first().hover();
  const motion = await page.locator(".starter-card").first().evaluate((e) => ({
    duration: getComputedStyle(e).transitionDuration, transform: getComputedStyle(e).transform,
  }));
  assert.equal(motion.transform, "none");
  assert(motion.duration.split(",").every((value) => Number.parseFloat(value) <= 0.001));
  record("reduced motion disables hover movement", motion);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await shot("final-empty-1440");
  await page.getByRole("radio", { name: /^文件/ }).click();
  await page.getByRole("button", { name: /^月度销售报表\.csv/ }).click();
  await page.getByText("Sheet1", { exact: true }).first().waitFor();
  await input().fill("慢只读");
  await input().press("Enter");
  const stop = page.getByRole("button", { name: "暂停", exact: true });
  await stop.waitFor();
  await page.waitForFunction(() => document.getElementById("composer-input") === document.activeElement);
  assert.equal(await page.getByRole("button", { name: /^回到最新/ }).count(), 0);
  record("first message keeps composer focus and follows new activity");
  await input().fill("运行中的追加消息");
  await layout("running-1440");
  const controls = await page.locator(".composer-toolbar button").evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    return { name: item.getAttribute("aria-label") ?? item.textContent, left: box.left, right: box.right, bottom: box.bottom };
  }));
  const dock = await page.locator(".composer-dock").boundingBox();
  assert(controls.every((control) => control.left >= dock.x && control.right <= dock.x + dock.width + 1 && control.bottom <= 900));
  record("running composer actions fit inside panel", { controls });
  await shot("running-1440");
  await page.keyboard.press("Control+.");
  await page.locator('.composer-dock[data-running="true"]').waitFor({ state: "hidden", timeout: 15000 });
  record("stop settles through server");
  assert.equal(errors.length, 0, `browser errors: ${errors.join("; ")}`);
  writeFileSync(resolve(evidence, "results.json"), JSON.stringify({ results, errors, warnings, scripts }, null, 2));
  console.log(JSON.stringify({ passed: results.length, errors, warnings }));
} catch (error) {
  await shot("failure");
  writeFileSync(resolve(evidence, "failure.json"), JSON.stringify({ error: String(error), results, errors, warnings }, null, 2));
  throw error;
} finally {
  await browser.close();
}
