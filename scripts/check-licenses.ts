// 许可证门禁：基于 `pnpm licenses list --json`（含传递依赖与 devDependencies）。
// 白名单外一律失败；硬性黑名单 @univerjs-pro/* 与 hyperformula 出现即失败。
// 例外清单只豁免"许可证缺失/不规范"的已知传递依赖，精确到版本，黑名单判定不受其影响。
// 另有一份构建期例外清单（负责人批准，ADR 0011），只放行指定版本的构建工具，且禁止进入生产依赖。

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "Zlib",
]);

const FORBIDDEN_PACKAGES = [/^@univerjs-pro\//i, /^hyperformula$/i];

// 非 SPDX 写法别名归一：只收已确认的同义写法，不做通用的 "/" 拆分
const LICENSE_ALIASES = new Map([["MIT/X11", "MIT"]]);

// 负责人审阅接受的例外：包名@版本 → 原因。只豁免"许可证缺失/不规范"，黑名单仍优先。
const ACCEPTED_EXCEPTIONS = new Map([
  [
    "buffers@0.1.1",
    "无许可证声明（substack 旧包，exceljs→unzipper 传递依赖，仅 spike 使用）；负责人 2026-09-29 接受",
  ],
]);

// 负责人批准的构建期许可例外（ADR 0011）：只放行"规范但不在白名单"的构建期依赖，
// 精确到 包名@版本 且许可字符串必须一致；同时要求这些包不出现在生产依赖报告中。
const BUILD_TIME_REASON =
  "MPL-2.0，Tailwind CSS 4 构建期依赖（@tailwindcss/node），不进入产物；负责人 2026-10-01 批准";
const BUILD_TIME_LICENSE_EXCEPTIONS: ReadonlyMap<string, { license: string; reason: string }> =
  new Map(
    [
      "lightningcss",
      "lightningcss-android-arm64",
      "lightningcss-darwin-arm64",
      "lightningcss-darwin-x64",
      "lightningcss-freebsd-x64",
      "lightningcss-linux-arm-gnueabihf",
      "lightningcss-linux-arm64-gnu",
      "lightningcss-linux-arm64-musl",
      "lightningcss-linux-x64-gnu",
      "lightningcss-linux-x64-musl",
      "lightningcss-win32-arm64-msvc",
      "lightningcss-win32-x64-msvc",
    ].map((name) => [`${name}@1.32.0`, { license: "MPL-2.0", reason: BUILD_TIME_REASON }]),
  );

export type BuildTimeExceptions = ReadonlyMap<string, { license: string; reason: string }>;

interface LicenseEntry {
  name: string;
  license?: string;
  versions?: string[];
}

type LicenseReport =
  | Record<string, LicenseEntry[]>
  | Array<{ packages?: LicenseEntry[]; license?: string }>
  | LicenseEntry[];

// 把 pnpm licenses list --json 的各形态规整为 { name, license } 列表
export function normalizeReport(report: LicenseReport): LicenseEntry[] {
  const entries: LicenseEntry[] = [];
  const push = (name: string, license: string | undefined, versions?: string[]) => {
    entries.push({ name, license, versions });
  };
  if (Array.isArray(report)) {
    for (const item of report) {
      if (Array.isArray((item as { packages?: unknown }).packages)) {
        for (const p of (item as { packages: LicenseEntry[] }).packages) {
          push(p.name, p.license ?? item.license, p.versions);
        }
      } else {
        const e = item as LicenseEntry;
        push(e.name, e.license, e.versions);
      }
    }
    return entries;
  }
  for (const [license, list] of Object.entries(report)) {
    for (const e of list) {
      push(e.name, e.license ?? license, e.versions);
    }
  }
  return entries;
}

// 解析 "MIT OR (Apache-2.0 AND X)" 这类 SPDX 表达式为 token 流
function tokenize(expr: string): string[] {
  return expr.replaceAll("(", " ( ").replaceAll(")", " ) ").split(/\s+/).filter(Boolean);
}

function isAllowedLicenseExpr(expr: string): boolean {
  const tokens = tokenize(expr);
  let pos = 0;
  const parseOr = (): boolean => {
    let value = parseAnd();
    while (tokens[pos]?.toUpperCase() === "OR") {
      pos += 1;
      // OR 分支任一满足即可；短路前先继续解析
      const rhs = parseAnd();
      value = value || rhs;
    }
    return value;
  };
  const parseAnd = (): boolean => {
    let value = parseFactor();
    while (tokens[pos]?.toUpperCase() === "AND") {
      pos += 1;
      const rhs = parseFactor();
      value = value && rhs;
    }
    return value;
  };
  const parseFactor = (): boolean => {
    const token = tokens[pos];
    if (token === "(") {
      pos += 1;
      const value = parseOr();
      if (tokens[pos] !== ")") {
        return false;
      }
      pos += 1;
      return value;
    }
    pos += 1;
    const raw = (token ?? "").replace(/\+$/, "");
    const id = LICENSE_ALIASES.get(raw) ?? raw;
    return ALLOWED_LICENSES.has(id);
  };
  if (tokens.length === 0) {
    return false;
  }
  const result = parseOr();
  return result && pos === tokens.length;
}

export function evaluateLicenses(
  report: LicenseReport,
  exceptions: ReadonlyMap<string, string> = ACCEPTED_EXCEPTIONS,
  buildTime: BuildTimeExceptions = BUILD_TIME_LICENSE_EXCEPTIONS,
  prodReport?: LicenseReport,
  usedBuildTime: Set<string> = new Set(),
): string[] {
  const violations: string[] = [];
  for (const { name, license, versions } of normalizeReport(report)) {
    if (FORBIDDEN_PACKAGES.some((re) => re.test(name))) {
      violations.push(`${name}: 硬性黑名单包（声明许可证 ${license ?? "未知"}）`);
      continue;
    }
    if (!license || !isAllowedLicenseExpr(license)) {
      // 精确到版本的例外：条目的每个版本都命中才豁免；无版本信息不豁免
      const vers = versions?.length ? versions : [];
      if (vers.length > 0 && vers.every((v) => exceptions.has(`${name}@${v}`))) {
        continue;
      }
      if (
        license &&
        vers.length > 0 &&
        vers.every((v) => buildTime.get(`${name}@${v}`)?.license === license)
      ) {
        for (const v of vers) usedBuildTime.add(`${name}@${v}`);
        continue;
      }
      violations.push(`${name}: 许可证 ${license ?? "缺失"} 不在白名单`);
    }
  }
  if (prodReport) {
    const buildTimeNames = new Set(
      [...buildTime.keys()].map((k) => k.slice(0, k.lastIndexOf("@"))),
    );
    for (const { name, versions } of normalizeReport(prodReport)) {
      const hits = versions?.length
        ? versions.filter((v) => buildTime.has(`${name}@${v}`)).map((v) => `${name}@${v}`)
        : buildTimeNames.has(name)
          ? [name]
          : [];
      for (const hit of hits) {
        violations.push(`${hit}: 构建期许可例外包出现在生产依赖中`);
      }
    }
  }
  return violations;
}

// pnpm 10.11 misreads URL tarball versions (xlsx@undefined). Use the pinned
// invoking CLI, rather than accidentally picking an older global pnpm on PATH.
export function licenseCommand(execPath: string | undefined, prod: boolean) {
  const args = ["licenses", "list", "--json", ...(prod ? ["--prod"] : [])];
  return execPath && /(?:^|[\\/])pnpm\.(?:c?js|mjs)$/.test(execPath)
    ? { command: process.execPath, args: [execPath, ...args] }
    : { command: "pnpm", args };
}
function listLicenses(rootDir: string, prod: boolean): LicenseReport {
  const invocation = licenseCommand(process.env.npm_execpath, prod);
  const output = execFileSync(invocation.command, invocation.args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output) as LicenseReport;
}

function main(): void {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const report = listLicenses(rootDir, false);
  const prodReport = listLicenses(rootDir, true);
  const used = new Set<string>();
  const violations = evaluateLicenses(
    report,
    ACCEPTED_EXCEPTIONS,
    BUILD_TIME_LICENSE_EXCEPTIONS,
    prodReport,
    used,
  );
  if (violations.length > 0) {
    console.error("许可证检查失败:");
    for (const v of violations) {
      console.error(`  ${v}`);
    }
    process.exit(1);
  }
  const usedText = used.size > 0 ? `；构建期例外：${[...used].sort().join("、")}` : "";
  console.log(`许可证检查通过（${normalizeReport(report).length} 个依赖${usedText}）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
