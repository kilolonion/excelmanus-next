import { AlertCircle, ChevronDown, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { openWorkspaceFile } from "@/lib/open-file";
import { type ComposerAttachment, removeComposerAttachment } from "@/stores/chat-store";

interface FileAttachmentChipsProps {
  files: ComposerAttachment[];
  /** 当前模型是否支持图片输入（未知为 null）。 */
  visionCapable: boolean | null;
}

const MOBILE_VISIBLE_COUNT = 2;

/** 输入框里待发送的附件：图片缩略图与工作区文件引用。失败的附件需移除后重新添加。 */
export function FileAttachmentChips({ files, visionCapable }: FileAttachmentChipsProps) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);

  if (files.length === 0) return null;

  const shouldCollapse = isMobile && files.length > MOBILE_VISIBLE_COUNT && !expanded;
  const visibleFiles = shouldCollapse ? files.slice(0, MOBILE_VISIBLE_COUNT) : files;
  const hiddenCount = files.length - visibleFiles.length;
  const failed = files.filter((af) => af.status === "error");

  return (
    <div className="flex flex-col gap-1 px-3 pt-1.5 pb-0">
      {files.some((af) => af.previewUrl) && visionCapable === false && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-md px-2 py-1">
          <AlertCircle className="h-3 w-3 flex-shrink-0" />
          <span>当前模型不支持图片识别，图片将以文字说明代替</span>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {visibleFiles.map((af) =>
          af.previewUrl ? (
            <span
              key={af.id}
              className={`relative inline-flex items-end rounded-lg overflow-hidden bg-muted/40 border ${
                af.status === "error" ? "border-2 border-destructive/60" : "border-border/40"
              }`}
              style={{ maxWidth: "80px" }}
            >
              <img
                src={af.previewUrl}
                alt={af.name}
                className={`h-12 w-full object-cover ${af.status === "error" ? "opacity-50" : ""}`}
              />
              {af.status === "uploading" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <Loader2 className="h-4 w-4 text-white animate-spin" />
                </div>
              )}
              {af.status === "error" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <AlertCircle className="h-3.5 w-3.5 text-white" />
                </div>
              )}
              <button
                type="button"
                aria-label={`移除 ${af.name}`}
                className="touch-compact absolute top-0.5 right-0.5 h-5 w-5 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors shadow-sm"
                onClick={() => removeComposerAttachment(af.id)}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ) : (
            <span
              key={af.id}
              className={`inline-flex items-center gap-1 rounded-full text-xs font-medium pl-2.5 pr-1 py-0.5 max-w-[200px] ${
                af.status === "error"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)]"
              }`}
            >
              {af.status === "uploading" && (
                <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
              )}
              {af.status === "error" && <AlertCircle className="h-3 w-3 flex-shrink-0" />}
              <span className="truncate">{af.name}</span>
              {af.status === "ready" && af.path && isSpreadsheetFile(af.name) && (
                <button
                  type="button"
                  className="shrink-0 rounded px-1 py-0.5 hover:bg-[var(--em-primary-alpha-20)]"
                  aria-label={`打开 ${af.name}`}
                  onClick={() => af.path && openWorkspaceFile(af.path)}
                >
                  打开
                </button>
              )}
              <button
                type="button"
                aria-label={`移除 ${af.name}`}
                className={`rounded-full p-0.5 transition-colors flex-shrink-0 ${
                  af.status === "error"
                    ? "hover:bg-destructive/20"
                    : "hover:bg-[var(--em-primary-alpha-20)]"
                }`}
                onClick={() => removeComposerAttachment(af.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ),
        )}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center gap-0.5 rounded-full text-[11px] font-medium px-2.5 py-1 bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
          >
            +{hiddenCount} 个文件
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </div>
      {failed.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-destructive">
          {failed.map((af) => (
            <span key={af.id}>
              {af.name}: {af.error ?? "上传失败"}（请移除后重新添加）
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
