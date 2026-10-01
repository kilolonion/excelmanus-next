// 侧栏（02 §2.1）：品牌 + 会话 + 文件 + 代理团队（有子代理时）+ 设置入口。

import { useRef, useState } from "react";
import {
  createSession,
  noteManualView,
  openWorkspaceFile,
  removeSession,
  selectSession,
  setSettingsOpen,
  switchWorkspace,
  uploadWorkspaceFile,
  useApp,
} from "../store.ts";
import { S } from "../strings.ts";
import { setTheme } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { TeamPanel } from "./TeamPanel.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import { useConfirm } from "./ui/confirm.tsx";
import { Badge, EmptyState, NavItem, SectionLabel, StatusDot } from "./ui/display.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Shortcut } from "./ui/kbd.tsx";
import { ScrollArea } from "./ui/overlay.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Tip } from "./ui/tooltip.tsx";

const OPENABLE = /\.(xlsx|xlsm|csv|tsv)$/i;

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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
      {err && (
        <p className="px-2 text-xs text-destructive" role="alert">
          {err}
        </p>
      )}
      {files.length === 0 && <EmptyState size="inline" title={S.noFiles} />}
      {files.map((f) => {
        const openable = f.kind !== "dir" && OPENABLE.test(f.name);
        const active = doc?.path === f.path;
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
              meta={busy === f.path ? <Spinner size="xs" /> : undefined}
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

/** 工作区切换器（02 §6）；只有一个工作区时显示名称不显示下拉。 */
function WorkspaceSwitcher() {
  const workspaces = useApp((s) => s.workspaces);
  const workspaceId = useApp((s) => s.workspaceId);
  const [err, setErr] = useState(false);
  const current = workspaces.find((w) => w.id === workspaceId);
  if (!current) return null;
  if (workspaces.length < 2) {
    return (
      <Tip content={current.path} side="right">
        <div className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground-secondary">
          <Icon name="folder" size="sm" />
          <span className="min-w-0 truncate">{current.name}</span>
        </div>
      </Tip>
    );
  }
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
              setErr(false);
              void switchWorkspace(v).catch(() => setErr(true));
            }}
          >
            {workspaces.map((w) => (
              <DropdownMenuRadioItem key={w.id} value={w.id} description={w.path}>
                {w.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {err && (
        <p className="px-2 text-xs text-destructive" role="alert">
          {S.workspaceSwitchFailed}
        </p>
      )}
    </div>
  );
}

export function SessionList() {
  const allSessions = useApp((s) => s.sessions);
  const workspaceId = useApp((s) => s.workspaceId);
  const sessionId = useApp((s) => s.sessionId);
  const connected = useApp((s) => s.connected);
  const confirm = useConfirm();
  // 侧栏只列当前工作区的会话（切换工作区见上方切换器）
  const sessions = allSessions.filter((x) => workspaceId === "" || x.workspaceId === workspaceId);
  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-md font-semibold">
          <span
            className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Icon name="sheet" size="sm" />
          </span>
          <span className="truncate">{S.appName}</span>
        </span>
        <IconButton
          icon="sidebar"
          label={S.collapseSidebar}
          shortcut="B"
          onClick={() => useApp.setState({ sidebarCollapsed: true })}
        />
      </div>
      <div className="flex flex-col gap-1 px-2 pb-2">
        <WorkspaceSwitcher />
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => void createSession()}
        >
          <Icon name="plus" size="sm" />
          {S.newSession}
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 px-2 pt-1 pb-4">
          <div className="flex flex-col gap-0.5">
            <SideHeading label={S.sessions} count={sessions.length} />
            {sessions.length === 0 && <EmptyState size="inline" title={S.sessionsEmpty} />}
            {sessions.map((s) => {
              const active = s.id === sessionId;
              const title = s.title ?? S.untitledSession;
              return (
                <NavItem
                  key={s.id}
                  current={active}
                  icon={<Icon name="chat" size="sm" className="text-muted-foreground" />}
                  meta={<time dateTime={s.updatedAt}>{relativeTime(s.updatedAt)}</time>}
                  onClick={() => void selectSession(s.id)}
                  actions={
                    <IconButton
                      icon="trash"
                      size="icon-xs"
                      variant="destructive-ghost"
                      label={`${S.deleteSession}：${title}`}
                      tooltip={S.deleteSession}
                      onClick={async () => {
                        // 删除会话不可恢复（日志一并删除），必须二次确认
                        const ok = await confirm({
                          title: S.deleteSessionTitle,
                          description: S.deleteSessionConfirm(title),
                          confirmLabel: S.confirmLabels.delete,
                          tone: "destructive",
                        });
                        if (ok) void removeSession(s.id);
                      }}
                    />
                  }
                >
                  {title}
                </NavItem>
              );
            })}
          </div>
          <FileList />
          <TeamPanel />
        </div>
      </ScrollArea>
      <div className="flex h-11 shrink-0 items-center gap-1 border-t border-border px-2">
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
          <Shortcut keys="," />
        </Button>
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
