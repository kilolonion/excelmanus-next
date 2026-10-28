import type { SyncBus } from "@excelmanus/kernel";
export function installFileEvents(
  bus: SyncBus,
  workspaceFor: (sessionId: string) => string | undefined,
): () => void {
  const writers = new Set([
    "write",
    "edit",
    "files",
    "workbook_edit",
    "workbook_export",
    "run_script",
  ]);
  return bus.subscribe((event) => {
    if (event.kind !== "rec" || event.rec.type !== "tool.result") return;
    const data = event.rec.data;
    if (data.status !== "ok" && data.status !== "partial" && data.status !== "uncertain") return;
    const result = data.result as
      | { changes?: { moves?: unknown }; data?: { changes?: unknown; saved?: unknown } }
      | undefined;
    if (!writers.has(String(data.toolName)) && !result?.data?.changes && !result?.data?.saved)
      return;
    const workspaceId = workspaceFor(event.rec.sessionId);
    if (workspaceId)
      bus.publish({
        kind: "app",
        data: {
          type: "files.changed",
          workspaceId,
          ...(data.status === "ok" && result?.changes?.moves
            ? { moves: result.changes.moves }
            : {}),
        },
      });
  });
}
