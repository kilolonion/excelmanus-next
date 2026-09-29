// Electron utilityProcess 子进程：运行同一套 probe 并退出。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));

async function loadProbe() {
  try {
    return await import("./probe.ts");
  } catch (e) {
    const stripped = stripTypeScriptTypes(readFileSync(join(srcDir, "probe.ts"), "utf8"), {
      mode: "strip",
    });
    mkdirSync(join(srcDir, "..", "results"), { recursive: true });
    const out = join(srcDir, "..", "results", "probe-stripped.mjs");
    writeFileSync(out, stripped);
    return import(out);
  }
}

try {
  const { runProbe } = await loadProbe();
  await runProbe("electron-utility");
  process.exit(0);
} catch (e) {
  console.error("utility probe failed:", e);
  process.exit(1);
}
