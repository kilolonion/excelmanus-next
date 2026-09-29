// 追加回归用例（escape-cases.json 为负责人文件，不改）：悬空/外指符号链接写逃逸。
// E01 writeText 经悬空外指链接 → OUT_OF_WORKSPACE 且界外无文件
// E02 manage copy 目标为悬空外指链接 → 同
// E03 manage mkdir 路径中间段为外指链接（存在的界外目录）→ 同
// E03b 路径中间段为悬空外指链接 → 同
// E04 writeText 经工作区内有效链接 → 允许（防过度拒绝）
// 结果写 results/extra-cases.json。

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type RunOutcome, Sandbox } from "./sandbox.ts";
import { createSdkHost } from "./sdk-host.ts";

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESULTS_DIR = path.join(PKG_DIR, "results");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qjs-extra-"));
const ws = path.join(tmpRoot, "ws");
const outsideDir = path.join(tmpRoot, "outside");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(ws, "a.txt"), "source bytes");
fs.writeFileSync(path.join(ws, "inside-target.txt"), "original");
fs.writeFileSync(path.join(outsideDir, "keep.txt"), "sentinel");

// 链接布置：悬空外指 / 存在的界外目录 / 界内有效链接
fs.symlinkSync(path.join(outsideDir, "pwned.txt"), path.join(ws, "evil.txt"));
fs.symlinkSync(path.join(outsideDir, "pwned2.txt"), path.join(ws, "evil-copy.txt"));
fs.symlinkSync(outsideDir, path.join(ws, "out-link"), "dir");
fs.symlinkSync(path.join(outsideDir, "missing-dir"), path.join(ws, "dang-mid"), "dir");
fs.symlinkSync("inside-target.txt", path.join(ws, "good.txt"));

function treeChecksum(dir: string): string {
  const items: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        items.push(`L ${r}`);
      } else if (e.isDirectory()) {
        items.push(`D ${r}`);
        walk(path.join(d, e.name), r);
      } else {
        items.push(
          `F ${r} ${createHash("sha256")
            .update(fs.readFileSync(path.join(d, e.name)))
            .digest("hex")}`,
        );
      }
    }
  };
  walk(dir, "");
  return createHash("sha256").update(items.join("\n")).digest("hex");
}

const outsideSum0 = treeChecksum(outsideDir);

interface ExtraCase {
  id: string;
  code: string;
  expectCode: string; // "OUT_OF_WORKSPACE" 或 "NO_ERROR"
  checkFs: () => boolean | string; // 文件系统断言
}

const CASES: ExtraCase[] = [
  {
    id: "E01",
    code: "try { await files.writeText('evil.txt', 'x'); return 'NO_ERROR' } catch (e) { return e.code }",
    expectCode: "OUT_OF_WORKSPACE",
    checkFs: () =>
      !fs.existsSync(path.join(outsideDir, "pwned.txt")) || "pwned.txt created outside",
  },
  {
    id: "E02",
    code: "try { await files.manage({ ops: [{ op: 'copy', path: 'a.txt', to: 'evil-copy.txt' }] }); return 'NO_ERROR' } catch (e) { return e.code }",
    expectCode: "OUT_OF_WORKSPACE",
    checkFs: () =>
      !fs.existsSync(path.join(outsideDir, "pwned2.txt")) || "pwned2.txt created outside",
  },
  {
    id: "E03",
    code: "try { await files.manage({ ops: [{ op: 'mkdir', path: 'out-link/newdir' }] }); return 'NO_ERROR' } catch (e) { return e.code }",
    expectCode: "OUT_OF_WORKSPACE",
    checkFs: () => !fs.existsSync(path.join(outsideDir, "newdir")) || "newdir created outside",
  },
  {
    id: "E03b",
    code: "try { await files.writeText('dang-mid/f.txt', 'x'); return 'NO_ERROR' } catch (e) { return e.code }",
    expectCode: "OUT_OF_WORKSPACE",
    checkFs: () =>
      !fs.existsSync(path.join(outsideDir, "missing-dir")) || "missing-dir created outside",
  },
  {
    id: "E04",
    code: "try { await files.writeText('good.txt', 'written-through-link'); return 'NO_ERROR' } catch (e) { return e.code }",
    expectCode: "NO_ERROR",
    checkFs: () =>
      fs.readFileSync(path.join(ws, "inside-target.txt"), "utf8") === "written-through-link" ||
      "in-workspace link target not written",
  },
];

const sandbox = new Sandbox({ poolSize: 2 });
await sandbox.warmup();
const sdkHost = createSdkHost(ws);

const reports: Array<{
  id: string;
  expectCode: string;
  actual: string;
  fsCheck: boolean | string;
  outsideDirUnchanged: boolean;
  pass: boolean;
}> = [];

for (const c of CASES) {
  const r: RunOutcome = await sandbox.runScript(c.code, {
    sdkHost,
    timeoutMs: 5000,
  });
  const actual =
    r.outcome.kind === "ok" ? (JSON.parse(r.outcome.valueJson) as string) : `(${r.outcome.kind})`;
  const fsCheck = c.checkFs();
  const outsideSame = treeChecksum(outsideDir) === outsideSum0;
  const pass = actual === c.expectCode && fsCheck === true && outsideSame;
  reports.push({
    id: c.id,
    expectCode: c.expectCode,
    actual,
    fsCheck,
    outsideDirUnchanged: outsideSame,
    pass,
  });
  console.log(
    `[${pass ? "PASS" : "FAIL"}] ${c.id} expected=${c.expectCode} actual=${actual} fs=${fsCheck} outsideUnchanged=${outsideSame}`,
  );
}

const summary = {
  total: reports.length,
  passed: reports.filter((r) => r.pass).length,
  failed: reports.filter((r) => !r.pass).map((r) => r.id),
};
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RESULTS_DIR, "extra-cases.json"),
  JSON.stringify({ summary, cases: reports }, null, 2),
);
console.log(`\n${summary.passed}/${summary.total} extra cases passed`);
console.log(`results → ${path.join(RESULTS_DIR, "extra-cases.json")}`);
await sandbox.dispose();
if (summary.failed.length > 0) process.exitCode = 1;
