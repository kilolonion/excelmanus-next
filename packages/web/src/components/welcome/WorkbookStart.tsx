// 欢迎页上的「打开表格」入口：选择框，或直接打开工作区根目录里最近修改的几份表格。

import { FileSpreadsheet, FolderOpen, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/backend/api";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { useFilesStore } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";
import { openWorkbook, useWorkbookStore } from "@/stores/workbook-store";

export function WorkbookStart() {
  const rootEntries = useFilesStore((s) => s.dirs[""]);
  const opening = useWorkbookStore((s) => (s.loading ? s.activePath : null));
  const [error, setError] = useState<string | null>(null);
  const files = useMemo(
    () =>
      (rootEntries ?? [])
        .filter((f) => f.kind === "file" && isSpreadsheetFile(f.name))
        .sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""))
        .slice(0, 3),
    [rootEntries],
  );

  const open = async (path: string) => {
    setError(null);
    try {
      await openWorkbook(path);
      const loadError = useWorkbookStore.getState().loadError;
      if (loadError) setError(loadError);
    } catch (err) {
      setError(errorMessage(err, "打开失败"));
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        <Button
          onClick={() => useUIStore.getState().openWorkbookPicker("panel")}
          className="gap-2"
          data-coach-id="coach-open-workbook"
        >
          <FolderOpen className="h-4 w-4" />
          打开表格
        </Button>
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">已有表格</span>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="flex max-w-48 items-center gap-1 rounded-md px-2 py-1 text-[var(--em-primary)] hover:bg-muted"
              title={file.path}
              disabled={opening === file.path}
              onClick={() => void open(file.path)}
            >
              {opening === file.path ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{file.name}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
