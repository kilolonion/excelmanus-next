// PLAYWRIGHT_MODULE=<index.mjs> node packages/web/test/fixtures/composer-settings-browser.mjs <url> <evidenceDir>
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.argv[2];
assert(url, "fixture URL required");
const evidence = resolve(process.argv[3] ?? "docs/acceptance/composer-settings-2026-10-02");
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem("excelmanus.onboarding", "done"));
const page = await context.newPage();
const results = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const api = async (path, options) => {
  const response = await context.request.fetch(`${url}/api/v1/${path}`, options);
  assert(response.ok(), `${path}: ${response.status()}`);
  return response.json();
};
const wait = async (predicate, message) => {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await page.waitForTimeout(50);
  }
};
const record = (name) => results.push({ name, passed: true });
const level = () => page.getByRole("combobox", { name: "思考等级", exact: true });
const composer = () => page.locator("#composer-input");
const remove = (name) => page.getByRole("button", { name: `移除附件：${name}`, exact: true });
const choose = async (value) => {
  await level().click();
  await page.getByRole("option", { name: value, exact: true }).click();
  await wait(() => level().isEnabled(), "reasoning save timeout");
  assert((await level().innerText()).includes(value));
};
const upload = async (files) => {
  await page.locator('input[type="file"][multiple]').setInputFiles(files);
  await wait(async () => !(await page.getByText("上传中…", { exact: true }).count()), "upload timeout");
};
const png = { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") };
let sessionId;
const logs = async () => (await api(`sessions/${sessionId}/log`)).items;
const messageCount = async () => (await logs()).filter((r) => r.type === "user.message").length;
try {
  await page.goto(url);
  await level().waitFor();
  await page.getByRole("button", { name: /^输入框验收/ }).click();
  sessionId = (await api("sessions")).items.find((s) => s.title === "输入框验收").id;
  const profile = (await api("model-profiles")).items.find((p) => p.isDefault);
  await level().click();
  assert.equal(await page.getByRole("option", { name: "最少", exact: true }).count(), 0);
  assert.equal(await page.getByRole("option").count(), 7);
  await page.getByRole("option").first().focus();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(evidence, "level-options.png") });
  await page.getByRole("option").first().press("Escape");
  for (const [label, value] of [["无", "none"], ["低", "low"], ["中", "medium"], ["高", "high"], ["极高", "xhigh"], ["最高", "max"], ["默认", "provider-default"]]) {
    await choose(label);
    assert.equal((await api("model-profiles")).items.find((p) => p.id === profile.id).reasoning, value);
  }
  record("seven visible reasoning levels persist, minimal is absent from choices");
  await choose("最高");
  await composer().fill("最高等级验收");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("模型等级：max；收到图片：0；文件引用：0", { exact: true }).waitFor();
  record("max reaches gateway as provider option without degrading to xhigh");
  await choose("高");
  await page.reload();
  await level().waitFor();
  assert((await level().innerText()).includes("高"));
  record("reasoning survives page reload");

  await page.route("**/api/v1/model-profiles/*", (route) => route.request().method() === "PATCH" ? route.abort() : route.continue());
  await level().click();
  await page.getByRole("option", { name: "低", exact: true }).click();
  await wait(() => level().isEnabled(), "failed save did not finish");
  assert((await level().innerText()).includes("高"));
  assert.equal((await api("model-profiles")).items.find((p) => p.id === profile.id).reasoning, "high");
  await page.unroute("**/api/v1/model-profiles/*");
  record("failed reasoning save retains previous value");

  const fileInput = page.locator('input[type="file"][multiple]');
  assert.equal(await fileInput.getAttribute("accept"), null);
  await upload([
    { name: "数据 表.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") },
    { name: "arbitrary.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 255]) },
    { name: "drawing.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    png,
  ]);
  assert.equal(await page.getByRole("button", { name: /^移除附件：/ }).count(), 4);
  await page.mouse.move(1100, 100);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: resolve(evidence, "desktop.png") });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("模型等级：high；收到图片：1；文件引用：3", { exact: true }).waitFor();
  const message = (await logs()).filter((r) => r.type === "user.message").at(-1).data;
  for (const name of ["数据 表.csv", "arbitrary.bin", "drawing.svg"]) assert(message.text.includes(`@${name}`));
  assert.equal(message.attachments.length, 1);
  await page.getByRole("img", { name: "pixel.png", exact: true }).waitFor();
  assert.equal(await page.getByRole("img", { name: "pixel.png", exact: true }).evaluate((img) => img.naturalWidth), 1);
  assert.equal(await page.getByRole("button", { name: /^移除附件：/ }).count(), 0);
  record("mixed multi-file upload sends three path references and one image through real runtime and gateway");

  await composer().fill("/model 备用验收模型");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await wait(async () => (await level().innerText()).includes("最少"), "switched model did not update level");
  await level().click();
  assert.equal(await page.getByRole("option", { name: /最少/ }).count(), 0);
  await page.getByRole("option").first().press("Escape");
  assert.equal((await api("model-profiles")).items.find((p) => p.name === "备用验收模型").reasoning, "minimal");
  await page.getByRole("button", { name: /^设置/ }).click();
  const dialog = page.getByRole("dialog");
  const legacyCard = dialog.locator('[data-slot="card"]').filter({ hasText: "备用验收模型" });
  await legacyCard.getByRole("button", { name: "编辑", exact: true }).click();
  const editorLevel = legacyCard.getByRole("combobox", { name: "默认思考强度", exact: true });
  assert((await editorLevel.innerText()).includes("最少（已保存）"));
  await editorLevel.click();
  assert.equal(await page.getByRole("option", { name: /最少/ }).count(), 0);
  assert.equal(await page.getByRole("option").count(), 7);
  await page.getByRole("option").first().focus();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(evidence, "settings-level-options.png") });
  await page.getByRole("option").first().press("Escape");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  record("settings shares seven choices and reads legacy minimal without rewriting it");
  await choose("低");
  const profiles = (await api("model-profiles")).items;
  assert.equal(profiles.find((p) => p.name === "备用验收模型").reasoning, "low");
  assert.equal(profiles.find((p) => p.id === profile.id).reasoning, "high");
  await composer().fill("/model 输入框验收模型");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await wait(async () => (await level().innerText()).includes("高"), "original model level not restored");
  record("reasoning selector follows model switch and changes only active profile");
  record("saved minimal remains readable without appearing as a selectable option");

  await upload([{ name: "existing.txt", mimeType: "text/plain", buffer: Buffer.from("different bytes") }]);
  await remove("existing.txt").waitFor();
  await composer().fill("失败上传不能发送");
  const before = await messageCount();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("文件尚未上传完成或上传失败，请等待完成或移除失败的文件后发送", { exact: true }).waitFor();
  assert.equal(await messageCount(), before);
  const workspace = (await api("workspaces")).items.find((w) => w.isDefault);
  const original = await context.request.get(`${url}/api/v1/workspaces/${workspace.id}/files/download?path=existing.txt`);
  assert.equal(await original.text(), "original fixture bytes");
  await remove("existing.txt").click();
  record("same-name upload conflicts without overwriting or silently sending old file");

  await upload([{ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry fixture") }]);
  await page.route("**/agents/main/messages", (route) => route.abort());
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await wait(async () => (await composer().inputValue()) === "失败上传不能发送", "failed send did not restore draft");
  assert(await remove("retry.txt").isVisible());
  await page.unroute("**/agents/main/messages");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("模型等级：high；收到图片：0；文件引用：1", { exact: true }).waitFor();
  assert.equal((await logs()).filter((r) => r.type === "user.message").at(-1).data.text.split("@retry.txt").length, 2);
  record("failed send preserves draft and reference, retry sends reference once");

  let release;
  const held = new Promise((done) => { release = done; });
  let intercepted = false;
  await page.route("**/files/upload", async (route) => { intercepted = true; await held; await route.continue(); });
  await fileInput.setInputFiles([{ name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("late fixture") }]);
  await wait(async () => intercepted, "upload not intercepted");
  await page.getByRole("button", { name: /^隔离会话/ }).click();
  await wait(async () => (await page.getByRole("button", { name: /^移除附件：/ }).count()) === 0, "session switch did not clear references");
  assert.equal(await page.getByRole("button", { name: /^移除附件：/ }).count(), 0);
  release();
  await wait(async () => (await api(`workspaces/${workspace.id}/files`)).items.some((f) => f.name === "late.txt"), "late upload did not finish");
  await page.unroute("**/files/upload");
  assert.equal(await page.getByRole("button", { name: /^移除附件：/ }).count(), 0);
  assert.equal(await composer().inputValue(), "");
  record("late upload cannot attach to switched session");

  await page.setViewportSize({ width: 420, height: 850 });
  assert(await level().isVisible());
  assert(await page.getByRole("button", { name: "添加文件（也可粘贴或拖入）" }).isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const levelBox = await level().boundingBox();
  const sendBox = await page.getByRole("button", { name: "发送", exact: true }).boundingBox();
  assert(levelBox.x + levelBox.width <= sendBox.x || levelBox.y + levelBox.height <= sendBox.y || sendBox.y + sendBox.height <= levelBox.y, "narrow toolbar controls overlap");
  await level().focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "默认", exact: true }).click();
  await wait(() => level().isEnabled(), "narrow keyboard save timeout");
  await composer().fill("默认等级验收");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("模型等级：provider-default；收到图片：0；文件引用：0", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, "narrow.png") });
  record("narrow layout and keyboard choice work, provider-default reaches gateway without explicit reasoning");
  for (const p of (await api("model-profiles")).items) await api(`model-profiles/${p.id}`, { method: "DELETE" });
  await page.reload();
  await level().waitFor();
  assert(await level().isDisabled());
  record("reasoning selector disabled without model profile");
  assert.deepEqual(errors, []);
  record("no browser runtime errors");
  writeFileSync(resolve(evidence, "browser-results.json"), `${JSON.stringify({ results, errors }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed: results.length, evidence })}\n`);
} catch (error) {
  await page.screenshot({ path: resolve(evidence, "failure.png") });
  throw error;
} finally {
  await browser.close();
}
