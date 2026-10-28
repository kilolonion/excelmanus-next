import { expect, test } from "vitest";
import config from "../vite.config.ts";

test("in-place web builds retain hashed assets needed by already-open clients", () => {
  expect(config).toHaveProperty("build.emptyOutDir", false);
});

test("manual workbook chunks do not absorb shared first-screen dependencies", () => {
  expect(config).toHaveProperty("build.rollupOptions.output.onlyExplicitManualChunks", true);
});

test("lazy workbook dependencies initialize without a cross-chunk cycle", async () => {
  const { build } = await import("vite");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "workbook-chunks-"));
  const modules: Record<string, string> = {
    entry: 'export const open = () => import("/components/excel/WorkbookSurface.tsx");',
    "/components/excel/WorkbookSurface.tsx":
      'import { service } from "/node_modules/@univerjs/core/index.js"; import { identifier } from "/node_modules/@wendellhu/redi/index.js"; export const ready = [service, identifier("surface")];',
    "/node_modules/@univerjs/core/index.js":
      'import { identifier } from "/node_modules/@wendellhu/redi/index.js"; export const service = identifier("service");',
    "/node_modules/@wendellhu/redi/index.js":
      "const identifiers = new Map(); export function identifier(name) { if (!identifiers.has(name)) identifiers.set(name, name); return identifiers.get(name); }",
  };
  const output = config.build?.rollupOptions?.output;
  if (!output || Array.isArray(output)) throw new Error("expected one output");
  try {
    const built = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "fixture",
          resolveId: (id) => (id in modules ? id : null),
          load: (id) => modules[id],
        },
      ],
      build: {
        outDir: dir,
        minify: false,
        modulePreload: false,
        rollupOptions: {
          preserveEntrySignatures: "strict",
          input: "entry",
          output: {
            ...output,
            format: "es",
            entryFileNames: "entry.mjs",
            chunkFileNames: "[name]-[hash].mjs",
          },
        },
      },
    });
    if (Array.isArray(built) || !("output" in built)) throw new Error("expected build output");
    const entry = built.output.find((item) => item.type === "chunk" && item.isEntry);
    expect(entry?.type === "chunk" && entry.imports).toEqual([]);
    const app = await import(/* @vite-ignore */ pathToFileURL(join(dir, "entry.mjs")).href);
    await expect(app.open()).resolves.toHaveProperty("ready", ["service", "surface"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Univer and its injection dependencies remain together in the workbook-only graph", () => {
  const output = config.build?.rollupOptions?.output;
  if (!output || Array.isArray(output) || typeof output.manualChunks !== "function")
    throw new Error("expected chunk selector");
  const surface = "/components/excel/WorkbookSurface.tsx";
  const dependencies = [
    "/node_modules/@univerjs/core/index.js",
    "/node_modules/@wendellhu/redi/index.js",
    "/node_modules/rxjs/index.js",
  ];
  const graph = {
    getModuleIds: () => ["entry", surface, ...dependencies].values(),
    getModuleInfo: (id: string) => ({
      id,
      isEntry: id === "entry",
      isIncluded: true,
      importedIds: id === surface ? dependencies : [],
      dynamicallyImportedIds: id === "entry" ? [surface] : [],
    }),
  } as unknown as Parameters<typeof output.manualChunks>[1];
  for (const id of dependencies) expect(output.manualChunks(id, graph)).toBe("workbook-engine");
});
