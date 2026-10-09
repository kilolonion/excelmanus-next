// 设置 → 权限与运行：默认权限模式（三卡，04 §5）、按用途分配模型、压缩、子代理并发、记忆注入、网络代理。

import type { AppSettings } from "@excelmanus/protocol";
import { useEffect, useState } from "react";
import { apiClientOf, useApp } from "../../store.ts";
import { S, ST } from "../../strings.ts";
import { ProviderLabel } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { RadioCard, RadioGroup, Switch } from "../ui/controls.tsx";
import { Alert, Badge } from "../ui/display.tsx";
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
        ...profiles.map((p) => ({
          value: p.id,
          label: <ProviderLabel provider={p.provider}>{p.name}</ProviderLabel>,
        })),
      ]}
    />
  );
  return (
    <form
      className="settings-form flex flex-col gap-9"
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
          className="settings-permissions grid-cols-1 gap-3 @min-[700px]:grid-cols-3"
        >
          {ST.permCards.map((c) => (
            <RadioCard key={c.value} value={c.value} icon={MODE_ICON[c.value as Mode]}>
              <span className="flex flex-wrap items-center gap-1.5">
                <strong className="text-sm font-semibold">{c.title}</strong>
                {saved?.defaultPermissionMode === c.value && (
                  <Badge tone="ok">{ST.permCurrent}</Badge>
                )}
              </span>
              <span className="text-xs leading-5 text-muted-foreground">{c.body}</span>
            </RadioCard>
          ))}
        </RadioGroup>
      </Section>
      <Section title={ST.roleTitle} hint={ST.roleHint}>
        <div className="settings-rows divide-y divide-border/65">
          <div className="settings-row grid grid-cols-1 gap-3 py-4 first:pt-0 @min-[580px]:grid-cols-[minmax(0,1fr)_minmax(200px,.9fr)] @min-[580px]:gap-8">
            <div className="flex min-w-0 flex-col gap-1.5">
              <strong className="text-sm font-medium">{ST.roleMain}</strong>
              <span className="text-xs leading-5 text-muted-foreground">{ST.roleMainBody}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 @min-[580px]:items-end">
              <strong className="max-w-full truncate text-sm font-medium">
                {mainProfile ? (
                  <ProviderLabel provider={mainProfile.provider}>{mainProfile.name}</ProviderLabel>
                ) : (
                  ST.empty
                )}
              </strong>
              <span className="max-w-full truncate font-mono text-2xs text-muted-foreground">
                {mainProfile ? `${mainProfile.provider} / ${mainProfile.model}` : ""}
              </span>
            </div>
          </div>
          <div className="settings-row grid grid-cols-1 items-center gap-3 py-4 @min-[580px]:grid-cols-[minmax(0,1fr)_minmax(200px,.9fr)] @min-[580px]:gap-8">
            <div className="flex min-w-0 flex-col gap-1.5">
              <strong className="text-sm font-medium">{ST.roleSub}</strong>
              <span className="text-xs leading-5 text-muted-foreground">{ST.roleSubBody}</span>
            </div>
            {profileSelect("subAgentProfileId", ST.roleSub)}
          </div>
          <div className="settings-row grid grid-cols-1 items-center gap-3 py-4 pb-0 @min-[580px]:grid-cols-[minmax(0,1fr)_minmax(200px,.9fr)] @min-[580px]:gap-8">
            <div className="flex min-w-0 flex-col gap-1.5">
              <strong className="text-sm font-medium">{ST.roleCompact}</strong>
              <span className="text-xs leading-5 text-muted-foreground">{ST.roleCompactBody}</span>
            </div>
            {profileSelect("compactionProfileId", ST.roleCompact)}
          </div>
        </div>
      </Section>
      <Section title={S.dispatchDefaultTitle} hint={S.dispatchDefaultHint}>
        <SimpleSelect
          ariaLabel={S.dispatchDefaultTitle}
          value={f.defaultDispatchMode}
          onChange={(v) =>
            setF({ ...f, defaultDispatchMode: v as AppSettings["defaultDispatchMode"] })
          }
          options={[
            { value: "steer", label: S.modeSteer },
            { value: "queue", label: S.modeQueue },
            { value: "interrupt", label: S.modeInterrupt },
          ]}
        />
      </Section>
      <Section title={ST.runtimeTitle}>
        <div className="settings-rows divide-y divide-border/65">
          <UiField
            orientation="horizontal"
            label={ST.autoCompact}
            className="flex-row-reverse items-center justify-between pb-4"
          >
            <Switch
              checked={f.autoCompact}
              onCheckedChange={(v) => setF({ ...f, autoCompact: v })}
            />
          </UiField>
          <UiField
            orientation="horizontal"
            label={ST.memoryInjection}
            className="flex-row-reverse items-center justify-between pt-4"
          >
            <Switch
              checked={f.memoryInjection}
              onCheckedChange={(v) => setF({ ...f, memoryInjection: v })}
            />
          </UiField>
        </div>
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
      <div className="settings-savebar sticky bottom-0 z-10 -mx-10 -mb-8 flex flex-wrap items-center gap-3 border-t border-border/80 bg-card/95 px-10 py-4 backdrop-blur @max-[600px]:-mx-6 @max-[600px]:-mb-6 @max-[600px]:px-6">
        <Button type="submit" loading={act.busy}>
          {ST.save}
        </Button>
        <Feedback msg={act.msg} />
      </div>
    </form>
  );
}
