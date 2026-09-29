// 依赖方向门禁的反例测试：在临时目录构造违规小工作区，
// 用真实的 .dependency-cruiser.mjs 配置与 checkPackageJsons 验证拒绝行为。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

import { checkPackageJsons } from "../../scripts/check-deps.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const depcruiseConfig = join(repoRoot, ".dependency-cruiser.mjs");
// dependency-cruiser 的 bin 是 bin/dependency-cruiser.mjs（main 为 src/main/index.mjs）
const depcruiseBin = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.resolve("dependency-cruiser"))))),
  "bin",
  "dependency-cruiser.mjs",
);

const tempRoots: string[] = [];

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "depdir-fixture-"));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePackage(
  root: string,
  dir: string,
  name: string,
  opts: { src?: string; deps?: Record<string, string> } = {},
): void {
  const pkgDir = join(root, dir);
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    `${JSON.stringify(
      {
        name: `@excelmanus/${name}`,
        version: "0.0.0",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts" },
        ...(opts.deps ? { dependencies: opts.deps } : {}),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(pkgDir, "src", "index.ts"),
    opts.src ?? `export const packageName = "@excelmanus/${name}";\n`,
  );
}

// 在 fixture 里模拟 pnpm 的 workspace 符号链接
function linkWorkspace(root: string, name: string, targetDir: string): void {
  const scopeDir = join(root, "node_modules", "@excelmanus");
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(join(root, targetDir), join(scopeDir, name), "junction");
}

interface CruiseResult {
  code: number;
  output: string;
}

function cruise(root: string): CruiseResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [depcruiseBin, "packages", "--config", depcruiseConfig],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    };
  }
}

describe("dependency-cruiser 文件级依赖方向", () => {
  test("合法方向（kernel → protocol，相对与裸说明符两种写法）放行", () => {
    const root = makeFixture();
    makePackage(root, "packages/protocol", "protocol");
    makePackage(root, "packages/kernel", "kernel", {
      src: 'export { packageName } from "../../protocol/src/index.ts";\n',
      deps: { "@excelmanus/protocol": "workspace:*" },
    });
    writeFileSync(
      join(root, "packages/kernel/src/bare.ts"),
      'export { packageName } from "@excelmanus/protocol";\n',
    );
    linkWorkspace(root, "protocol", "packages/protocol");
    // spike 可以自由依赖产品包
    mkdirSync(join(root, "spikes/demo/src"), { recursive: true });
    writeFileSync(
      join(root, "spikes/demo/src/index.ts"),
      'export { packageName } from "../../packages/kernel/src/index.ts";\n',
    );

    const result = cruise(root);
    expect(result.output).toBe(result.output); // 供失败时查看输出
    expect(result.code).toBe(0);
    expect(checkPackageJsons(root)).toEqual([]);
  });

  test("拒绝 module → module（workbook 相对导入 files）", () => {
    const root = makeFixture();
    makePackage(root, "packages/modules/files", "files");
    makePackage(root, "packages/modules/workbook", "workbook", {
      src: 'export { packageName } from "../../files/src/index.ts";\n',
      deps: { "@excelmanus/files": "workspace:*" },
    });

    const result = cruise(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("dep-direction-workbook");
    const violations = checkPackageJsons(root);
    expect(violations.map((v) => v.message).join("\n")).toContain("@excelmanus/files");
  });

  test("拒绝 module → module（未知模块名 alpha → beta 同样命中）", () => {
    const root = makeFixture();
    makePackage(root, "packages/modules/beta", "beta");
    makePackage(root, "packages/modules/alpha", "alpha", {
      src: 'export { packageName } from "../../beta/src/index.ts";\n',
    });

    const result = cruise(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("dep-direction-alpha");
  });

  test("拒绝 web → kernel（相对导入与 node_modules 裸说明符都命中）", () => {
    const root = makeFixture();
    makePackage(root, "packages/kernel", "kernel");
    makePackage(root, "packages/web", "web", {
      src: 'export { packageName } from "../../kernel/src/index.ts";\n',
    });
    writeFileSync(
      join(root, "packages/web/src/bare.ts"),
      'export { packageName } from "@excelmanus/kernel";\n',
    );
    linkWorkspace(root, "kernel", "packages/kernel");

    const result = cruise(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("dep-direction-web");
    // 两条违规路径都应被记录（相对与裸说明符）
    expect(result.output).toContain("packages/web/src/index.ts");
    expect(result.output).toContain("packages/web/src/bare.ts");
  });

  test("拒绝文件级循环依赖（core/a ↔ core/b）", () => {
    const root = makeFixture();
    makePackage(root, "packages/core", "core");
    writeFileSync(
      join(root, "packages/core/src/a.ts"),
      'import { b } from "./b.ts";\nexport const a = b;\n',
    );
    writeFileSync(
      join(root, "packages/core/src/b.ts"),
      'import { a } from "./a.ts";\nexport const b = a;\n',
    );

    const result = cruise(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("no-circular");
  });

  test("拒绝产品包 → spikes（web 导入 spikes/demo）", () => {
    const root = makeFixture();
    makePackage(root, "packages/web", "web", {
      src: 'export { answer } from "../../../spikes/demo/src/index.ts";\n',
    });
    mkdirSync(join(root, "spikes/demo/src"), { recursive: true });
    writeFileSync(join(root, "spikes/demo/src/index.ts"), "export const answer = 42;\n");

    const result = cruise(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("dep-direction-web");
    expect(result.output).toContain("spikes/demo/src/index.ts");
  });
});

describe("package.json 工作区依赖声明", () => {
  test("拒绝 web 声明依赖 kernel、module 互依、未知包", () => {
    const root = makeFixture();
    makePackage(root, "packages/kernel", "kernel");
    makePackage(root, "packages/web", "web", {
      deps: { "@excelmanus/kernel": "workspace:*" },
    });
    makePackage(root, "packages/modules/alpha", "alpha", {
      deps: { "@excelmanus/beta": "workspace:*" },
    });
    makePackage(root, "packages/modules/beta", "beta");
    makePackage(root, "packages/core", "core", {
      deps: { "@excelmanus/ghost": "workspace:*" },
    });

    const messages = checkPackageJsons(root)
      .map((v) => `${v.packageDir}: ${v.message}`)
      .join("\n");
    expect(messages).toContain("packages/web");
    expect(messages).toContain("@excelmanus/kernel");
    expect(messages).toContain("packages/modules/alpha");
    expect(messages).toContain("@excelmanus/beta");
    expect(messages).toContain("@excelmanus/ghost");
  });

  test("合规声明放行（module → kernel/models/sandbox 等、desktop → server）", () => {
    const root = makeFixture();
    makePackage(root, "packages/kernel", "kernel");
    makePackage(root, "packages/core", "core");
    makePackage(root, "packages/models", "models");
    makePackage(root, "packages/sandbox", "sandbox");
    makePackage(root, "packages/protocol", "protocol");
    makePackage(root, "packages/server", "server");
    makePackage(root, "packages/modules/workbook", "workbook", {
      deps: {
        "@excelmanus/kernel": "workspace:*",
        "@excelmanus/protocol": "workspace:*",
        "@excelmanus/core": "workspace:*",
        "@excelmanus/models": "workspace:*",
        "@excelmanus/sandbox": "workspace:*",
      },
    });
    makePackage(root, "packages/desktop", "desktop", {
      deps: {
        "@excelmanus/protocol": "workspace:*",
        "@excelmanus/core": "workspace:*",
        "@excelmanus/server": "workspace:*",
      },
    });

    expect(checkPackageJsons(root)).toEqual([]);
  });
});
