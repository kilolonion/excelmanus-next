// 桌面打包（13 §4.1、ADR 0010）：@electron/packager 把 build/app 打成当前平台的应用目录，
// 再压缩为发布用 zip，并输出体积报告（预算 ≤ 250 MB，超出即失败）。
// electron-builder 的依赖含 WTFPL 许可证，不满足许可证白名单，故不用它生成 DMG/NSIS。
// 用法：node packages/desktop/scripts/pack.ts [--arch arm64|x64]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { packager } from "@electron/packager";

const BUDGET_BYTES = 250 * 1024 * 1024;
const pkgDir = join(import.meta.dirname, "..");
const appDir = join(pkgDir, "build", "app");
const outDir = join(pkgDir, "build", "out");
if (!existsSync(join(appDir, "package.json"))) {
  console.error("缺少 build/app：先运行 node packages/desktop/scripts/build.ts");
  process.exit(1);
}
const archArg = process.argv.indexOf("--arch");
const arch = (archArg >= 0 ? process.argv[archArg + 1] : process.arch) as "arm64" | "x64";

rmSync(outDir, { recursive: true, force: true });
const [dir] = await packager({
  dir: appDir,
  out: outDir,
  arch,
  platform: process.platform as "darwin" | "win32" | "linux",
  name: "ExcelManus",
  appBundleId: "com.excelmanus.next",
  appCopyright: "ExcelManus",
  asar: false,
  overwrite: true,
  prune: false,
  // 源码映射与许可证说明文件保留在包内（诊断用），测试夹具不进包
  ignore: [/\.map$/],
});
if (!dir) throw new Error("打包失败");

const size = (p: string): number => {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, name) => n + size(join(p, name)), 0);
};
const total = size(dir);
const zip = `${dir}.zip`;
if (process.platform === "darwin") {
  execFileSync("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    join(dir, "ExcelManus.app"),
    zip,
  ]);
} else {
  execFileSync("tar", ["-a", "-c", "-f", zip, "-C", dir, "."]);
}
const zipped = statSync(zip).size;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(
  JSON.stringify(
    { dir, zip, unpacked: mb(total), zipped: mb(zipped), budget: mb(BUDGET_BYTES) },
    null,
    2,
  ),
);
if (zipped > BUDGET_BYTES) {
  console.error(`安装包 ${mb(zipped)} 超出预算 ${mb(BUDGET_BYTES)}`);
  process.exit(1);
}
