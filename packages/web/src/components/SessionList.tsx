// 侧栏（02 §2.1）：品牌 + 会话 + 文件 + 代理团队（有子代理时）+ 设置入口。

import type { SessionSummary } from "@excelmanus/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../reduce.ts";
import { filterSessions } from "../session-search.ts";
import {
  apiClientOf,
  createSession,
  exportSession,
  noteManualView,
  openWorkspaceFile,
  removeSession,
  renameSessionById,
  selectSession,
  setSettingsOpen,
  signOut,
  switchWorkspace,
  uploadWorkspaceFile,
  useApp,
} from "../store.ts";
import { S } from "../strings.ts";
import { setTheme } from "../theme.ts";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog.tsx";
import { BrandMark, Icon } from "./Icon.tsx";
import { TeamPanel } from "./TeamPanel.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import { useConfirm } from "./ui/confirm.tsx";
import { SegmentedControl } from "./ui/controls.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Badge, EmptyState, NavItem, SectionLabel, StatusDot } from "./ui/display.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input, SearchInput } from "./ui/input.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
  toast,
} from "./ui/overlay.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Tip } from "./ui/tooltip.tsx";

const OPENABLE = /\.(xlsx|xlsm|csv|tsv)$/i;
const WORKSPACE_GROUPS_KEY = "excelmanus.workspaceGroups";
const GROUP_PREVIEW_COUNT = 5;

function readCollapsedGroups(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WORKSPACE_GROUPS_KEY) ?? "null");
    return value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === "boolean"))
      : {};
  } catch {
    return {};
  }
}

function groupPreview(
  sessions: SessionSummary[],
  expanded: boolean,
  currentId: string | null,
): SessionSummary[] {
  if (expanded) return sessions;
  const recent = sessions.slice(0, GROUP_PREVIEW_COUNT);
  const current = sessions.find((session) => session.id === currentId);
  return current && !recent.includes(current) ? [...recent, current] : recent;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return "";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return S.justNow;
  if (min < 60) return S.minutesAgo(min);
  const h = Math.floor(min / 60);
  if (h < 24) return S.hoursAgo(h);
  return S.daysAgo(Math.floor(h / 24));
}

type SessionSignalKind =
  | "running"
  | "pendingApproval"
  | "pendingQuestion"
  | "queued"
  | "interrupted"
  | "failed"
  | "waiting";

interface SessionSignal {
  kind: SessionSignalKind;
  label: string;
}

function signalForState(state: SessionState): SessionSignal | null {
  if (state.approvals.some((item) => item.status === "pending")) {
    return { kind: "pendingApproval", label: S.sessionStatusPendingApproval };
  }
  if (state.questions.some((item) => item.status === "pending")) {
    return { kind: "pendingQuestion", label: S.sessionStatusPendingQuestion };
  }
  return signalForStatuses(Object.values(state.agentStatus));
}

function signalForStatuses(statuses: Iterable<string>): SessionSignal | null {
  const values = [...statuses];
  if (values.some((status) => status === "running")) {
    return { kind: "running", label: S.sessionStatusRunning };
  }
  if (values.some((status) => status === "queued")) {
    return { kind: "queued", label: S.sessionStatusQueued };
  }
  if (values.some((status) => status === "interrupted")) {
    return { kind: "interrupted", label: S.sessionStatusInterrupted };
  }
  if (values.some((status) => status === "failed")) {
    return { kind: "failed", label: S.sessionStatusFailed };
  }
  if (values.some((status) => status === "waiting" || status === "blocked")) {
    return { kind: "waiting", label: S.sessionStatusWaiting };
  }
  return null;
}

function signalForDetail(detail: {
  agents: { status: string }[];
  pendingInteractions?: { kind: "approval" | "question" }[];
}): SessionSignal | null {
  const pending = detail.pendingInteractions ?? [];
  if (pending.some((item) => item.kind === "approval")) {
    return { kind: "pendingApproval", label: S.sessionStatusPendingApproval };
  }
  if (pending.some((item) => item.kind === "question")) {
    return { kind: "pendingQuestion", label: S.sessionStatusPendingQuestion };
  }
  return signalForStatuses(detail.agents.map((agent) => agent.status));
}

const SIGNAL_TONE: Record<SessionSignalKind, "neutral" | "read" | "warn" | "err"> = {
  running: "read",
  pendingApproval: "warn",
  pendingQuestion: "warn",
  queued: "warn",
  interrupted: "warn",
  failed: "err",
  waiting: "neutral",
};

function SideHeading({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-1.5 px-2">
      <SectionLabel>{label}</SectionLabel>
      {count !== undefined && count > 0 && <Badge tone="neutral">{count}</Badge>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

export function FileList({ compact = false }: { compact?: boolean }) {
  const files = useApp((s) => s.files);
  const doc = useApp((s) => s.doc);
  const session = useApp((s) => s.session);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const normalizedFileQuery = fileQuery.trim().toLowerCase();
  // 文件项的状态来自当前会话真实的 workbook_edit 结果；只标记当前轮产生的文件。
  const changedThisTurn = useMemo(() => {
    let lastUserSeq = 0;
    for (const message of session.messages) {
      if (message.role === "user" && (message.agentId ?? "main") === "main") {
        lastUserSeq = Math.max(lastUserSeq, message.seq ?? 0);
      }
    }
    return new Set(
      session.changes
        .filter((change) => change.seq > lastUserSeq && change.path !== "")
        .map((change) => change.path),
    );
  }, [session]);
  const visibleFiles =
    normalizedFileQuery === ""
      ? files
      : files.filter(
          (file) =>
            file.name.toLowerCase().includes(normalizedFileQuery) ||
            file.path.toLowerCase().includes(normalizedFileQuery),
        );
  return (
    <div className={cn("flex flex-col gap-0.5", compact && "gap-0")}>
      <SideHeading label={S.files} count={files.length}>
        <IconButton
          icon="upload"
          size="icon-xs"
          label={S.upload}
          onClick={() => fileInput.current?.click()}
        />
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void uploadWorkspaceFile(f).catch(() => setErr(S.uploadFailed));
          }}
        />
      </SideHeading>
      <div className="relative px-0.5 pb-1">
        <SearchInput
          aria-label={S.searchFiles}
          placeholder={S.searchFilesPlaceholder}
          value={fileQuery}
          onChange={(event) => setFileQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && fileQuery !== "") {
              event.preventDefault();
              setFileQuery("");
            }
          }}
          className="[&>input]:pr-9"
        />
        {fileQuery !== "" && (
          <IconButton
            icon="x"
            size="icon-xs"
            label={S.clearSearch}
            tooltip={S.clearSearch}
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
            onClick={() => setFileQuery("")}
          />
        )}
      </div>
      {err && (
        <p className="px-2 text-xs text-destructive" role="alert">
          {err}
        </p>
      )}
      {visibleFiles.length === 0 && (
        <EmptyState size="inline" title={fileQuery.trim() === "" ? S.noFiles : S.filesNoMatch} />
      )}
      {visibleFiles.map((f) => {
        const openable = f.kind !== "dir" && OPENABLE.test(f.name);
        const active = doc?.path === f.path;
        const changed = changedThisTurn.has(f.path);
        const modified = f.modifiedAt ? relativeTime(f.modifiedAt) : "";
        return (
          <Tip key={f.path} content={f.path} side="right">
            <NavItem
              data-slot="file-item"
              current={active}
              muted={!openable}
              disabled={f.kind === "dir"}
              icon={
                <Icon
                  name={f.kind === "dir" ? "folder" : openable ? "fileSheet" : "file"}
                  size="sm"
                  className={openable ? "text-ok" : "text-muted-foreground"}
                />
              }
              meta={
                <span className="flex items-center gap-1">
                  {busy === f.path && <Spinner size="xs" />}
                  {changed && <Badge tone="ok">{S.fileChangedThisTurn}</Badge>}
                  {modified && <time dateTime={f.modifiedAt}>{modified}</time>}
                </span>
              }
              onClick={() => {
                if (!openable) {
                  setErr(S.unsupportedFile);
                  return;
                }
                setErr(null);
                noteManualView();
                setBusy(f.path);
                void openWorkspaceFile(f.path)
                  .catch(() => setErr(S.docLoadFailed))
                  .finally(() => setBusy(null));
              }}
            >
              {f.name}
            </NavItem>
          </Tip>
        );
      })}
    </div>
  );
}

/** 当前工作区始终可展开：切换、登记文件夹与管理入口。 */
function WorkspaceSwitcher() {
  const workspaces = useApp((s) => s.workspaces);
  const workspaceId = useApp((s) => s.workspaceId);
  const sessions = useApp((s) => s.sessions);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const current = workspaces.find((w) => w.id === workspaceId);
  if (!current) return null;
  return (
    <div className="flex flex-col gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            aria-label={`${S.workspace}：${current.name}`}
            className={cn(
              "w-full justify-start gap-2 px-2 text-foreground",
              err && "ring-1 ring-destructive",
            )}
          >
            <Icon name="folder" size="sm" />
            <span className="min-w-0 flex-1 truncate text-left">{current.name}</span>
            <Icon name="chevronsUpDown" size="xs" className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <DropdownMenuRadioGroup
            value={workspaceId}
            onValueChange={(v) => {
              setErr(null);
              void switchWorkspace(v).catch((error: unknown) =>
                setErr(error instanceof Error ? error.message : S.workspaceSwitchFailed),
              );
            }}
          >
            {workspaces.map((w) => (
              <DropdownMenuRadioItem
                key={w.id}
                value={w.id}
                description={
                  <span className="flex flex-col gap-0.5">
                    <span className="truncate">{w.path}</span>
                    <span>
                      {S.workspaceSessionCount(
                        sessions.filter((session) => session.workspaceId === w.id).length,
                      )}
                    </span>
                  </span>
                }
              >
                <span className="flex items-center gap-1.5">
                  {w.name}
                  {w.isDefault && <Badge tone="neutral">{S.defaultWorkspaceTag}</Badge>}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAddOpen(true)}>
            <Icon name="plus" size="sm" />
            {S.addWorkspace}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSettingsOpen(true, "files")}>
            <Icon name="settings" size="sm" />
            {S.manageWorkspaces}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {err && (
        <p className="px-2 text-xs text-destructive" role="alert">
          {err}
        </p>
      )}
      {addOpen && <AddWorkspaceDialog open onOpenChange={setAddOpen} />}
    </div>
  );
}

export function SessionList() {
  const allSessions = useApp((s) => s.sessions);
  const files = useApp((s) => s.files);
  const workspaceId = useApp((s) => s.workspaceId);
  const workspaces = useApp((s) => s.workspaces);
  const sessionId = useApp((s) => s.sessionId);
  const sessionState = useApp((s) => s.session);
  const connected = useApp((s) => s.connected);
  const confirm = useConfirm();
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionSignals, setSessionSignals] = useState<Record<string, SessionSignal>>({});
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<"sessions" | "files">("sessions");
  const [creating, setCreating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(readCollapsedGroups);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const searching = sessionQuery.trim() !== "";
  const groups = useMemo(() => {
    const matches = filterSessions(allSessions, sessionQuery, S.untitledSession);
    return workspaces
      .map((workspace) => ({
        workspace,
        sessions: matches.filter((session) => session.workspaceId === workspace.id),
        count: allSessions.filter((session) => session.workspaceId === workspace.id).length,
      }))
      .filter((group) => !searching || group.sessions.length > 0);
  }, [allSessions, workspaces, sessionQuery, searching]);
  const sessions = useMemo(
    () =>
      groups.flatMap((group) =>
        searching || !collapsedGroups[group.workspace.id]
          ? groupPreview(
              group.sessions,
              searching || expandedGroups[group.workspace.id] === true,
              sessionId,
            )
          : [],
      ),
    [groups, searching, collapsedGroups, expandedGroups, sessionId],
  );
  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_GROUPS_KEY, JSON.stringify(collapsedGroups));
    } catch {
      // 展示偏好保存失败不影响真实会话与工作区绑定。
    }
  }, [collapsedGroups]);

  // 导航选中的会话所在组自动展开；用户仍可在选中后手动折叠。
  useEffect(() => {
    if (!sessionId) return;
    const selected = useApp.getState().sessions.find((session) => session.id === sessionId);
    if (selected)
      setCollapsedGroups((current) =>
        current[selected.workspaceId] ? { ...current, [selected.workspaceId]: false } : current,
      );
  }, [sessionId]);

  const newChat = (targetWorkspaceId = workspaceId) => {
    setCreating(true);
    setSessionQuery("");
    void createSession(targetWorkspaceId)
      .catch((error: unknown) =>
        toast({
          tone: "err",
          title: error instanceof Error ? error.message : S.newSessionFailed,
        }),
      )
      .finally(() => setCreating(false));
  };

  // 列表摘要只有时间和游标；状态从真实会话详情读取，失败时保持无状态展示。
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(
        sessions.map(async (item) => {
          try {
            const detail = await apiClientOf().getSession(item.id);
            const signal = signalForDetail(detail);
            return signal ? ([item.id, signal] as const) : null;
          } catch {
            return null;
          }
        }),
      );
      if (!alive) return;
      setSessionSignals(
        Object.fromEntries(
          entries.filter((item): item is [string, SessionSignal] => item !== null),
        ),
      );
    };
    void load();
    return () => {
      alive = false;
    };
  }, [sessions]);

  const commitRename = async () => {
    if (!renameId || renameValue.trim() === "") return;
    setRenameBusy(true);
    setRenameError(false);
    try {
      await renameSessionById(renameId, renameValue);
      setRenameId(null);
    } catch {
      setRenameError(true);
    } finally {
      setRenameBusy(false);
    }
  };

  const renderSession = (s: SessionSummary) => {
    const active = s.id === sessionId;
    const title = s.title ?? S.untitledSession;
    const signal = active ? signalForState(sessionState) : sessionSignals[s.id];
    return (
      <Tip key={s.id} content={title} side="right">
        <NavItem
          data-session-id={s.id}
          current={active}
          meta={
            <span className="flex items-center gap-1.5">
              {signal && (
                <Badge tone={SIGNAL_TONE[signal.kind]}>
                  <StatusDot
                    tone={SIGNAL_TONE[signal.kind]}
                    pulse={signal.kind === "running"}
                    label={signal.label}
                  />
                  {signal.label}
                </Badge>
              )}
              <time dateTime={s.updatedAt}>{relativeTime(s.updatedAt)}</time>
            </span>
          }
          onClick={() =>
            void selectSession(s.id).catch((error: unknown) =>
              toast({
                tone: "err",
                title: error instanceof Error ? error.message : S.workspaceSwitchFailed,
              }),
            )
          }
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton icon="more" size="icon-xs" label={`${S.sessionActions}：${title}`} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setRenameId(s.id);
                    setRenameValue(s.title ?? "");
                    setRenameError(false);
                  }}
                >
                  <Icon name="pencil" size="xs" />
                  {S.renameSession}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setExportError(null);
                    void exportSession(s.id, s.title).catch(() => setExportError(s.id));
                  }}
                >
                  <Icon name="download" size="xs" />
                  {S.exportSession}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={async () => {
                    // 删除会话不可恢复（日志一并删除），必须二次确认
                    const ok = await confirm({
                      title: S.deleteSessionTitle,
                      description: S.deleteSessionConfirm(title),
                      confirmLabel: S.confirmLabels.delete,
                      tone: "destructive",
                    });
                    if (ok) void removeSession(s.id);
                  }}
                >
                  <Icon name="trash" size="xs" />
                  {S.deleteSession}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        >
          {title}
        </NavItem>
      </Tip>
    );
  };

  return (
    <>
      <div className="sidebar-brand flex h-16 shrink-0 items-center gap-2 px-5">
        <span className="flex min-w-0 flex-1 items-center gap-2.5 text-md font-semibold tracking-tight">
          <BrandMark className="size-7" />
          <span className="truncate">{S.appName}</span>
        </span>
        <IconButton
          icon="sidebar"
          label={S.collapseSidebar}
          shortcut="B"
          onClick={() => useApp.setState({ sidebarCollapsed: true })}
        />
      </div>
      <div className="sidebar-controls flex flex-col gap-3 px-3.5 pb-4">
        {activePane === "files" && <WorkspaceSwitcher />}
        <SegmentedControl
          value={activePane}
          onChange={setActivePane}
          ariaLabel={`${S.sessions} / ${S.files}`}
          className="grid w-full grid-cols-2"
          options={[
            {
              value: "sessions" as const,
              icon: "chat",
              label: (
                <span className="flex items-center gap-1.5">
                  {S.sessions}
                  <span className="text-2xs tabular-nums text-muted-foreground">
                    {allSessions.length}
                  </span>
                </span>
              ),
            },
            {
              value: "files" as const,
              icon: "folder",
              label: (
                <span className="flex items-center gap-1.5">
                  {S.files}
                  <span className="text-2xs tabular-nums text-muted-foreground">
                    {files.length}
                  </span>
                </span>
              ),
            },
          ]}
        />
        {activePane === "sessions" && (
          <>
            <Tip
              content={S.newSessionIn(
                workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
                  S.defaultWorkspaceTag,
              )}
              side="right"
            >
              <Button
                variant="ghost"
                className="sidebar-new-session h-10 w-full justify-start rounded-lg px-3.5"
                loading={creating}
                onClick={() => newChat()}
              >
                <Icon name="plus" size="sm" />
                {S.newSession}
              </Button>
            </Tip>
            <div className="relative">
              <SearchInput
                aria-label={S.searchSessions}
                placeholder={S.searchSessionsPlaceholder}
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && sessionQuery !== "") {
                    event.preventDefault();
                    setSessionQuery("");
                  }
                }}
                className="sidebar-search [&>input]:border-transparent [&>input]:bg-accent/45 [&>input]:pr-9 [&>input]:shadow-none [&>input]:focus-visible:bg-card"
              />
              {sessionQuery !== "" && (
                <IconButton
                  icon="x"
                  size="icon-xs"
                  label={S.clearSearch}
                  tooltip={S.clearSearch}
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                  onClick={() => setSessionQuery("")}
                />
              )}
            </div>
          </>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 px-3.5 pt-1 pb-4">
          {activePane === "sessions" ? (
            <div className="flex flex-col gap-0.5">
              <SideHeading label={S.workspaceGroups} count={groups.length}>
                <IconButton
                  icon="plus"
                  size="icon-xs"
                  label={S.addWorkspace}
                  onClick={() => setAddOpen(true)}
                />
              </SideHeading>
              {groups.length === 0 && (
                <EmptyState
                  size="inline"
                  title={sessionQuery.trim() === "" ? S.sessionsEmpty : S.sessionsNoMatch}
                />
              )}
              {groups.map(({ workspace, sessions: children, count }) => {
                const open = searching || !collapsedGroups[workspace.id];
                const expanded = searching || expandedGroups[workspace.id] === true;
                const shown = groupPreview(children, expanded, sessionId);
                const selected = workspace.id === workspaceId;
                return (
                  <Collapsible
                    key={workspace.id}
                    open={open}
                    onOpenChange={(next) => {
                      if (!searching)
                        setCollapsedGroups((current) => ({ ...current, [workspace.id]: !next }));
                    }}
                    className="mb-3 min-w-0"
                    role="group"
                    aria-label={S.workspaceGroupLabel(workspace.name)}
                    data-workspace-id={workspace.id}
                  >
                    <div className="group/workspace flex min-w-0 items-center gap-0.5">
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          className={cn(
                            "min-w-0 flex-1 justify-start gap-2 px-2",
                            selected ? "text-foreground" : "text-foreground-secondary",
                          )}
                          aria-label={workspace.name}
                        >
                          <Icon name="folder" size="sm" />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {workspace.name}
                          </span>
                          <span className="text-2xs font-normal text-muted-foreground tabular-nums">
                            {count}
                          </span>
                          <Icon
                            name="chevronRight"
                            size="xs"
                            className={cn(
                              "text-muted-foreground transition-transform",
                              open && "rotate-90",
                            )}
                          />
                        </Button>
                      </CollapsibleTrigger>
                      <IconButton
                        icon="plus"
                        size="icon-xs"
                        label={S.newSessionIn(workspace.name)}
                        disabled={creating}
                        className="opacity-0 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100"
                        onClick={() => newChat(workspace.id)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            icon="more"
                            size="icon-xs"
                            label={S.workspaceGroupLabel(workspace.name)}
                            className="opacity-0 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100"
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              void switchWorkspace(workspace.id).catch((error: unknown) =>
                                toast({
                                  tone: "err",
                                  title:
                                    error instanceof Error
                                      ? error.message
                                      : S.workspaceSwitchFailed,
                                }),
                              )
                            }
                          >
                            <Icon name="folder" size="sm" />
                            {S.openWorkspace}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => newChat(workspace.id)}
                            disabled={creating}
                          >
                            <Icon name="plus" size="sm" />
                            {S.newSession}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void switchWorkspace(workspace.id)
                                .then(() => setActivePane("files"))
                                .catch((error: unknown) =>
                                  toast({
                                    tone: "err",
                                    title:
                                      error instanceof Error
                                        ? error.message
                                        : S.workspaceSwitchFailed,
                                  }),
                                )
                            }
                          >
                            <Icon name="file" size="sm" />
                            {S.viewWorkspaceFiles}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setSettingsOpen(true, "files")}>
                            <Icon name="settings" size="sm" />
                            {S.manageWorkspaces}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <CollapsibleContent>
                      <div className="ml-3.5 flex min-w-0 flex-col gap-1 border-l border-border-strong/60 pb-1 pl-3">
                        {shown.map(renderSession)}
                        {children.length === 0 && (
                          <EmptyState size="inline" title={S.workspaceNoSessions} />
                        )}
                        {!searching &&
                          children.length > GROUP_PREVIEW_COUNT &&
                          (expanded || children.length > shown.length) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="justify-start px-2 font-normal text-muted-foreground"
                              onClick={() =>
                                setExpandedGroups((current) => ({
                                  ...current,
                                  [workspace.id]: !expanded,
                                }))
                              }
                            >
                              {expanded
                                ? S.showFewerSessions
                                : S.showMoreSessions(children.length - shown.length)}
                            </Button>
                          )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          ) : (
            <FileList />
          )}
          <TeamPanel />
        </div>
      </ScrollArea>
      {addOpen && <AddWorkspaceDialog open onOpenChange={setAddOpen} />}
      {exportError && (
        <p className="shrink-0 px-3 py-1 text-xs text-destructive" role="alert">
          {S.exportSessionFailed}
        </p>
      )}
      <Dialog
        open={renameId !== null}
        onOpenChange={(open) => {
          if (!open && !renameBusy) setRenameId(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{S.renameSessionTitle}</DialogTitle>
          <DialogDescription className="mt-1">{S.renameSessionDescription}</DialogDescription>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void commitRename();
            }}
          >
            <Input
              autoFocus
              value={renameValue}
              maxLength={80}
              placeholder={S.renameSessionPlaceholder}
              aria-invalid={renameError}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            {renameError && <p className="text-xs text-destructive">{S.renameFailed}</p>}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={renameBusy}
                onClick={() => setRenameId(null)}
              >
                {S.cancel}
              </Button>
              <Button type="submit" loading={renameBusy} disabled={renameValue.trim() === ""}>
                {S.save}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <div className="mx-3.5 mb-3 flex h-12 shrink-0 items-center gap-1 border-t border-border/80 pt-2">
        <Tip content={connected ? S.connectedState : S.reconnecting}>
          <span className="flex size-6 items-center justify-center" tabIndex={-1}>
            <StatusDot
              tone={connected ? "ok" : "warn"}
              label={connected ? S.connectedState : S.reconnecting}
            />
          </span>
        </Tip>
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 justify-start gap-2 px-2"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" size="sm" />
          <span className="flex-1 text-left">{S.settings}</span>
        </Button>
        {useApp((s) => s.shape) !== "desktop" && (
          <IconButton
            icon="shield"
            label={S.signOut}
            tooltip={S.signOutHint}
            onClick={() => void signOut()}
          />
        )}
        <IconButton
          icon={dark ? "sun" : "moon"}
          label={S.themeToggle}
          onClick={() =>
            setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
          }
        />
      </div>
    </>
  );
}
