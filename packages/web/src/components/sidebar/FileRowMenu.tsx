// 文件/文件夹行的「更多」菜单：列表视图与文件夹视图共用。

import type { FileEntry } from "@excelmanus/protocol";
import {
  AtSign,
  Columns2,
  Download,
  Ellipsis,
  FilePlus2,
  FolderPlus,
  Info,
  Maximize2,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { openWorkspaceFile } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { downloadWorkspaceFile } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";
import { deleteWithConfirm, mentionFiles } from "./file-actions";

interface FileRowMenuProps {
  entry: FileEntry;
  /** 行处于激活状态时常显按钮。 */
  pinned?: boolean;
  onRename: () => void;
  onInfo?: () => void;
  /** 文件夹：在其中新建文件夹 / 上传。 */
  onCreateFolder?: () => void;
  onCreateFile?: () => void;
  onUploadHere?: () => void;
  onOpenChange?: (open: boolean) => void;
}

export function FileRowMenu({
  entry,
  pinned,
  onRename,
  onInfo,
  onCreateFolder,
  onCreateFile,
  onUploadHere,
  onOpenChange,
}: FileRowMenuProps) {
  const isDir = entry.kind === "dir";
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${entry.name} 的更多操作`}
          className={cn(
            "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 hover:bg-accent hover:text-foreground",
            pinned
              ? "opacity-100"
              : "touch-show opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
          onClick={stop}
          onDoubleClick={stop}
        >
          <Ellipsis className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="w-44"
        onClick={stop}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {isDir ? (
          <>
            {onCreateFolder && (
              <DropdownMenuItem onSelect={onCreateFolder}>
                <FolderPlus className="h-4 w-4" />
                新建文件夹
              </DropdownMenuItem>
            )}
            {onCreateFile && (
              <DropdownMenuItem onSelect={onCreateFile}>
                <FilePlus2 className="h-4 w-4" />
                新建文件
              </DropdownMenuItem>
            )}
            {onUploadHere && (
              <DropdownMenuItem onSelect={onUploadHere}>
                <Upload className="h-4 w-4" />
                上传到此处
              </DropdownMenuItem>
            )}
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => mentionFiles([entry])}>
              <AtSign className="h-4 w-4" />
              引用到输入框
            </DropdownMenuItem>
            {isSpreadsheetFile(entry.name) && (
              <DropdownMenuItem onSelect={() => openWorkspaceFile(entry.path, { intent: "full" })}>
                <Maximize2 className="h-4 w-4" />
                全屏打开
              </DropdownMenuItem>
            )}
            {isSpreadsheetFile(entry.name) && (
              <DropdownMenuItem onSelect={() => useUIStore.getState().openCompare(entry.path)}>
                <Columns2 className="h-4 w-4" />
                与另一个表格对比…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => void downloadWorkspaceFile(entry.path).catch(() => undefined)}
            >
              <Download className="h-4 w-4" />
              下载
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRename}>
          <Pencil className="h-4 w-4" />
          重命名
        </DropdownMenuItem>
        {onInfo && !isDir && (
          <DropdownMenuItem onSelect={onInfo}>
            <Info className="h-4 w-4" />
            文件信息
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void deleteWithConfirm([entry])}>
          <Trash2 className="h-4 w-4" />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
