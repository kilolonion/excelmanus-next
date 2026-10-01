// 设置 → 权限与运行：默认权限模式（三卡，04 §5）、按用途分配模型、压缩、子代理并发、记忆注入、网络代理。

import type { AppSettings } from "@excelmanus/protocol";
import { useEffect, useState } from "react";
import { apiClientOf, useApp } from "../../store.ts";
import { ST } from "../../strings.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox, RadioCard, RadioGroup } from "../ui/controls.tsx";
import { Alert, Badge, Card, SectionLabel } from "../ui/display.tsx";
import { Field as UiField } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { NONE, SimpleSelect } from "../ui/select.tsx";
import { Feedback, Field, Loading, Section, useAction, useLoad } from "./common.tsx";

type Mode = AppSettings["defaultPermissionMode"];
const MODE_ICON = { confirm: "shield", standard: "shieldCheck", auto: "zap" } as const;

export function GeneralTab() {
  const api = apiClientOf();
  const profiles = useApp((s) => s.profiles);
  const loaded = useLoad(() => api.getSettings(), []);
  const [f, setF] = useState<AppSettings | null>(null);
  const [restart, setRestart] = useState<string[]>([]);
  const act = useAction();
  useEffect(() => {
    if (loaded.data) setF(loaded.data.settings);
  }, [loaded.data]);
  if (!f)
    return loaded.error ? (
      <Alert tone="err" layout="inline">
        {loaded.error}
      </Alert>
    ) : (
      <Loading />
    );
  const saved = loaded.data?.settings;
  const mainProfile = profiles.find((p) => p.isDefault);
  const profileSelect = (key: "subAgentProfileId" | "compactionProfileId", label: string) => (
    <SimpleSelect
      ariaLabel={label}
      value={f[key] ?? NONE}
      onChange={(v) => setF({ ...f, [key]: v === NONE ? null : v })}
      options={[
        { value: NONE, label: ST.sameAsMain },
        ...profiles.map((p) => ({ value: p.id, label: p.name })),
      ]}
    />
  );
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => {
          const r = await api.updateSettings({
            ...f,
            httpProxy: f.httpProxy?.trim() ? f.httpProxy.trim() : null,
            noProxy: f.noProxy?.trim() ? f.noProxy.trim() : null,
          });
          setF(r.settings);
          setRestart(r.restartRequired);
          loaded.reload();
        });
      }}
    >
      <Section title={ST.permTitle} hint={ST.permHint}>
        <RadioGroup
          aria-label={ST.permTitle}
          value={f.defaultPermissionMode}
          onValueChange={(v) => setF({ ...f, defaultPermissionMode: v as Mode })}
          className="grid-cols-1 min-[1100px]:grid-cols-3"
        >
          {ST.permCards.map((c) => (
            <RadioCard key={c.value} value={c.value} icon={MODE_ICON[c.value as Mode]}>
              <span className="flex flex-wrap items-center gap-1.5">
                <strong className="text-sm font-semibold">{c.title}</strong>
                {saved?.defaultPermissionMode === c.value && (
                  <Badge tone="ok">{ST.permCurrent}</Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{c.body}</span>
            </RadioCard>
          ))}
        </RadioGroup>
      </Section>
      <Section title={ST.roleTitle} hint={ST.roleHint}>
        <div className="grid grid-cols-1 gap-3 min-[1100px]:grid-cols-3">
          <Card className="flex min-w-0 flex-col gap-2 p-3.5">
            <SectionLabel>{ST.roleMain}</SectionLabel>
            <strong className="truncate text-sm font-semibold">
              {mainProfile?.name ?? ST.empty}
            </strong>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {mainProfile ? `${mainProfile.provider} / ${mainProfile.model}` : ""}
            </span>
            <span className="text-xs text-muted-foreground">{ST.roleMainBody}</span>
          </Card>
          <Card className="flex min-w-0 flex-col gap-2 p-3.5">
            <SectionLabel>{ST.roleSub}</SectionLabel>
            {profileSelect("subAgentProfileId", ST.roleSub)}
            <span className="text-xs text-muted-foreground">{ST.roleSubBody}</span>
          </Card>
          <Card className="flex min-w-0 flex-col gap-2 p-3.5">
            <SectionLabel>{ST.roleCompact}</SectionLabel>
            {profileSelect("compactionProfileId", ST.roleCompact)}
            <span className="text-xs text-muted-foreground">{ST.roleCompactBody}</span>
          </Card>
        </div>
      </Section>
      <Section title={ST.runtimeTitle}>
        <UiField orientation="horizontal" label={ST.autoCompact}>
          <Checkbox
            checked={f.autoCompact}
            onCheckedChange={(v) => setF({ ...f, autoCompact: v === true })}
          />
        </UiField>
        <UiField orientation="horizontal" label={ST.memoryInjection}>
          <Checkbox
            checked={f.memoryInjection}
            onCheckedChange={(v) => setF({ ...f, memoryInjection: v === true })}
          />
        </UiField>
        <Field label={ST.maxSubAgents} hint={ST.maxSubAgentsRange} className="max-w-48">
          <Input
            type="number"
            min={1}
            max={16}
            value={f.maxConcurrentSubAgents}
            onChange={(e) => setF({ ...f, maxConcurrentSubAgents: Number(e.target.value) || 1 })}
          />
        </Field>
      </Section>
      <Section title={ST.networkTitle}>
        <Field label={ST.httpProxy} hint={ST.httpProxyHint}>
          <Input
            mono
            value={f.httpProxy ?? ""}
            placeholder="http://127.0.0.1:7890"
            onChange={(e) => setF({ ...f, httpProxy: e.target.value })}
          />
        </Field>
        <Field label={ST.noProxy}>
          <Input
            mono
            value={f.noProxy ?? ""}
            onChange={(e) => setF({ ...f, noProxy: e.target.value })}
          />
        </Field>
      </Section>
      {restart.length > 0 && <Alert tone="warn">{ST.restartRequired(restart)}</Alert>}
      <div className="sticky bottom-0 -mx-8 -mb-6 flex items-center gap-3 border-t border-border bg-card/95 px-8 py-3 backdrop-blur">
        <Button type="submit" loading={act.busy}>
          {ST.save}
        </Button>
        <Feedback msg={act.msg} />
      </div>
    </form>
  );
}
