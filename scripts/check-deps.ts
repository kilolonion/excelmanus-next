// 校验每个工作区包 package.json 中声明的工作区依赖是否符合依赖矩阵。
// 文件级依赖方向由 .dependency-cruiser.mjs（同一矩阵）负责。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ALL_PACKAGE_NAMES, allowedDeps, locatePackage } from "./dependency-matrix.ts";

const WORKSPACE_PREFIX = "@excelmanus/";
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface DepViolation {
  packageDir: string;
  message: string;
}

function listSubdirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function listPackageDirs(rootDir: string): string[] {
  const dirs: string[] = [];
  for (const name of listSubdirs(join(rootDir, "packages"))) {
    if (name !== "modules") {
      dirs.push(`packages/${name}`);
    }
  }
  for (const name of listSubdirs(join(rootDir, "packages", "modules"))) {
    dirs.push(`packages/modules/${name}`);
  }
  for (const name of listSubdirs(join(rootDir, "spikes"))) {
    dirs.push(`spikes/${name}`);
  }
  return dirs.sort();
}

export function checkPackageJsons(rootDir: string): DepViolation[] {
  const violations: DepViolation[] = [];
  const knownNames = new Set(ALL_PACKAGE_NAMES.map((n) => `${WORKSPACE_PREFIX}${n}`));
  for (const dir of listPackageDirs(rootDir)) {
    const loc = locatePackage(dir);
    if (!loc) {
      continue;
    }
    const pkgPath = join(rootDir, dir, "package.json");
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      // 无 package.json 的目录不是工作区包（pnpm 同样忽略），跳过；
      // 有文件但解析失败才算违规。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        violations.push({
          packageDir: dir,
          message: "package.json 无法解析",
        });
      }
      continue;
    }
    let allowed: readonly string[] | null;
    try {
      allowed = allowedDeps(loc);
    } catch {
      violations.push({
        packageDir: dir,
        message: `未在依赖矩阵中登记的产品包（${loc.name}）`,
      });
      allowed = [];
    }
    const declared = new Set<string>();
    for (const field of DEP_FIELDS) {
      const section = pkg[field];
      if (!section || typeof section !== "object") {
        continue;
      }
      for (const [depName, spec] of Object.entries(section as Record<string, string>)) {
        const isWorkspaceDep =
          spec.startsWith("workspace:") || depName.startsWith(WORKSPACE_PREFIX);
        if (!isWorkspaceDep) {
          continue;
        }
        declared.add(depName);
        const shortName = depName.slice(WORKSPACE_PREFIX.length);
        if (!knownNames.has(depName)) {
          violations.push({
            packageDir: dir,
            message: `${field} 声明了未知工作区包 ${depName}`,
          });
          continue;
        }
        if (allowed !== null && !allowed.includes(shortName)) {
          violations.push({
            packageDir: dir,
            message: `${field} 声明了不被允许的依赖 ${depName}`,
          });
        }
      }
    }
    if (loc.kind === "spike") {
      for (const depName of declared) {
        if (depName.includes("spike")) {
          violations.push({
            packageDir: dir,
            message: `spike 不得依赖其他 spike: ${depName}`,
          });
        }
      }
    }
  }
  return violations;
}

function main(): void {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const violations = checkPackageJsons(rootDir);
  if (violations.length > 0) {
    console.error("工作区依赖声明违规:");
    for (const v of violations) {
      console.error(`  ${v.packageDir}: ${v.message}`);
    }
    process.exit(1);
  }
  console.log(`依赖方向检查通过（${listPackageDirs(rootDir).length} 个包）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
