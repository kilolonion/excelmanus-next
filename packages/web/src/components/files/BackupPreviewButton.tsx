import type { BackupEntry, BackupPreviewResponse } from "@excelmanus/protocol";
import { Download, Eye, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage, saveBlob } from "@/lib/backend/api";
import { renderLayoutToPng } from "@/lib/backend/render";

export function BackupPreviewButton({
  workspaceId,
  entry,
}: {
  workspaceId: string;
  entry: BackupEntry;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        title="只读预览"
        aria-label="只读预览"
        disabled={!workspaceId}
        onClick={() => setOpen(true)}
      >
        <Eye />
      </Button>
      {open && (
        <BackupPreview
          key={`${workspaceId}:${entry.id}`}
          workspaceId={workspaceId}
          entry={entry}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function BackupPreview({
  workspaceId,
  entry,
  onClose,
}: {
  workspaceId: string;
  entry: BackupEntry;
  onClose(): void;
}) {
  const kind = entry.kind === "trash" ? "trash" : "backups";
  const [page, setPage] = useState<{ sheetId?: string; row: number; column: number }>({
    row: 0,
    column: 0,
  });
  const [data, setData] = useState<BackupPreviewResponse | null>(null);
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [requestLoading, setLoading] = useState(true);
  const [loadedPage, setLoadedPage] = useState<typeof page | null>(null);
  const loading = requestLoading || loadedPage !== page;
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    let active = true,
      blobUrl = "";
    setLoading(true);
    setError("");
    setImage("");
    void (async () => {
      const result = await api().previewBackup(workspaceId, kind, entry.id, page);
      if (!active) return;
      let src = "";
      if (result.kind === "spreadsheet") {
        await document.fonts.ready;
        if (!active) return;
        src = `data:image/png;base64,${await renderLayoutToPng(result.layout, 1, () => active)}`;
      } else if (result.kind === "image") {
        const blob = await api().downloadBackup(workspaceId, kind, entry.id);
        if (!active) return;
        blobUrl = URL.createObjectURL(new Blob([blob], { type: result.mime }));
        src = blobUrl;
      }
      if (active) {
        setData(result);
        setImage(src);
      }
    })()
      .catch((e: unknown) => {
        if (active) {
          setError(errorMessage(e));
          setData(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoadedPage(page);
          setLoading(false);
        }
      });
    return () => {
      active = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [workspaceId, kind, entry.id, page]);
  const sheet =
    data?.kind === "spreadsheet" ? data.sheets.find((s) => s.id === data.sheetId) : undefined;
  const download = async () => {
    setDownloading(true);
    try {
      saveBlob(
        await api().downloadBackup(workspaceId, kind, entry.id),
        entry.originalPath.split("/").pop() || "backup",
      );
    } catch (e) {
      toast({ title: "下载失败", description: errorMessage(e), tone: "error" });
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>备份只读预览</DialogTitle>
          <DialogDescription className="break-all">
            {entry.originalPath} · {new Date(entry.createdAt).toLocaleString()}
            。不会恢复或修改当前文件。
          </DialogDescription>
        </DialogHeader>
        {data?.kind === "spreadsheet" && (
          <div role="group" className="flex gap-1 overflow-x-auto" aria-label="备份工作表">
            {data.sheets.map((s) => (
              <Button
                key={s.id}
                size="sm"
                disabled={loading}
                variant={s.id === data.sheetId ? "default" : "outline"}
                onClick={() => setPage({ sheetId: s.id, row: 0, column: 0 })}
              >
                {s.name}
              </Button>
            ))}
          </div>
        )}
        {loading ? (
          <div className="flex h-48 items-center justify-center gap-2" role="status">
            <Loader2 className="animate-spin" />
            正在读取备份…
          </div>
        ) : error ? (
          <div role="alert">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" onClick={() => setPage((p) => ({ ...p }))}>
              重试
            </Button>
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-auto rounded border bg-background">
            {image && (
              <img
                src={image}
                alt={data?.kind === "spreadsheet" ? `备份区域 ${data.range}` : entry.originalPath}
                className={data?.kind === "spreadsheet" ? "max-w-none" : "mx-auto max-w-full"}
              />
            )}
            {data?.kind === "text" && (
              <pre className="whitespace-pre-wrap break-words p-4 text-sm">{data.text}</pre>
            )}
            {data?.kind === "unsupported" && (
              <p className="p-4 text-muted-foreground">{data.reason}</p>
            )}
          </div>
        )}
        {data?.kind === "text" && data.truncated && (
          <p className="text-xs text-muted-foreground">
            仅预览前 100,000 个字符，完整内容请下载查看。
          </p>
        )}
        {data?.kind === "spreadsheet" && sheet && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                {data.range} · 共 {sheet.rows} 行、{sheet.columns} 列
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={loading || data.row === 0}
                onClick={() =>
                  setPage({
                    sheetId: data.sheetId,
                    row: Math.max(0, data.row - 80),
                    column: data.column,
                  })
                }
              >
                上 80 行
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={loading || data.row + 80 >= sheet.rows}
                onClick={() =>
                  setPage({ sheetId: data.sheetId, row: data.row + 80, column: data.column })
                }
              >
                下 80 行
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={loading || data.column === 0}
                onClick={() =>
                  setPage({
                    sheetId: data.sheetId,
                    row: data.row,
                    column: Math.max(0, data.column - 30),
                  })
                }
              >
                前 30 列
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={loading || data.column + 30 >= sheet.columns}
                onClick={() =>
                  setPage({ sheetId: data.sheetId, row: data.row, column: data.column + 30 })
                }
              >
                后 30 列
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{data.limitations.join("；")}</p>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button disabled={downloading} onClick={() => void download()}>
            <Download />
            下载完整备份
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
