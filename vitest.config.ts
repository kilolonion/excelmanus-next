import { readdirSync } from "node:fs";

import { defineConfig } from "vitest/config";

const packageRoots = ["packages", "packages/modules"]
  .flatMap((base) =>
    readdirSync(new URL(base, import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "modules")
      .map((d) => `${base}/${d.name}`),
  )
  .sort();

export default defineConfig({
  test: {
    projects: [
      ...packageRoots.map((root) => ({
        test: {
          name: root.replace(/^packages\//, "").replaceAll("/", "-"),
          root,
          include: ["test/**/*.test.ts"],
          // 占位包暂无测试文件时整个 vitest run 不应失败（ADR 0006：少而真实）
          passWithNoTests: true,
        },
      })),
      {
        test: {
          name: "gates",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
});
