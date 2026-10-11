// Electron 主进程入口：app.whenReady() 后运行同一套 probe，随后退出。
// 若 whenReady 在本环境不触发（实测出现过），15s 后照样在主进程上下文运行 probe——
// node:sqlite 是 Node builtin，是否 ready 不改变其加载路径；但把 ready 是否到达如实记录。
// .ts 探测依赖宿主 Node 类型剥离；失败则 stripTypeScriptTypes 现剥为 .mjs 再载入。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const { app } = electron;
const srcDir = dirname(fileURLToPath(import.meta.url));

const watchdog = setTimeout(() => {
  console.error("watchdog: exceeded 60s");
  process.exit(3);
}, 60_000);

async function loadProbe() {
  try {
    return await import("./probe.ts");
  } catch (e) {
    console.error("direct .ts import failed:", e instanceof Error ? e.message : e);
    const stripped = stripTypeScriptTypes(readFileSync(join(srcDir, "probe.ts"), "utf8"), {
      mode: "strip",
    });
    mkdirSync(join(srcDir, "..", "results"), { recursive: true });
    const out = join(srcDir, "..", "results", "probe-stripped.mjs");
    writeFileSync(out, stripped);
    return import(out);
  }
}

let readyFired = false;
const ready = app
  .whenReady()
  .then(() => {
    readyFired = true;
  })
  .catch(() => {});
await Promise.race([ready, new Promise((r) => setTimeout(r, 15_000))]);
console.log(
  `app.ready fired: ${readyFired} (process.type=${process.type}, electron=${process.versions.electron})`,
);

try {
  globalThis.__PROBE_ENV_EXTRA = { appReadyFired: readyFired, processType: process.type };
  const { runProbe } = await loadProbe();
  await runProbe("electron-main");
} catch (e) {
  console.error("electron-main probe failed:", e);
  process.exitCode = 1;
} finally {
  try {
    app.quit();
  } catch {}
  // app.quit 在未 ready 时可能不生效，兜底直接退出
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
  clearTimeout(watchdog);
}
