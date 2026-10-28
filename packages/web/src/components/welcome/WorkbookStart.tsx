// 欢迎页上的「打开表格」入口：选择框，或直接打开工作区根目录里最近修改的几份表格。

import { FileSpreadsheet, FolderOpen, Loader2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { uploadChatFiles } from "@/components/chat/chat-upload-bridge";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { errorMessage } from "@/lib/backend/api";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { useFilesStore } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";
import { openWorkbook, useWorkbookStore } from "@/stores/workbook-store";
import styles from "./WelcomePage.module.css";

export function WorkbookStart() {
  const isMobile = useIsMobile();
  const uploadInput = useRef<HTMLInputElement>(null);
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
      await openWorkbook(path, { full: isMobile });
      const loadError = useWorkbookStore.getState().loadError;
      if (loadError) setError(loadError);
    } catch (err) {
      setError(errorMessage(err, "打开失败"));
    }
  };

  return (
    <div className={`mt-2 flex flex-col gap-2 ${isMobile ? "em-mobile-workbook-start" : ""}`}>
      <div className="flex gap-2">
        <Button
          onClick={() => useUIStore.getState().openWorkbookPicker(isMobile ? "full" : "panel")}
          className="gap-2"
          data-coach-id="coach-open-workbook"
        >
          <FolderOpen className="h-4 w-4" />
          打开表格
        </Button>
        {isMobile && (
          <Button variant="outline" onClick={() => uploadInput.current?.click()}>
            上传文件或照片
          </Button>
        )}
        <input
          ref={uploadInput}
          type="file"
          multiple
          className="hidden"
          aria-label="上传文件或照片"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length && !uploadChatFiles(files)) setError("输入区尚未就绪，请稍后再试");
            e.target.value = "";
          }}
        />
      </div>
      {files.length > 0 && (
        <div
          className={`${isMobile ? "em-mobile-recent-files" : styles.recent} flex flex-wrap items-center gap-1.5 text-xs`}
        >
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
