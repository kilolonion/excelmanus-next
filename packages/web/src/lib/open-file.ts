// 打开工作区文件的唯一入口：表格进工作台（单击侧边面板 / full 全屏），图片与文本进预览，其余下载。

import { classifyWorkspaceFile, type WorkspaceFileKind } from "@/lib/file-kind";
import { normalizePath } from "@/lib/paths";
import { downloadWorkspaceFile } from "@/stores/files-store";
import { openImagePreview, openTextPreview } from "@/stores/preview-store";
import { openWorkbook, useWorkbookStore } from "@/stores/workbook-store";

export interface OpenFileOptions {
  /** 表格：full = 全屏工作台；缺省时保持当前形态。 */
  intent?: "preview" | "full";
  /** 表格：打开后定位的区域（可带工作表名）。 */
  range?: string;
}

export function openWorkspaceFile(rawPath: string, opts: OpenFileOptions = {}): WorkspaceFileKind {
  const path = normalizePath(rawPath);
  const kind = classifyWorkspaceFile(path);
  if (kind === "spreadsheet") {
    const full = opts.intent === "full" ? true : useWorkbookStore.getState().fullView;
    void openWorkbook(path, { full, ...(opts.range ? { focus: opts.range } : {}) }).catch(
      () => undefined,
    );
  } else if (kind === "image") {
    openImagePreview(path);
  } else if (kind === "text") {
    openTextPreview(path);
  } else {
    void downloadWorkspaceFile(path).catch(() => undefined);
  }
  return kind;
}
