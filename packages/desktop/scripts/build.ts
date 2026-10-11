// 桌面构建（13 §4.1）：esbuild 把主进程 / 预加载 / 后端 / 沙箱 worker 打成少量单文件，
// 连同前端产物、内置技能、模型目录快照、示例工作簿与 QuickJS wasm 放进 build/app。
// 用法：node packages/desktop/scripts/build.ts（需先 pnpm build:web）

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const pkgDir = join(import.meta.dirname, "..");
const repo = join(pkgDir, "../..");
const out = join(pkgDir, "build", "app");
const dist = join(out, "dist");

const webDist = join(repo, "packages/web/dist");
if (!existsSync(join(webDist, "index.html"))) {
  console.error("缺少前端产物：先运行 pnpm build:web");
  process.exit(1);
}

rmSync(join(pkgDir, "build"), { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// ESM 产物中的 CommonJS 依赖需要 require
const cjsShim = `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);`;
const common = {
  bundle: true,
  platform: "node" as const,
  target: "node24",
  sourcemap: "linked" as const,
  legalComments: "external" as const,
  logLevel: "warning" as const,
  // 本机网络库的可选原生加速包不打包（13 §4.1 避免原生依赖）
  external: ["electron", "bufferutil", "utf-8-validate"],
};

await build({
  ...common,
  entryPoints: { main: join(pkgDir, "src/main.ts"), backend: join(pkgDir, "src/backend.ts") },
  outdir: dist,
  format: "esm",
  outExtension: { ".js": ".mjs" },
  banner: { js: cjsShim },
});
await build({
  ...common,
  entryPoints: { "sandbox-worker": join(repo, "packages/sandbox/src/worker.ts") },
  outdir: dist,
  format: "esm",
  outExtension: { ".js": ".mjs" },
  banner: { js: cjsShim },
});
await build({
  ...common,
  entryPoints: { preload: join(pkgDir, "src/preload.ts") },
  outdir: dist,
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});

// QuickJS wasm：emscripten 模块按 import.meta.url 同目录加载
const req = createRequire(join(repo, "packages/sandbox/package.json"));
const variantDir = dirname(req.resolve("@jitl/quickjs-wasmfile-release-sync/package.json"));
cpSync(join(variantDir, "dist", "emscripten-module.wasm"), join(dist, "emscripten-module.wasm"));

cpSync(webDist, join(out, "web"), { recursive: true });
cpSync(join(repo, "assets/skills"), join(out, "skills"), { recursive: true });
cpSync(join(repo, "packages/models/catalog"), join(out, "catalog"), { recursive: true });
mkdirSync(join(out, "samples"), { recursive: true });
cpSync(join(repo, "samples/sales.xlsx"), join(out, "samples/sales.xlsx"));

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "excelmanus-next",
      productName: "ExcelManus",
      version: pkg.version === "0.0.0" ? "0.1.0" : pkg.version,
      type: "module",
      main: "dist/main.mjs",
      // electron-updater 读取的发布源（13 §4.3，GitHub Releases）
      build: { publish: [{ provider: "github" }] },
    },
    null,
    2,
  )}\n`,
);
console.log(`已构建：${out}`);
