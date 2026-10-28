import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OverlayCard, OverlayCardHeader } from "@/components/ui/overlay-card";
import { errorMessage } from "@/lib/backend/api";
import { listAllFiles, useFilesStore } from "@/stores/files-store";

/** Selecting is the only action that touches the composer; dismiss/search never edits its draft. */
export function WorkspaceAttachmentPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const workspaceId = useFilesStore((s) => s.workspaceId);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    workspaceId: string | null;
    files: string[];
    error?: string;
  } | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    const current = () =>
      id === request.current && useFilesStore.getState().workspaceId === workspaceId;
    setResult(null);
    if (workspaceId)
      void listAllFiles(2000, 6, current)
        .then((files) => {
          if (current()) setResult({ workspaceId, files: files.map((file) => file.path) });
        })
        .catch((cause) => {
          if (current())
            setResult({ workspaceId, files: [], error: errorMessage(cause, "文件读取失败") });
        });
    return () => {
      request.current++;
    };
  }, [workspaceId, attempt]);
  const ready = result?.workspaceId === workspaceId ? result : null;
  const files =
    ready?.files.filter((path) => path.toLowerCase().includes(query.toLowerCase())) ?? [];
  return (
    <OverlayCard
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="em-mobile-actions-sheet"
      aria-describedby={undefined}
    >
      <OverlayCardHeader title="引用工作区文件" onClose={onClose} />
      <div className="flex min-h-0 flex-col gap-3 p-4">
        <Input
          aria-label="搜索工作区文件"
          placeholder="搜索已读取的文件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="min-h-0 overflow-y-auto max-h-[45dvh]">
          {!workspaceId ? (
            <p className="text-sm text-muted-foreground">工作区尚未就绪，请稍后重试。</p>
          ) : !ready ? (
            <p role="status">正在读取文件…</p>
          ) : ready.error ? (
            <div role="alert">
              <p>{ready.error}</p>
              <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                重新读取
              </Button>
            </div>
          ) : files.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有匹配的文件</p>
          ) : (
            files.slice(0, 200).map((path) => (
              <Button
                key={path}
                variant="ghost"
                className="min-h-12 w-full justify-start gap-2 text-left"
                onClick={() => {
                  if (useFilesStore.getState().workspaceId !== workspaceId) return;
                  onPick(path);
                  onClose();
                }}
              >
                <FileText className="size-4 shrink-0" />
                <span className="truncate">{path}</span>
              </Button>
            ))
          )}
        </div>
        {files.length > 200 && (
          <p className="text-xs text-muted-foreground">显示前 200 项，请输入文件名缩小范围。</p>
        )}
        {ready && ready.files.length >= 2000 && (
          <p className="text-xs text-muted-foreground">
            已读取 2000 个文件；未列出的文件可从文件页查找。
          </p>
        )}
      </div>
    </OverlayCard>
  );
}
