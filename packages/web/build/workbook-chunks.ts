interface ChunkGraph {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): {
    isEntry: boolean;
    isIncluded: boolean | null;
    importedIds: readonly string[];
    dynamicallyImportedIds: readonly string[];
  } | null;
}

function workbookDependencies(graph: ChunkGraph): Set<string> {
  const ids = [...graph.getModuleIds()];
  const surfaces = new Set(
    ids.filter((id) => /\/components\/excel\/WorkbookSurface\.tsx$/.test(id)),
  );
  const walk = (roots: Iterable<string>, dynamic: boolean, skipSurface = false) => {
    const seen = new Set<string>();
    const pending = [...roots];
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined) break;
      if (seen.has(id) || (skipSurface && surfaces.has(id))) continue;
      seen.add(id);
      const info = graph.getModuleInfo(id);
      if (info) pending.push(...info.importedIds, ...(dynamic ? info.dynamicallyImportedIds : []));
    }
    return seen;
  };
  // Shared UI and other lazy screens must not start importing the large spreadsheet engine.
  const outside = walk(
    ids.filter((id) => graph.getModuleInfo(id)?.isEntry),
    true,
    true,
  );
  // Only static, included dependencies belong here: grouping every locale pulls unused languages in.
  return new Set(
    [...walk(surfaces, false)].filter(
      (id) =>
        id.includes("/node_modules/") && !outside.has(id) && graph.getModuleInfo(id)?.isIncluded,
    ),
  );
}

/** Keep stable workbook dependencies cached across ordinary application UI deployments. */
export function createWorkbenchChunks() {
  const builds = new WeakMap<ChunkGraph["getModuleInfo"], Set<string>>();
  return (id: string, graph: ChunkGraph): string | undefined => {
    if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return "react";
    let engine = builds.get(graph.getModuleInfo);
    if (!engine) {
      engine = workbookDependencies(graph);
      builds.set(graph.getModuleInfo, engine);
    }
    return engine.has(id) ? "workbook-engine" : undefined;
  };
}
