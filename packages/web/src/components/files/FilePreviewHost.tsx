// 文本/图片预览弹窗的唯一挂载点：所有入口经 openWorkspaceFile → preview-store。

import { LazyRegion } from "@/components/ui/LazyRegion";
import { closePreview, usePreviewStore } from "@/stores/preview-store";

const loadText = () =>
  import("@/components/chat/CodePreviewModal").then((m) => ({ default: m.CodePreviewModal }));
const loadImage = () =>
  import("@/components/chat/ImagePreviewModal").then((m) => ({ default: m.ImagePreviewModal }));

export function FilePreviewHost() {
  const text = usePreviewStore((s) => s.text);
  const image = usePreviewStore((s) => s.image);
  if (!text && !image) return null;

  const target = text ?? image!;
  const props = {
    filename: target.filename,
    open: true,
    onOpenChange: (open: boolean) => {
      if (!open) closePreview();
    },
  };
  return text ? (
    <LazyRegion
      key={`text:${text.path}:${text.generation ?? 0}`}
      load={loadText}
      componentProps={{ ...props, filePath: text.path }}
      label={`预览 ${text.filename}`}
      onClose={closePreview}
      dialog
    />
  ) : (
    <LazyRegion
      key={`image:${target.path}`}
      load={loadImage}
      componentProps={{ ...props, imagePath: target.path }}
      label={`预览 ${target.filename}`}
      onClose={closePreview}
      dialog
    />
  );
}
