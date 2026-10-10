import type { ReactNode } from "react";
import { useApp } from "../../store.ts";
export type WorkspaceView = "workbench" | "files" | "team";
const setView = (workspaceView: WorkspaceView) => useApp.setState({ workspaceView });
export function useWorkspaceNavigation() {
  const view = useApp((s) => s.workspaceView);
  return { view, setView };
}
