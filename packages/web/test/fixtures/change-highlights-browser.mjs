// 真实后端夹具 + 生产 Web；PLAYWRIGHT_MODULE 指向外部 Playwright，不新增产品依赖。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const url = process.argv[2];
assert(url, 'fixture URL required');
const evidence = resolve(process.argv[3] ?? '.agents/tasks/change-highlights-2026-10-01');
mkdirSync(evidence, { recursive:true });
const browser = await chromium.launch({ headless:true });
const page = await browser.newPage({ viewport:{width:1440,height:900} });
const errors = [];
const results = [];
page.on('pageerror', e => errors.push(e.message));
const feedback = page.locator('[data-change-feedback]');
const nav = page.getByRole('navigation', {name:'本轮改动', exact:true});
const send = async text => {
  await page.locator('textarea').fill(text);
  await page.getByRole('button', {name:'发送', exact:true}).click();
};
const screenshot = name => page.screenshot({path:resolve(evidence, `${name}.png`)});
try {
  await page.goto(url);
  await page.locator('textarea').waitFor();
  const baseRev = Math.max(0, ...((await page.locator('body').innerText()).matchAll(/修订 (\d+)/g)).map(m => Number(m[1])));
  await send('连续修改高亮验收');
  await feedback.waitFor();
  await page.waitForFunction(rev => document.querySelector('[data-change-feedback]')?.textContent.includes(`修订 ${rev}`), baseRev + 3);
  await page.waitForTimeout(150);
  assert.match(await feedback.innerText(), /刚刚修改 · 2 处区域/);
  assert.match(await nav.innerText(), /3\s*\/\s*3/);
  const card = await feedback.boundingBox();
  assert(card.width < 500, 'feedback consumes too much of sheet');
  assert.equal(await feedback.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  await screenshot('fresh-overlapping-changes');
  results.push('三次真实写入：重复与交叠区域显示最新修订，提示不拦截表格');
  await feedback.waitFor({state:'detached',timeout:7500});
  assert.match(await nav.innerText(), /3\s*\/\s*3/);
  await screenshot('automatically-cleared');
  results.push('6 秒自动清除提示，三条变更记录保留');
  await page.getByRole('button', {name:'上一处改动',exact:true}).click();
  assert.match(await nav.innerText(), /2\s*\/\s*3/);
  await page.waitForTimeout(2300);
  assert.equal(await feedback.count(),0);
  results.push('淡出后可用导航重新定位，历史不重新播放改动提示');
  await send('再次修改同一区域');
  await feedback.waitFor();
  assert((await feedback.innerText()).includes(`修订 ${baseRev + 4}`));
  await page.getByRole('button',{name:'清除高亮',exact:true}).click();
  assert.equal(await feedback.count(),0);
  assert.match(await nav.innerText(), /1\s*\/\s*1/);
  await page.waitForTimeout(500);
  assert.equal(await feedback.count(),0);
  results.push('手动清除立即生效，后续新提交仍提示，记录保留');
  await page.reload();
  await page.locator('textarea').waitFor();
  await page.waitForTimeout(1800);
  // 打开文件后再验证，避免仅凭关闭工作簿而误判没有高亮。
  if (!(await nav.count())) {
    await page.getByRole('button', {name:/文件/}).click();
    await page.locator('[data-slot="file-item"]').filter({hasText:'sales.xlsx'}).click();
  }
  await nav.waitFor();
  await page.waitForTimeout(4500);
  assert.equal(await feedback.count(),0);
  results.push('刷新回放并重新打开工作簿，过期改动不重新高亮');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await send('深色减少动效修改');
  await feedback.waitFor();
  await page.waitForTimeout(900);
  assert.equal(await feedback.evaluate(el=>getComputedStyle(el).animationName),'none');
  await screenshot('dark-reduced-motion');
  await feedback.waitFor({state:'detached',timeout:6500});
  results.push('深色主题与减少动效：无入场动画，仍自动清除');
  await page.setViewportSize({width:1024,height:768});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.getByRole('tab',{name:'对话',exact:true}).click();
  await send('窄屏修改');
  await page.getByRole('tab',{name:'表格',exact:true}).click();
  await feedback.waitFor();
  await page.getByRole('button',{name:'清除高亮',exact:true}).waitFor({state:'visible'});
  await screenshot('narrow-1024');
  await page.getByRole('button',{name:'清除高亮',exact:true}).focus();
  await page.keyboard.press('Enter');
  assert.equal(await feedback.count(),0);
  results.push('1024px 窄屏提示可见，键盘可清除');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:results.length,results,errors},null,2));
} catch(e) {
  await screenshot('failure');
  console.error(e);
  console.log((await page.locator('body').innerText()).slice(-5000));
  process.exitCode=1;
} finally {
  writeFileSync(resolve(evidence,'browser-results.json'),JSON.stringify({results,errors},null,2));
  await browser.close();
}
