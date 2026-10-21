import { AlertCircle, ChevronDown, ChevronUp, FileText, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { openWorkspaceFile } from "@/lib/open-file";
import {
  type ComposerAttachment,
  removeComposerAttachment,
  retryComposerAttachment,
} from "@/stores/chat-store";

interface FileAttachmentChipsProps {
  files: ComposerAttachment[];
  visionCapable: boolean | null;
}
export function attachmentVisibleCount(width: number) {
  return Math.max(1, Math.floor((width + 6) / 186)) * 2;
}
function sizeLabel(size: number) {
  if (!size) return "工作区文件";
  return size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${Math.ceil(size / 1024)} KB`
      : `${(size / 1048576).toFixed(1)} MB`;
}

/** One bounded attachment shelf within the composer, sized to its actual column. */
export function FileAttachmentChips({ files, visionCapable }: FileAttachmentChipsProps) {
  const root = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(2);
  const [expanded, setExpanded] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCapacity(attachmentVisibleCount(entry.contentRect.width));
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [files.length > 0]);
  useEffect(() => {
    if (files.length <= capacity) setExpanded(false);
  }, [files.length, capacity]);
  if (!files.length) return null;
  const failed = files.filter((file) => file.status === "error");
  const uploading = files.filter((file) => file.status === "uploading").length;
  const detail = files.find((file) => file.id === detailId);
  const preview = files.find((file) => file.id === previewId);
  const visible = expanded ? files : files.slice(0, capacity);
  return (
    <div ref={root} className="em-attachments" aria-label={`本次附件 ${files.length} 项`}>
      {(failed.length > 0 || uploading > 0 || files.length > capacity) && (
        <div className="em-attachment-summary" aria-live="polite">
          <span>
            {files.length} 个附件{uploading > 0 ? ` · ${uploading} 个上传中` : ""}
            {failed.length > 0 ? ` · ${failed.length} 个未就绪` : ""}
          </span>
          {files.length > capacity && (
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起" : `展开 ${files.length - capacity} 项`}
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>
      )}
      {files.some((file) => file.ref || file.previewUrl) && visionCapable === false && (
        <div className="em-attachment-warning" role="status">
          <AlertCircle size={14} />
          当前模型无法查看图片内容，请切换支持图片的模型。继续发送只会告知模型有图片未发送。
        </div>
      )}
      <div className="em-attachment-grid" data-expanded={expanded}>
        {visible.map((file) => (
          <div key={file.id} className="em-attachment-item" data-status={file.status}>
            <button
              type="button"
              className="em-attachment-main"
              title={file.path ?? file.name}
              aria-label={file.previewUrl ? `预览 ${file.name}` : `附件详情 ${file.name}`}
              onClick={() =>
                file.previewUrl
                  ? setPreviewId(file.id)
                  : setDetailId(detailId === file.id ? null : file.id)
              }
            >
              <span className="em-attachment-icon">
                {file.previewUrl ? <img src={file.previewUrl} alt="" /> : <FileText size={20} />}
              </span>
              <span className="em-attachment-copy">
                <span className="em-attachment-name">{file.name}</span>
                <span className="em-attachment-meta">
                  {file.status === "uploading" ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      上传中
                    </>
                  ) : file.status === "error" ? (
                    <>
                      <AlertCircle size={12} />
                      未就绪
                    </>
                  ) : (
                    sizeLabel(file.size)
                  )}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="em-attachment-remove"
              aria-label={`移除 ${file.name}`}
              title="从本次消息移除"
              onClick={() => removeComposerAttachment(file.id)}
            >
              <X size={14} />
            </button>
            {file.status === "error" && (
              <button
                type="button"
                className="em-attachment-detail"
                onClick={() => setDetailId(detailId === file.id ? null : file.id)}
                aria-label={`查看错误 ${file.name}`}
              >
                详情
              </button>
            )}
          </div>
        ))}
      </div>
      {detail && (
        <div className="em-attachment-details">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 break-all">{detail.path ?? detail.name}</span>
            <button type="button" aria-label="关闭附件详情" onClick={() => setDetailId(null)}>
              <X size={14} />
            </button>
          </div>
          {detail.status === "error" && <p>{detail.error ?? "上传失败"}</p>}
          {detail.status === "error" &&
            (detail.canRetry ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void retryComposerAttachment(detail.id)}
              >
                重试上传
              </Button>
            ) : (
              <span>请重新选择文件</span>
            ))}
          {detail.status === "ready" && detail.path && isSpreadsheetFile(detail.name) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => detail.path && openWorkspaceFile(detail.path)}
            >
              打开表格
            </Button>
          )}
        </div>
      )}
      {failed.some((file) => file.canRetry) && (
        <button
          type="button"
          className="em-attachment-retry"
          onClick={() => {
            for (const file of failed) if (file.canRetry) void retryComposerAttachment(file.id);
          }}
        >
          重试失败的附件
        </button>
      )}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogTitle className="break-all pr-6">{preview?.name ?? "图片预览"}</DialogTitle>
          <DialogDescription>
            {preview ? sizeLabel(preview.size) : ""} · 本次消息附件
          </DialogDescription>
          {preview?.previewUrl && (
            <img
              src={preview.previewUrl}
              alt={preview.name}
              className="max-h-[65dvh] w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
