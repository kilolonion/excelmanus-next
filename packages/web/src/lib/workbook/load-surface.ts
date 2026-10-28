/** Shared lazy entry: an explicit document lookup can overlap UI loading with its snapshot. */
export const loadWorkbookSurface = () =>
  import("@/components/excel/WorkbookSurface").then((m) => ({ default: m.WorkbookSurface }));
