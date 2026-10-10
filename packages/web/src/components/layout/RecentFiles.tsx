import { useMemo, useState } from "react";
import { noteManualView, openWorkspaceFile, useApp } from "../../store.ts";
import { S, UI } from "../../strings.ts";
import { Icon } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { Alert } from "../ui/display.tsx";
import { PageSection } from "../ui/page-layout.tsx";
import { useWorkspaceNavigation } from "./WorkspaceNavigation.tsx";

export function RecentFiles() {
  const files = useApp((state) => state.files);
  const { setView } = useWorkspaceNavigation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recent = useMemo(
    () =>
      files
        .filter((file) => file.kind === "file" && /\.(xlsx|xlsm|csv|tsv)$/i.test(file.name))
        .sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""))
        .slice(0, 5),
    [files],
  );
  if (recent.length === 0) return null;
  return (
    <PageSection
      className="recent-files"
      title={UI.recentFiles}
      actions={
        <Button variant="link" size="sm" onClick={() => setView("files")}>
          {UI.viewAll}
          <Icon name="chevronRight" size="sm" />
        </Button>
      }
    >
      {error && (
        <Alert tone="err" role="alert">
          {error}
        </Alert>
      )}
      <div className="recent-files-list">
        {recent.map((file) => (
          <Button
            key={file.path}
            variant="ghost"
            className="recent-file-row"
            disabled={busy !== null}
            loading={busy === file.path}
            onClick={() => {
              noteManualView();
              setBusy(file.path);
              setError(null);
              void openWorkspaceFile(file.path)
                .then(() => setView("workbench"))
                .catch((e: unknown) => setError(e instanceof Error ? e.message : S.unsupportedFile))
                .finally(() => setBusy(null));
            }}
          >
            <Icon name="fileSheet" size="md" className="text-primary" />
            <span>{file.name}</span>
            <time className="ml-auto text-xs text-muted-foreground">
              {file.modifiedAt ? new Date(file.modifiedAt).toLocaleDateString(S.locale) : ""}
            </time>
            <Icon name="chevronRight" size="sm" />
          </Button>
        ))}
      </div>
    </PageSection>
  );
}
