// 启动 ui-preview-server.ts（全新临时数据目录、生产 Web 构建）；所有读写走真实 HTTP/WS/SQLite。
// PLAYWRIGHT_MODULE=<index.mjs> node packages/web/test/fixtures/provider-logos-browser.mjs <url> <evidenceDir>
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.argv[2];
assert(url, "fixture URL required");
const evidence = resolve(process.argv[3] ?? "docs/acceptance/provider-logos-2026-10-02");
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => localStorage.setItem("excelmanus.onboarding", "done"));
const page = await context.newPage();
const errors = [];
const externalRequests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (new URL(r.url()).origin !== url) externalRequests.push(r.url());
});
const results = [];
const record = (name) => results.push({ name, passed: true });
const api = async (path, options) => {
  const response = await context.request.fetch(`${url}/api/v1/${path}`, options);
  assert(response.ok(), `${path}: ${response.status()}`);
  return response.json();
};
const imagesReady = async (locator) => {
  await locator.first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('img[src^="/providers/"]')].every((i) => i.complete && i.naturalWidth > 0));
};
const shot = (name) => page.screenshot({ path: resolve(evidence, `${name}.png`), animations: "disabled" });
const currentModel = () => page.getByRole("combobox", { name: "当前代理使用的模型档案（与 /model 相同，从下一步生效）", exact: true });
const logos = () => page.locator('img[src^="/providers/"]');

try {
  await page.goto(url);
  await page.locator("#composer-input").waitFor();
  const providers = (await api("providers")).items;
  const profiles = [];
  for (const p of providers.filter((p) => p.auth !== "subscription")) {
    const name = p.id === "openai" ? "OpenAI 长名称档案用于验证图标与文字截断" : `${p.displayName} 档案`;
    profiles.push((await api("model-profiles", { method: "POST", data: {
      name, provider: p.id, model: p.suggestedModels?.[0] ?? "logo-fixture",
      apiKey: "fixture-only", baseUrl: p.defaultBaseUrl ?? "https://mock.invalid/v1",
    } })).profile);
  }
  const manifest = JSON.parse(readFileSync("packages/web/public/providers/sources.json", "utf8"));
  for (const a of manifest.assets) {
    const response = await context.request.get(`${url}/providers/${a.file}`);
    assert(response.ok(), `${a.file}: missing from production build`);
    assert((await response.text()).startsWith("<svg"));
  }
  record("24 local SVG assets served by production build");
  await page.goto(url);
  await currentModel().waitFor();
  await imagesReady(logos());
  assert.equal(await currentModel().locator("img").getAttribute("src"), "/providers/openai.svg");
  assert.equal(await page.locator(".empty-chat-context img").last().getAttribute("src"), "/providers/openai.svg");
  await shot("chat-light");
  await currentModel().click();
  assert.equal(await page.getByRole("option").locator("img").count(), profiles.length);
  await imagesReady(logos());
  await shot("model-options");
  const deepseek = profiles.find((p) => p.provider === "deepseek");
  await page.getByRole("option", { name: deepseek.name, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.chat-header img[src="/providers/deepseek.svg"]'));
  assert.equal(await page.locator(".empty-chat-context img").last().getAttribute("src"), "/providers/deepseek.svg");
  record("model options have logos and switch updates header and landing through real session sync");

  await page.getByRole("button", { name: /^设置/ }).click();
  const dialog = page.getByRole("dialog");
  await imagesReady(dialog.locator(".settings-profile-icon img"));
  assert.equal(await dialog.locator(".settings-profile-icon img").count(), profiles.length);
  assert(await dialog.locator('img[src="/providers/xai.svg"]').count());
  assert(await dialog.locator('img[src="/providers/ollama.svg"]').count());
  assert(await dialog.locator('img[src="/providers/default.svg"]').count());
  await shot("profiles-light");
  await dialog.getByRole("button", { name: "新增档案", exact: true }).click();
  const providerSelect = dialog.getByRole("combobox", { name: "供应商", exact: true });
  await providerSelect.click();
  assert.equal(await page.getByRole("option").locator("img").count(), providers.filter((p) => p.auth !== "subscription").length);
  await imagesReady(logos());
  await shot("provider-options-light");
  await page.getByRole("option", { name: "DeepSeek（国内直连）", exact: true }).click();
  assert.equal(await providerSelect.locator("img").getAttribute("src"), "/providers/deepseek.svg");
  const modelInput = dialog.getByRole("combobox", { name: "模型", exact: true });
  await modelInput.fill("deepseek");
  assert.equal(await page.getByRole("option").first().locator("img").getAttribute("src"), "/providers/deepseek.svg");
  await page.keyboard.press("Escape");
  record("provider options, selected value, model input and filtered model candidates use provider logos");

  await dialog.getByRole("button", { name: /^权限与运行/ }).click();
  await dialog.getByText("按用途分配模型", { exact: true }).waitFor();
  const sub = dialog.getByRole("combobox", { name: "子代理", exact: true });
  await sub.click();
  assert.equal(await page.getByRole("option").locator("img").count(), profiles.length);
  await page.getByRole("option", { name: deepseek.name, exact: true }).click();
  assert.equal(await sub.locator("img").getAttribute("src"), "/providers/deepseek.svg");
  await shot("roles-light");
  record("main model and role assignment options have logos");
  await dialog.getByRole("button", { name: /^订阅账号/ }).click();
  await dialog.getByText("ChatGPT / Codex", { exact: true }).waitFor();
  assert.equal(await dialog.locator(".settings-section-heading img").getAttribute("src"), "/providers/openai.svg");
  await shot("subscription-light");
  record("ChatGPT subscription heading shares OpenAI logo");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "切换深色 / 浅色", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await shot("chat-dark");
  assert.equal(await currentModel().locator("img").evaluate((i) => getComputedStyle(i).filter), "invert(1)");
  await page.getByRole("button", { name: /^设置/ }).click();
  await dialog.getByRole("button", { name: /^模型/ }).click();
  await imagesReady(dialog.locator(".settings-profile-icon img"));
  assert.equal(await dialog.locator('img[src="/providers/bytedance.svg"]').evaluate((i) => getComputedStyle(i).filter), "none");
  await shot("profiles-dark");
  record("dark theme inverts monochrome logos while preserving color logos");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 960, height: 768 });
  await shot("chat-960");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert(await currentModel().locator("img").isVisible());
  record("960px view keeps the model logo visible without page overflow");
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  record("no page errors or third-party UI requests");
} finally {
  writeFileSync(resolve(evidence, "results.json"), JSON.stringify({ results, errors, externalRequests }, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results));
