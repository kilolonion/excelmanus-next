// 输入框附件：全部走 chat-store 的附件 API（图片作消息附件，其余上传到工作区后以 @路径 引用）。
// 这里只负责把各入口（选择、拖放、粘贴、工作区拖入）接到 store 上，并在需要时先建好会话。

import type React from "react";
import { useCallback } from "react";
import { errorMessage } from "@/lib/backend/api";
import {
  addComposerFiles,
  attachWorkspaceFile,
  canAddComposerAttachments,
  setChatNotice,
  useChatStore,
} from "@/stores/chat-store";
import { ensureActiveSession } from "@/stores/session-store";
import type { WorkspaceDroppedFile } from "./chat-drop";

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function fileMetadataLine(line: string): string {
  let value = line.trim().replace(/^['"]|['"]$/g, "");
  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(value.slice("file://".length));
    } catch {
      value = value.slice("file://".length);
    }
  }
  return value.replace(/\\/g, "/");
}

/**
 * 原生文件复制往往同时带一行路径文本，那是元数据；表格/网页复制则可能带有用的 TSV/HTML 文本。
 * 只有文本明确是被粘贴文件的路径时才拦下默认粘贴。
 */
function isClipboardFileMetadata(data: DataTransfer, files: File[], text: string): boolean {
  if (!text.trim()) return true;
  const uriList = data.getData("text/uri-list").trim();
  const lines = (uriList || text).split(/\r?\n/).map(fileMetadataLine).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) => {
    const pathLike = line.startsWith("/") || line.startsWith("~/") || /^[A-Za-z]:\//.test(line);
    if (!pathLike && !uriList) return false;
    return files.some((file) => line === file.name || line.endsWith(`/${file.name}`));
  });
}

/** 附件需要工作区：还没有会话时先复用或新建一个。 */
async function ensureComposerSession(): Promise<boolean> {
  if (!canAddComposerAttachments()) return false;
  const origin = useChatStore.getState();
  if (origin.workspaceId) return true;
  try {
    await ensureActiveSession();
    return !!useChatStore.getState().workspaceId;
  } catch (error) {
    const current = useChatStore.getState();
    if (current.sessionId === origin.sessionId && current.viewAgentId === origin.viewAgentId)
      setChatNotice(errorMessage(error, "无法创建对话，附件未添加"), "error");
    return false;
  }
}

export function useChatUpload() {
  const attachments = useChatStore((s) => s.attachments);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    void ensureComposerSession().then((ok) => {
      if (ok) void addComposerFiles(files);
    });
  }, []);

  const attachWorkspaceFiles = useCallback((files: WorkspaceDroppedFile[]) => {
    if (files.length === 0) return;
    void ensureComposerSession().then((ok) => {
      if (ok) for (const file of files) attachWorkspaceFile(file.path || file.filename);
    });
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const picked = clipboardFiles(e.clipboardData);
      if (picked.length === 0) return;
      const pastedText = e.clipboardData.getData("text/plain");
      // 文件与文本并存（如 Excel 复制单元格同时带截图和 TSV）时保留默认粘贴，只追加附件
      if (isClipboardFileMetadata(e.clipboardData, picked, pastedText)) e.preventDefault();
      addFiles(picked);
    },
    [addFiles],
  );

  return {
    attachments,
    addFiles,
    attachWorkspaceFiles,
    handlePaste,
    hasUploadingFiles: attachments.some((a) => a.status === "uploading"),
    hasFailedFiles: attachments.some((a) => a.status === "error"),
  };
}
