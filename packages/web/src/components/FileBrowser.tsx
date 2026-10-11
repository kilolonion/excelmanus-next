import type { FileEntry } from "@excelmanus/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiClientOf,
  noteManualView,
  openWorkspaceFile,
  uploadWorkspaceFile,
  useApp,
} from "../store.ts";
import { FILES, S, UI } from "../strings.ts";
import { Icon } from "./Icon.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { useConfirm } from "./ui/confirm.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Badge, EmptyState, NavItem, SectionLabel } from "./ui/display.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input, SearchInput } from "./ui/input.tsx";
import { ListDetailLayout, PageState } from "./ui/page-layout.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Tip } from "./ui/tooltip.tsx";

const OPENABLE = /\.(xlsx|xlsm|csv|tsv)$/i;

export function FileList({
  compact = false,
  variant = "panel",
  onOpen,
}: {
  compact?: boolean;
  variant?: "panel" | "page";
  onOpen?: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const workspaceId = useApp((state) => state.workspaceId);
  const rootFiles = useApp((state) => state.files);
  const doc = useApp((state) => state.doc);
  const session = useApp((state) => state.session);
  const changedPaths = useMemo(() => {
    const lastUserSeq = Math.max(
      0,
      ...session.messages
        .filter((message) => message.role === "user" && (message.agentId ?? "main") === "main")
        .map((message) => message.seq ?? 0),
    );
    return new Set(
      session.changes
        .filter((change) => change.seq > lastUserSeq && change.path !== "")
        .map((change) => change.path),
    );
  }, [session]);
  const [directory, setDirectory] = useState("");
  const [items, setItems] = useState<FileEntry[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState<{ path?: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const generation = useRef(0);
  const inFlight = useRef(false);
  const previousWorkspace = useRef(workspaceId);
  useEffect(() => {
    if (previousWorkspace.current !== workspaceId) {
      previousWorkspace.current = workspaceId;
      generation.current++;
      setDirectory("");
      setSelectedPath(null);
      setEdit(null);
      setItems([]);
      setQuery("");
    }
  }, [workspaceId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: server file events and completed mutations invalidate the directory listing
  useEffect(() => {
    let cancelled = false;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    void apiClientOf()
      .listFiles(workspaceId, directory)
      .then((result) => {
        if (!cancelled && current === generation.current) setItems(result.items);
      })
      .catch((e: unknown) => {
        if (!cancelled && current === generation.current) {
          setItems([]);
          setError(e instanceof Error ? e.message : FILES.failed);
        }
      })
      .finally(() => {
        if (!cancelled && current === generation.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, directory, revision, rootFiles]);
  const run = async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const ws = workspaceId;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (useApp.getState().workspaceId === ws) setRevision((value) => value + 1);
    } catch (e) {
      if (useApp.getState().workspaceId === ws)
        setError(e instanceof Error ? e.message : FILES.failed);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const selected = items.find((item) => item.path === selectedPath);
  const download = (item: FileEntry) =>
    run(async () => {
      const blob = await apiClientOf().downloadFile(workspaceId, item.path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  const remove = async (item: FileEntry) => {
    const ws = workspaceId;
    if (
      !(await confirm({
        title: FILES.deleteTitle,
        description: FILES.deleteHint,
        confirmLabel: FILES.delete,
        tone: "destructive",
      }))
    )
      return;
    if (useApp.getState().workspaceId !== ws) return;
    await run(() =>
      apiClientOf().manageFiles(ws, { confirmed: true, ops: [{ op: "delete", path: item.path }] }),
    );
  };
  const open = (item: FileEntry) => {
    if (item.kind === "dir") {
      setItems([]);
      setDirectory(item.path);
      setQuery("");
      setSelectedPath(null);
      return;
    }
    if (!OPENABLE.test(item.name)) {
      setError(S.unsupportedFile);
      return;
    }
    noteManualView();
    void run(async () => {
      await openWorkspaceFile(item.path);
      onOpen?.();
    });
  };
  const visible = items.filter((item) =>
    `${item.name} ${item.path}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const rows = visible.map((item) => (
    <div key={item.path} className="file-entry flex min-w-0 items-center gap-2">
      <Tip content={item.path} side="right">
        <NavItem
          className="min-w-0 flex-1"
          current={variant === "page" ? selectedPath === item.path : doc?.path === item.path}
          disabled={busy}
          icon={
            <Icon
              name={
                item.kind === "dir" ? "folder" : OPENABLE.test(item.name) ? "fileSheet" : "file"
              }
              size="sm"
            />
          }
          meta={
            changedPaths.has(item.path) ? (
              <Badge tone="ok">{S.fileChangedThisTurn}</Badge>
            ) : variant === "page" && item.kind === "file" ? (
              <span className="font-mono text-xs text-muted-foreground">
                {item.size === undefined ? UI.unknown : `${Math.ceil(item.size / 1024)} KB`}
              </span>
            ) : undefined
          }
          onClick={() =>
            variant === "page" && item.kind !== "dir" ? setSelectedPath(item.path) : open(item)
          }
        >
          {item.name}
        </NavItem>
      </Tip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            icon="more"
            label={`${FILES.actions}: ${item.name}`}
            size="icon-xs"
            disabled={busy}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {item.kind !== "dir" && (
            <DropdownMenuItem onSelect={() => void download(item)}>
              {FILES.download}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setEdit({ path: item.path, name: item.name })}>
            {FILES.rename}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void remove(item)}>{FILES.delete}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ));
  const detail = selected ? (
    <div className="file-browser-detail">
      <Button
        variant="ghost"
        className="self-start md:hidden"
        onClick={() => setSelectedPath(null)}
      >
        {UI.backToList}
      </Button>
      <Icon
        name={OPENABLE.test(selected.name) ? "fileSheet" : "file"}
        size="xl"
        className="text-primary"
      />
      <h3>{selected.name}</h3>
      <dl>
        <dt>{UI.filePath}</dt>
        <dd>{selected.path}</dd>
        <dt>{UI.fileType}</dt>
        <dd>{selected.name.split(".").at(-1)?.toUpperCase() ?? UI.unknown}</dd>
        <dt>{UI.fileSize}</dt>
        <dd>
          {selected.size === undefined ? UI.unknown : `${Math.ceil(selected.size / 1024)} KB`}
        </dd>
        <dt>{UI.fileUpdated}</dt>
        <dd>
          {selected.modifiedAt
            ? new Date(selected.modifiedAt).toLocaleString(S.locale)
            : UI.unknown}
        </dd>
      </dl>
      {OPENABLE.test(selected.name) && (
        <Button loading={busy} onClick={() => open(selected)}>
          {UI.openFile}
        </Button>
      )}
      <Button variant="outline" disabled={busy} onClick={() => void download(selected)}>
        {FILES.download}
      </Button>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => setEdit({ path: selected.path, name: selected.name })}
      >
        {FILES.rename}
      </Button>
      <Button variant="destructive-ghost" disabled={busy} onClick={() => void remove(selected)}>
        {FILES.delete}
      </Button>
    </div>
  ) : (
    <PageState kind="empty" title={UI.selectFile} description={UI.selectFileHint} />
  );
  return (
    <div
      className={
        variant === "page"
          ? "file-browser-page"
          : compact
            ? "flex flex-col gap-0"
            : "flex flex-col gap-1"
      }
    >
      <div className="file-browser-controls flex items-center justify-between gap-1">
        <SectionLabel>{S.files}</SectionLabel>
        <div className="flex gap-1">
          {variant === "page" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setEdit({ name: "" })}>
                <Icon name="plus" size="sm" />
                {FILES.newFolder}
              </Button>
              <Button disabled={busy} onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size="sm" />
                {S.upload}
              </Button>
            </>
          ) : (
            <>
              {" "}
              <IconButton
                icon="plus"
                label={FILES.newFolder}
                size="icon-xs"
                disabled={busy}
                onClick={() => setEdit({ name: "" })}
              />
              <IconButton
                icon="upload"
                label={S.upload}
                size="icon-xs"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              />
            </>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file)
              void run(async () => {
                await uploadWorkspaceFile(file, directory);
              });
          }}
        />
      </div>
      <div className="file-browser-breadcrumb flex min-w-0 items-center gap-1">
        {directory !== "" && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => {
              setItems([]);
              setDirectory(directory.split("/").slice(0, -1).join("/"));
            }}
          >
            {FILES.parent}
          </Button>
        )}
        <Tip content={directory || FILES.root}>
          <span className="truncate text-xs text-muted-foreground">{directory || FILES.root}</span>
        </Tip>
      </div>
      <SearchInput
        className="file-browser-search"
        aria-label={S.searchFiles}
        placeholder={S.searchFilesPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {loading && (
        <div role="status" className="flex items-center gap-2 text-xs">
          <Spinner size="xs" />
          {FILES.loading}
        </div>
      )}
      {!loading && visible.length === 0 && (
        <EmptyState size="inline" title={query ? S.filesNoMatch : S.noFiles} />
      )}
      {variant === "page" ? (
        <ListDetailLayout label={UI.filesTitle} selected={!!selected} list={rows} detail={detail} />
      ) : (
        rows
      )}
      <Dialog
        open={edit !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEdit(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{edit?.path ? FILES.rename : FILES.newFolder}</DialogTitle>
          <DialogDescription>{FILES.nameHint}</DialogDescription>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!edit || busy) return;
              const name = edit.name.trim();
              if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
                setError(FILES.invalidName);
                return;
              }
              const target = directory ? `${directory}/${name}` : name;
              void run(async () => {
                await apiClientOf().manageFiles(workspaceId, {
                  ops: edit.path
                    ? [{ op: "move", path: edit.path, to: target }]
                    : [{ op: "mkdir", path: target }],
                });
                setEdit(null);
              });
            }}
          >
            <Input
              aria-label={FILES.name}
              value={edit?.name ?? ""}
              disabled={busy}
              onChange={(event) =>
                setEdit((value) => value && { ...value, name: event.target.value })
              }
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setEdit(null)}>
                {FILES.cancel}
              </Button>
              <Button type="submit" disabled={busy}>
                {FILES.confirm}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
