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
