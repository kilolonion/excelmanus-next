import type { Workspace } from "@excelmanus/protocol";
import { Folder, FolderOpen, FolderPlus, Loader2, X } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  OverlayCard,
  OverlayCardAction,
  OverlayCardBody,
  OverlayCardFooter,
} from "@/components/ui/overlay-card";
import { desktop, errorMessage } from "@/lib/backend/api";
import { cn } from "@/lib/utils";
import { addWorkspace, renameWorkspace } from "@/stores/app-store";

function folderNameFromPath(path: string): string {
  const parts = path.trim().split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || "";
}

/** 登记工作区（本机文件夹）或修改已登记工作区的名称；路径是工作区身份，登记后不能更换。 */
export function AddWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
  workspace = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspace: Workspace | null) => void;
  workspace?: Workspace | null;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [pathOpen, setPathOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isEdit = Boolean(workspace?.id);
  const pathLocked = isEdit;
  const canPick = Boolean(desktop());

  const inferredTitle = useMemo(() => folderNameFromPath(path), [path]);
  const showPathEditor = pathOpen || Boolean(path.trim());

  useLayoutEffect(() => {
    if (!open) return;
    setTitle(workspace?.name || "");
    setPath(workspace?.path || "");
    setPathOpen(Boolean(workspace?.path));
    setPicking(false);
    setBusy(false);
    setError("");
  }, [open, workspace]);

  useEffect(() => {
    if (!open) return;
    const node = showPathEditor ? pathRef.current : nameRef.current;
    const id = window.requestAnimationFrame(() => node?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open, showPathEditor]);

  const close = useCallback(() => {
    if (busy || picking) return;
    onOpenChange(false);
  }, [busy, onOpenChange, picking]);

  const handleChooseFolder = useCallback(async () => {
    if (busy || picking || pathLocked) return;
    const bridge = desktop();
    if (!bridge) {
      // 网页端没有系统文件夹选择器：直接输入运行 ExcelManus 的电脑上的绝对路径
      setPathOpen(true);
      window.requestAnimationFrame(() => pathRef.current?.focus());
      return;
    }
    setPicking(true);
    setError("");
    try {
      const selectedPath = await bridge.chooseDirectory();
      if (!selectedPath) return;
      setPath(selectedPath);
      setPathOpen(true);
    } catch (err) {
      setPathOpen(true);
      setError(errorMessage(err, "无法打开系统文件夹选择器"));
      window.requestAnimationFrame(() => pathRef.current?.focus());
    } finally {
      setPicking(false);
    }
  }, [busy, pathLocked, picking]);

  const handleAdd = useCallback(async () => {
    const nextPath = path.trim();
    if (!nextPath) {
      setError(canPick ? "请选择本机文件夹" : "请输入文件夹的绝对路径");
      void handleChooseFolder();
      return;
    }
    const nextTitle = title.trim() || inferredTitle;
    if (isEdit && !nextTitle) {
      setError("请输入工作区名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (isEdit && workspace?.id) {
        await renameWorkspace(workspace.id, nextTitle);
        onCreated?.(null);
      } else {
        onCreated?.(await addWorkspace(nextPath, nextTitle || undefined));
      }
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, isEdit ? "保存失败" : "添加失败"));
    } finally {
      setBusy(false);
    }
  }, [
    canPick,
    handleChooseFolder,
    inferredTitle,
    isEdit,
    onCreated,
    onOpenChange,
    path,
    title,
    workspace?.id,
  ]);

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleAdd();
    }
  };

  return (
    <OverlayCard
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="lg"
      tone="primary"
    >
      <div className="flex items-center gap-3 px-5 pt-5 sm:px-8 sm:pt-7">
        <DialogTitle className="min-w-0 flex-1 text-[20px] sm:text-[22px] font-semibold tracking-tight text-foreground">
          {isEdit ? "编辑工作区" : "添加工作区"}
        </DialogTitle>
        <button
          type="button"
          onClick={close}
          disabled={busy || picking}
          className="inline-flex size-11 sm:size-8 items-center justify-center rounded-xl text-muted-foreground/50 hover:bg-muted/80 hover:text-foreground transition-colors disabled:opacity-40"
          title="关闭"
        >
          <X className="h-5 w-5 sm:h-[18px] sm:w-[18px]" />
        </button>
      </div>
      <DialogDescription className="sr-only">
        {isEdit
          ? "修改工作区名称。工作区对应的文件夹登记后不能更换。"
          : "输入工作区名称，并选择或输入本机文件夹。聊天记录不会写入该文件夹。"}
      </DialogDescription>

      <OverlayCardBody className="flex flex-col gap-5 pt-5 pb-6">
        {!isEdit && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            代理只能读写已登记工作区里的文件。工作区之间不能互相包含，也不能包含应用数据目录。
          </p>
        )}
        <label className="flex h-12 items-center overflow-hidden rounded-full border border-[var(--em-hairline)] bg-background transition-[border-color,box-shadow] focus-within:border-[var(--em-primary)] focus-within:ring-2 focus-within:ring-[var(--em-primary-alpha-15)]">
          <span className="flex h-full w-12 shrink-0 items-center justify-center border-r border-[var(--em-hairline)] text-muted-foreground">
            <Folder className="h-4 w-4" />
          </span>
          <input
            ref={nameRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={submitOnEnter}
            placeholder={inferredTitle || "工作区名称"}
            disabled={busy || picking}
            autoComplete="off"
            aria-label="工作区名称"
            className="h-full min-w-0 flex-1 bg-transparent px-3.5 text-[15px] outline-none placeholder:text-muted-foreground/55 disabled:opacity-60"
          />
        </label>

        <div className="flex flex-col gap-2.5">
          <p className="text-[14px] font-medium text-foreground">源文件夹</p>
          {showPathEditor ? (
            <div
              className={cn(
                "flex min-h-[132px] w-full flex-col items-stretch justify-center gap-3 rounded-[20px] border px-5 py-6",
                error
                  ? "border-destructive/40 bg-[var(--em-fill)]"
                  : "border-[var(--em-hairline)] bg-[var(--em-fill)]",
              )}
            >
              <div className="flex items-center gap-2">
                <FolderPlus className="h-4 w-4 shrink-0 text-[var(--em-primary)]" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {inferredTitle ? (
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {inferredTitle}
                    </span>
                  ) : null}
                  <input
                    ref={pathRef}
                    value={path}
                    onChange={(event) => {
                      setPath(event.target.value);
                      if (error) setError("");
                    }}
                    onKeyDown={submitOnEnter}
                    placeholder="/path/to/existing/folder"
                    disabled={busy || picking}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={Boolean(error)}
                    aria-label="源文件夹路径"
                    readOnly={pathLocked}
                    className="h-8 min-w-0 w-full bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground/55 disabled:opacity-60 read-only:text-muted-foreground"
                  />
                </div>
                {pathLocked ? null : (
                  <button
                    type="button"
                    onClick={() => void handleChooseFolder()}
                    disabled={busy || picking}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background/80 hover:text-foreground disabled:opacity-40"
                    title="更换文件夹"
                    aria-label="更换源文件夹"
                  >
                    {picking ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderOpen className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {pathLocked ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      setPath("");
                      setPathOpen(false);
                      setError("");
                    }}
                    disabled={busy || picking}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background/80 hover:text-foreground"
                    title="移除文件夹"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <p className="text-[12px] leading-relaxed text-[var(--em-text-secondary)]">
                {pathLocked
                  ? "工作区的文件夹是它的身份，登记后不能更换；需要换文件夹时请登记新的工作区。"
                  : "使用运行 ExcelManus 的电脑上的绝对路径；文件夹不存在时会自动创建。聊天记录不会写入该目录。"}
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void handleChooseFolder()}
              disabled={busy || picking}
              className={cn(
                "flex min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-[20px] border border-[var(--em-hairline)] bg-[var(--em-fill)] px-6 py-8 text-center transition-colors",
                "hover:border-[var(--em-primary-alpha-30)] hover:bg-[var(--em-primary-alpha-04)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--em-primary-alpha-15)]",
              )}
            >
              {picking ? (
                <Loader2 className="h-5 w-5 animate-spin text-[var(--em-primary)]" />
              ) : (
                <FolderPlus className="h-5 w-5 text-muted-foreground" />
              )}
              <span className="text-[14px] text-foreground">
                {picking
                  ? "正在打开系统文件夹选择器…"
                  : canPick
                    ? "选择 ExcelManus 可读取和编辑的文件夹"
                    : "输入 ExcelManus 可读取和编辑的文件夹路径"}
              </span>
            </button>
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </OverlayCardBody>

      <OverlayCardFooter className="border-t-0 pt-1 sm:pt-0">
        <OverlayCardAction
          action="ghost"
          className="sm:flex-none sm:w-auto sm:h-10 sm:px-3 text-muted-foreground"
          onClick={close}
          disabled={busy || picking}
        >
          取消
        </OverlayCardAction>
        <OverlayCardAction
          action="primary"
          className="sm:flex-none sm:w-auto sm:h-10 sm:rounded-full sm:px-5"
          onClick={() => void handleAdd()}
          disabled={busy || picking}
        >
          {busy ? (isEdit ? "保存中…" : "添加中…") : isEdit ? "保存" : "添加工作区"}
        </OverlayCardAction>
      </OverlayCardFooter>
    </OverlayCard>
  );
}
