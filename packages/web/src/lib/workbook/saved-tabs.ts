export interface SavedTabs {
  paths: string[];
  activePath: string | null;
  panelOpen: boolean;
  fullView: boolean;
}
export function parseSavedTabs(raw: string | null): SavedTabs | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || !Array.isArray(value.paths)) return null;
    const paths = [
      ...new Set(
        value.paths.filter(
          (path: unknown): path is string => typeof path === "string" && path.length > 0,
        ),
      ),
    ] as string[];
    return {
      paths,
      activePath: paths.includes(value.activePath) ? value.activePath : (paths[0] ?? null),
      panelOpen: value.panelOpen === true,
      fullView: value.fullView === true,
    };
  } catch {
    return null;
  }
}
