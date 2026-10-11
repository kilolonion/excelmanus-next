// Electron 主进程入口（utilityProcess 分支）：fork utility-child.mjs。
// utilityProcess.fork 官方文档不强制等待 ready，但 ready 不触发时 fork 可能同样受阻——
// 按 15s ready 竞速 + 40s 子进程看门狗如实记录。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const { app, utilityProcess } = electron;
const srcDir = dirname(fileURLToPath(import.meta.url));

const watchdog = setTimeout(() => {
  console.error("watchdog: exceeded 60s");
  process.exit(3);
}, 60_000);

let readyFired = false;
app.whenReady().then(() => {
  readyFired = true;
});
await Promise.race([app.whenReady().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
console.log(`app.ready fired: ${readyFired} (type=${process.type})`);

try {
  const child = utilityProcess.fork(join(srcDir, "utility-child.mjs"), [], {
    serviceName: "node-sqlite-probe",
  });
  child.on("message", (m) => console.log("[utility]", m));
  const code = await new Promise((res) => {
    child.once("exit", res);
    setTimeout(() => res("timeout40s"), 40_000);
  });
  console.log("utility child exit:", code);
  process.exit(typeof code === "number" ? code : 2);
} catch (e) {
  console.error("utilityProcess fork failed:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  clearTimeout(watchdog);
}
