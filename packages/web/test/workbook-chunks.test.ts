import { expect, test } from "vitest";
import config from "../vite.config";

type Info = {
  importedIds: string[];
  dynamicallyImportedIds: string[];
  isEntry: boolean;
  isIncluded: boolean;
};
function graph(nodes: Record<string, Partial<Info>>) {
  const entries = new Map(
    Object.entries(nodes).map(([id, m]) => [
      id,
      { importedIds: [], dynamicallyImportedIds: [], isEntry: false, isIncluded: true, ...m },
    ]),
  );
  return {
    getModuleIds: () => entries.keys(),
    getModuleInfo: (id: string) => entries.get(id) ?? null,
  };
}
const surface = "/app/src/components/excel/WorkbookSurface.tsx";
const core = "/app/node_modules/@univerjs/core/index.js";
const rx = "/app/node_modules/rxjs/index.js";
const shared = "/app/node_modules/shared/index.js";
const react = "/app/node_modules/react/index.js";
const output = config.build?.rollupOptions?.output;
if (!output || Array.isArray(output) || typeof output.manualChunks !== "function")
  throw new Error("expected chunk selector");
const chunk = output.manualChunks as (
  id: string,
  api: ReturnType<typeof graph>,
) => string | undefined;

test("workbook-only dependency closure gets a separate engine without eagerly loaded shared UI", () => {
  const api = graph({
    main: { isEntry: true, importedIds: [shared], dynamicallyImportedIds: [surface] },
    [surface]: { importedIds: [core, shared] },
    [core]: { importedIds: [rx, react] },
    [rx]: {},
    [shared]: {},
    [react]: {},
  });
  expect(chunk(core, api)).toBe("workbook-engine");
  expect(chunk(rx, api)).toBe("workbook-engine");
  expect(chunk(shared, api)).toBeUndefined();
  expect(chunk(surface, api)).toBeUndefined();
  expect(chunk(react, api)).toBe("react");
});
test("dynamic translations and tree-shaken modules do not inflate the engine", () => {
  const locale = "/app/node_modules/@univerjs/core/locales/unused.js";
  const unused = "/app/node_modules/unused/index.js";
  const api = graph({
    main: { isEntry: true, dynamicallyImportedIds: [surface] },
    [surface]: { importedIds: [core, unused] },
    [core]: { dynamicallyImportedIds: [locale] },
    [locale]: {},
    [unused]: { isIncluded: false },
  });
  expect(chunk(core, api)).toBe("workbook-engine");
  expect(chunk(locale, api)).toBeUndefined();
  expect(chunk(unused, api)).toBeUndefined();
});
test("other lazy UI routes keep their dependency closure outside the workbook engine", () => {
  const api = graph({
    main: { isEntry: true, dynamicallyImportedIds: [surface, "settings"] },
    settings: { importedIds: [shared] },
    [surface]: { importedIds: [core, shared] },
    [shared]: { importedIds: [rx] },
    [rx]: {},
    [core]: { importedIds: [rx] },
  });
  expect(chunk(core, api)).toBe("workbook-engine");
  expect(chunk(rx, api)).toBeUndefined();
  expect(chunk(shared, api)).toBeUndefined();
});
test("new builds recompute the dependency scope and cyclic internal imports terminate", () => {
  const api = graph({
    main: { isEntry: true, dynamicallyImportedIds: [surface] },
    [surface]: { importedIds: [core] },
    [core]: { importedIds: [rx] },
    [rx]: { importedIds: [core] },
  });
  expect(chunk(core, api)).toBe("workbook-engine");
  const next = graph({
    main: { isEntry: true, importedIds: [core], dynamicallyImportedIds: [surface] },
    [surface]: { importedIds: [core] },
    [core]: {},
  });
  expect(chunk(core, next)).toBeUndefined();
});
