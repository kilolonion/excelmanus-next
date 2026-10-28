// Isolated UI fixture. Settings tab modules are replaced by the fixture build; no API requests.
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useUIStore } from "@/stores/ui-store";
import "@/app/globals.css";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary fallback={() => <h1>QA 根边界接管：整个工作区不可用</h1>}>
    <main className="p-6 space-y-4">
      <h1>QA 工作区保持可用</h1>
      <textarea aria-label="QA 草稿" defaultValue="需要保留的草稿" />
      <button type="button" onClick={() => useUIStore.getState().openSettings("general")}>打开失败设置页</button>
      <SettingsDialog />
    </main>
  </ErrorBoundary>,
);
