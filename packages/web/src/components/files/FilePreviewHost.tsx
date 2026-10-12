// 文本/图片预览弹窗的唯一挂载点：所有入口经 openWorkspaceFile → preview-store。

import { lazy, Suspense } from "react";
import { closePreview, usePreviewStore } from "@/stores/preview-store";

const CodePreviewModal = lazy(() =>
  import("@/components/chat/CodePreviewModal").then((m) => ({ default: m.CodePreviewModal })),
);
const ImagePreviewModal = lazy(() =>
  import("@/components/chat/ImagePreviewModal").then((m) => ({ default: m.ImagePreviewModal })),
);

export function FilePreviewHost() {
  const text = usePreviewStore((s) => s.text);
  const image = usePreviewStore((s) => s.image);
  if (!text && !image) return null;

  return (
    <Suspense fallback={null}>
      {text && (
        <CodePreviewModal
          key={text.path}
          filePath={text.path}
          filename={text.filename}
          open
          onOpenChange={(open) => {
            if (!open) closePreview();
          }}
        />
      )}
      {image && (
        <ImagePreviewModal
          key={image.path}
          imagePath={image.path}
          filename={image.filename}
          open
          onOpenChange={(open) => {
            if (!open) closePreview();
          }}
        />
      )}
    </Suspense>
  );
}
