// 设置 → 技能（12 §1）：列表、启用/禁用、查看正文、导入（先预览再确认）、删除用户技能。

import type { SkillDetail } from "@excelmanus/protocol";
import { useId, useState } from "react";
import { apiClientOf } from "../../store.ts";
import { ST } from "../../strings.ts";
import { Icon } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Switch } from "../ui/controls.tsx";
import { Alert, Badge } from "../ui/display.tsx";
import { Label } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Disclosure } from "../ui/overlay.tsx";
import {
  Empty,
  Feedback,
  ItemCard,
  Loading,
  LoadStatus,
  Section,
  useAction,
  useConfirmDelete,
  useLoad,
} from "./common.tsx";

const preCls =
  "max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-foreground-secondary";

function SkillBody({ name }: { name: string }) {
  const api = apiClientOf();
  const d = useLoad(() => api.getSkill(name), [name]);
  if (!d.data)
    return d.error ? (
      <Alert tone="err" layout="inline">
        {d.error}
      </Alert>
    ) : (
      <Loading />
    );
  return (
    <div className="flex flex-col gap-2">
      <pre className={preCls}>{d.data.skill.body}</pre>
      {d.data.skill.resources.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {ST.resourcesLabel}
          {d.data.skill.resources.join("、")}
        </p>
      )}
    </div>
  );
}

function SkillToggle({ enabled, onChange }: { enabled: boolean; onChange(v: boolean): void }) {
  const id = useId();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Switch id={id} size="sm" checked={enabled} onCheckedChange={onChange} />
      <Label htmlFor={id}>{enabled ? ST.enabled : ST.disabled}</Label>
    </span>
  );
}

export function SkillsTab() {
  const api = apiClientOf();
  const list = useLoad(() => api.listSkills(), []);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<SkillDetail[] | null>(null);
  const act = useAction();
  const confirmDelete = useConfirmDelete();
  return (
    <>
      <Section className="settings-library">
        <LoadStatus data={list.data} error={list.error} />
        <Feedback msg={act.msg} />
        <div className="settings-list flex flex-col gap-3">
          {list.data?.items.length === 0 && <Empty />}
          {list.data?.items.map((s) => (
            <ItemCard key={s.name}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Icon name="book" size="sm" className="text-muted-foreground" />
                  <strong
                    className={cn(
                      "font-mono text-sm font-semibold",
                      !(s.enabled && s.available) && "text-muted-foreground",
                    )}
                  >
                    {s.name}
                  </strong>
                  <Badge tone="neutral">{ST.skillSource[s.source] ?? s.source}</Badge>
                  {s.version && (
                    <span className="font-mono text-2xs text-muted-foreground">v{s.version}</span>
                  )}
                </div>
                <SkillToggle
                  enabled={s.enabled}
                  onChange={(v) =>
                    void act.run(async () => {
                      await api.setSkillEnabled(s.name, v);
                      list.reload();
                    })
                  }
                />
              </div>
              <p className="max-w-[600px] text-sm leading-6 text-foreground-secondary">
                {s.description}
              </p>
              {!s.available && (
                <Alert tone="err" layout="inline">
                  {ST.skillUnavailable(s.missingTools)}
                </Alert>
              )}
              {s.overrides.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {ST.skillOverrides(s.overrides.map((o) => ST.skillSource[o] ?? o))}
                </p>
              )}
              {s.userInvocable && (
                <p className="text-xs text-muted-foreground">{ST.skillUserInvocable(s.name)}</p>
              )}
              <div className="flex items-start justify-between gap-2">
                <Disclosure className="flex-1" summary={ST.skillView}>
                  <SkillBody name={s.name} />
                </Disclosure>
                {s.source === "user" && (
                  <Button
                    size="xs"
                    variant="destructive-ghost"
                    onClick={async () => {
                      if (await confirmDelete(ST.confirmTitle.deleteSkill(s.name)))
                        void act.run(async () => {
                          await api.deleteSkill(s.name);
                          list.reload();
                        });
                    }}
                  >
                    {ST.delete}
                  </Button>
                )}
              </div>
            </ItemCard>
          ))}
        </div>
      </Section>
      <Section title={ST.skillImport} hint={ST.skillImportHint}>
        <div className="settings-form flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              mono
              className="min-w-[200px] flex-1"
              aria-label={ST.skillImport}
              value={source}
              placeholder="https://github.com/owner/repo"
              onChange={(e) => {
                setSource(e.target.value);
                setPreview(null);
              }}
            />
            <Button
              variant="outline"
              disabled={act.busy || source.trim() === ""}
              onClick={() =>
                void act.run(async () => {
                  const r = await api.importSkill(source.trim(), true);
                  setPreview(r.skills);
                }, ST.skillPreviewDone)
              }
            >
              <Icon name="eye" size="xs" />
              {ST.skillPreview}
            </Button>
          </div>
          {preview?.map((s) => (
            <Disclosure
              key={s.name}
              defaultOpen={preview.length === 1}
              summary={
                <>
                  <strong className="font-mono font-semibold text-foreground">{s.name}</strong> ·{" "}
                  {s.description}
                </>
              }
            >
              <pre className={preCls}>{s.body}</pre>
            </Disclosure>
          ))}
          {preview && preview.length > 0 && (
            <div>
              <Button
                loading={act.busy}
                onClick={() =>
                  void act.run(async () => {
                    await api.importSkill(source.trim(), false);
                    setPreview(null);
                    setSource("");
                    list.reload();
                  }, ST.importedEnabled)
                }
              >
                {ST.skillConfirmImport}
              </Button>
            </div>
          )}
        </div>
      </Section>
    </>
  );
}
