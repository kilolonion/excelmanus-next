// 依赖方向唯一规则源：dependency-cruiser 与 package.json 校验都从这里取规则。
// 值表示"该包允许依赖的工作区包"（短名，即 @excelmanus/ 去掉前缀）。

import { readdirSync } from "node:fs";
import { join } from "node:path";

export const PRODUCT_PACKAGES: Record<string, readonly string[]> = {
  protocol: [],
  core: [],
  kernel: ["protocol", "core"],
  models: ["protocol", "core"],
  sandbox: ["protocol", "core"],
  web: ["protocol", "core"],
  // server 是装配层，可依赖除 desktop 外所有产品包（desktop 依赖 server，反向即成环）
  server: [
    "protocol",
    "core",
    "kernel",
    "models",
    "sandbox",
    "workbook",
    "files",
    "agents",
    "memory",
    "rules",
    "skills",
    "mcp",
    "web",
  ],
  desktop: ["protocol", "core", "server"],
};

export const MODULE_NAMES = [
  "workbook",
  "files",
  "agents",
  "memory",
  "rules",
  "skills",
  "mcp",
] as const;

// 模块只能依赖内核公开接口与基础包，模块之间互不依赖
export const MODULE_ALLOWED: readonly string[] = [
  "kernel",
  "protocol",
  "core",
  "models",
  "sandbox",
];

export const ALL_PACKAGE_NAMES: readonly string[] = [
  ...Object.keys(PRODUCT_PACKAGES),
  ...MODULE_NAMES,
];

export type WorkspaceLocation =
  | { kind: "product"; name: string; dir: string }
  | { kind: "module"; name: string; dir: string }
  | { kind: "spike"; name: string; dir: string };

// 由目录路径判定包的身份；非工作区包返回 null
export function locatePackage(dir: string): WorkspaceLocation | null {
  const normalized = dir.replaceAll("\\", "/").replace(/\/+$/, "");
  const moduleMatch = /(^|\/)packages\/modules\/([^/]+)$/.exec(normalized);
  if (moduleMatch?.[2]) {
    return { kind: "module", name: moduleMatch[2], dir: normalized };
  }
  const spikeMatch = /(^|\/)spikes\/([^/]+)$/.exec(normalized);
  if (spikeMatch?.[2]) {
    return { kind: "spike", name: spikeMatch[2], dir: normalized };
  }
  const productMatch = /(^|\/)packages\/([^/]+)$/.exec(normalized);
  if (productMatch?.[2] && productMatch[2] !== "modules") {
    return { kind: "product", name: productMatch[2], dir: normalized };
  }
  return null;
}

// 返回该位置允许依赖的工作区包短名；spike 不受限制返回 null
export function allowedDeps(loc: WorkspaceLocation): readonly string[] | null {
  if (loc.kind === "spike") {
    return null;
  }
  if (loc.kind === "module") {
    return MODULE_ALLOWED;
  }
  const allowed = PRODUCT_PACKAGES[loc.name];
  if (!allowed) {
    throw new Error(`未知产品包: ${loc.name}`);
  }
  return allowed;
}

// 包目录相对仓库根的路径（depcruise 报的路径形态）
export function dirOf(name: string): string {
  return MODULE_NAMES.includes(name as (typeof MODULE_NAMES)[number])
    ? `packages/modules/${name}`
    : `packages/${name}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface DepcruiseRule {
  name: string;
  severity: "error";
  comment: string;
  from: { path?: string };
  to: { path?: string; pathNot?: string; circular?: boolean };
}

function listSubdirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// 由允许矩阵生成 dependency-cruiser 的 forbidden 规则。
// 规则按 baseDir 下实际存在的包目录生成：新增包/模块自动纳入检查；
// 未登记的产品包按空允许集处理（只允许自目录，失败闭合）。
export function depcruiseForbiddenRules(baseDir = process.cwd()): DepcruiseRule[] {
  const rules: DepcruiseRule[] = [
    {
      name: "no-circular",
      severity: "error",
      comment: "禁止循环依赖（包级与文件级）",
      from: {},
      to: { circular: true },
    },
  ];
  const productDirs = listSubdirs(join(baseDir, "packages")).filter((n) => n !== "modules");
  const moduleDirs = listSubdirs(join(baseDir, "packages", "modules"));
  const entries: Array<{ name: string; dir: string; allowed: readonly string[] }> = [
    ...productDirs.map((name) => ({
      name,
      dir: `packages/${name}`,
      allowed: PRODUCT_PACKAGES[name] ?? [],
    })),
    ...moduleDirs.map((name) => ({
      name,
      dir: `packages/modules/${name}`,
      allowed: MODULE_ALLOWED,
    })),
  ];
  for (const { name, dir, allowed } of entries) {
    const allowedDirs = [dir, ...allowed.map(dirOf)].map(escapeRe).join("|");
    rules.push({
      name: `dep-direction-${name}`,
      severity: "error",
      comment: `${dir} 只允许依赖 ${allowed.length ? allowed.join(", ") : "自身"}；spikes/ 一律禁止`,
      from: { path: `^${escapeRe(dir)}/` },
      to: {
        path: "^(packages|spikes)/",
        pathNot: `^(${allowedDirs})/`,
      },
    });
  }
  return rules;
}
