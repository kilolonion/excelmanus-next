// 设置 → 工作区与备份：登记/移除工作区；修改前备份与回收站的列表、下载、替换回原文件（11 §4）。

import { useState } from "react";
import { apiClientOf, refreshWorkspaces, useApp } from "../../store.ts";
import { ST } from "../../strings.ts";
import { Icon } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import { RadioCard, RadioGroup } from "../ui/controls.tsx";
import { Badge, Card } from "../ui/display.tsx";
import { Input } from "../ui/input.tsx";
import { Tip } from "../ui/tooltip.tsx";
import {
  Empty,
  Feedback,
  ItemCard,
  Section,
  useAction,
  useConfirmDelete,
  useLoad,
} from "./common.tsx";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function BackupList({ workspaceId, kind }: { workspaceId: string; kind: "backups" | "trash" }) {
  const api = apiClientOf();
  const list = useLoad(() => api.listBackups(workspaceId, kind), [workspaceId, kind]);
  const act = useAction();
  const confirm = useConfirm();
  const confirmDelete = useConfirmDelete();
  return (
    <Section title={kind === "backups" ? ST.backups : ST.trash}>
      <Feedback msg={act.msg} />
      <div className="flex flex-col gap-2">
        {list.data?.items.length === 0 && <Empty />}
        {list.data?.items.map((b) => (
          <ItemCard key={b.id} className="flex-row items-center gap-3 py-2.5">
            <Icon
              name={kind === "backups" ? "history" : "trash"}
              size="sm"
              className="text-muted-foreground"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Tip content={b.originalPath}>
                <span className="truncate font-mono text-sm">{b.originalPath}</span>
              </Tip>
              <span className="text-2xs text-muted-foreground">
                {formatSize(b.size)} · {new Date(b.createdAt).toLocaleString()}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  if (
                    kind === "backups" &&
                    !(await confirm({
                      title: ST.confirmTitle.restoreBackup,
                      description: ST.restoreConfirm,
                      confirmLabel: ST.restore,
                      tone: "destructive",
                    }))
                  )
                    return;
                  void act.run(async () => {
                    await api.restoreBackup(workspaceId, kind, b.id);
                    list.reload();
                  }, ST.restored(b.originalPath));
                }}
              >
                <Icon name="restore" size="xs" />
                {kind === "backups" ? ST.restore : ST.restoreTrash}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void act.run(async () => {
                    const blob = await api.downloadBackup(workspaceId, kind, b.id);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = b.originalPath.split("/").pop() ?? "backup";
                    a.click();
                    URL.revokeObjectURL(url);
                  }, ST.download)
                }
              >
                <Icon name="download" size="xs" />
                {ST.download}
              </Button>
              <Button
                size="xs"
                variant="destructive-ghost"
                onClick={async () => {
                  const title =
                    kind === "backups" ? ST.confirmTitle.deleteBackup : ST.confirmTitle.deleteTrash;
                  if (await confirmDelete(title))
                    void act.run(async () => {
                      await api.deleteBackup(workspaceId, kind, b.id);
                      list.reload();
                    });
                }}
              >
                {ST.delete}
              </Button>
            </div>
          </ItemCard>
        ))}
      </div>
    </Section>
  );
}

export function FilesTab() {
  const api = apiClientOf();
  const dataDir = useApp((s) => s.dataDir);
  const current = useApp((s) => s.workspaceId);
  const list = useLoad(() => api.listWorkspaces(), []);
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState(current);
  const act = useAction();
  const confirmDelete = useConfirmDelete();
  return (
    <>
      <Section title={ST.workspaces}>
        <RadioGroup aria-label={ST.workspaces} value={selected} onValueChange={setSelected}>
          {list.data?.items.map((w) => (
            <div key={w.id} className="relative">
              <RadioCard value={w.id} icon="folder" className="pr-24">
                <span className="flex items-center gap-1.5">
                  <strong className="text-sm font-semibold">{w.name}</strong>
                  {w.isDefault && <Badge tone="neutral">{ST.defaultTag}</Badge>}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">{w.path}</span>
              </RadioCard>
              {!w.isDefault && (
                <Button
                  size="xs"
                  variant="destructive-ghost"
                  className="absolute top-3 right-9"
                  onClick={async () => {
                    const ok = await confirmDelete(ST.confirmTitle.removeWorkspace(w.name), {
                      description: ST.confirmTitle.removeWorkspaceBody,
                      confirmLabel: ST.removeWorkspace,
                    });
                    if (ok)
                      void act.run(async () => {
                        await api.removeWorkspace(w.id);
                        list.reload();
                        await refreshWorkspaces();
                      });
                  }}
                >
                  {ST.removeWorkspace}
                </Button>
              )}
            </div>
          ))}
        </RadioGroup>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act
              .run(async () => {
                await api.addWorkspace(path.trim());
                list.reload();
                await refreshWorkspaces();
              })
              .then((ok) => ok && setPath(""));
          }}
        >
          <Input
            mono
            value={path}
            required
            aria-label={ST.workspacePath}
            placeholder={ST.workspacePath}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button type="submit" variant="outline" loading={act.busy}>
            <Icon name="plus" size="xs" />
            {ST.addWorkspace}
          </Button>
        </form>
        <Feedback msg={act.msg} />
      </Section>
      <Section title={ST.dataDirTitle} hint={ST.backupLocationNote}>
        <Card className="flex items-center gap-2.5 px-3.5 py-3">
          <Icon name="folder" size="md" className="text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-xs">{dataDir ?? ST.dataDirUnknown}</span>
        </Card>
      </Section>
      {selected && <BackupList workspaceId={selected} kind="backups" />}
      {selected && <BackupList workspaceId={selected} kind="trash" />}
    </>
  );
}
