// 设置 → 模型：档案增删改、默认、连接测试、能力探测与手动覆盖、拉取远端模型列表（09）。

import type { ModelProfile, ProviderPreset, ReasoningLevel } from "@excelmanus/protocol";
import { useId, useState } from "react";
import { reasoningOptions } from "../../reasoning.ts";
import { apiClientOf, refreshProfiles, useApp } from "../../store.ts";
import { S, ST } from "../../strings.ts";
import { Icon, type IconName, ProviderLabel, ProviderLogo } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Combobox } from "../ui/command.tsx";
import { Alert, Badge, Card, Separator } from "../ui/display.tsx";
import { HelpText } from "../ui/field.tsx";
import { useFormGuard } from "../ui/form-guard.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { Collapsible, CollapsibleContent, Disclosure } from "../ui/overlay.tsx";
import { ResourceBrowser } from "../ui/resource-browser.tsx";
import { NONE, SimpleSelect } from "../ui/select.tsx";
import { Tip } from "../ui/tooltip.tsx";
import {
  Feedback,
  Field,
  formatPairs,
  parsePairs,
  Section,
  useAction,
  useConfirmDelete,
  useLoad,
} from "./common.tsx";

type Caps = Record<
  string,
  { value: boolean | null; source: string | null; checkedAt?: string | null; detail?: string }
>;
const CAP_LABELS: [string, string][] = [
  ["connectivity", ST.capConnectivity],
  ["tools", ST.capTools],
  ["vision", ST.capVision],
  ["reasoning", ST.capReasoning],
];

/** ISO 8601 UTC → 本地时间（月-日 时:分）。 */
function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(S.locale, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}

/** 能力格（对齐清单 A11）：支持 / 不支持 / 未知 + 来源与时间；探测失败不等于已证实不支持。 */
function CapBadges({ caps }: { caps: Caps | undefined }) {
  return (
    <div className="settings-profile-caps grid grid-cols-2 gap-x-5 gap-y-3 @min-[580px]:grid-cols-4">
      {CAP_LABELS.map(([k, label]) => {
        const c = caps?.[k];
        const yes = c?.value === true;
        const no = c?.value === false;
        const icon: IconName = yes ? "circleCheck" : no ? "circleX" : "circleAlert";
        const text = yes ? ST.capYes : no ? ST.capNo : ST.capUnknown;
        return (
          <Tip key={k} content={c?.detail ?? ""}>
            <div
              tabIndex={c?.detail ? 0 : -1}
              className="flex min-w-0 flex-col gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5">
                <span className="text-foreground-secondary">{label}</span>
                <span className="flex items-center gap-1 font-medium">
                  <Icon
                    name={icon}
                    size="xs"
                    className={cn(
                      yes && "text-ok",
                      no && "text-destructive",
                      !yes && !no && "text-muted-foreground",
                    )}
                  />
                  {text}
                </span>
              </span>
              <span className="truncate text-2xs text-muted-foreground">
                {c?.source ? ST.capSource(c.source) : ""}
                {c?.checkedAt ? ` · ${localTime(c.checkedAt)}` : ""}
              </span>
            </div>
          </Tip>
        );
      })}
    </div>
  );
}

function ParamCell({
  label,
  children,
  tip,
}: {
  label: string;
  children: React.ReactNode;
  tip?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-2xs font-medium text-muted-foreground">{label}</dt>
      <Tip content={tip}>
        <dd className="truncate font-mono text-[13px] leading-5 text-foreground-secondary">
          {children}
        </dd>
      </Tip>
    </div>
  );
}

function ProfileRow({ p, onChanged }: { p: ModelProfile; onChanged(): void }) {
  const guard = useFormGuard();
  const api = apiClientOf();
  const provider = useApp(
    (state) =>
      state.providers.find((preset) => preset.id === p.provider)?.displayName ?? p.provider,
  );
  const [open, setOpen] = useState(true);
  const caps = useLoad(
    () => api.getCapabilities(p.id).then((r) => r.capabilities as Caps),
    [p.id, p.updatedAt],
  );
  const act = useAction();
  const confirmDelete = useConfirmDelete();
  return (
    <Card
      elevation="flat"
      className="settings-profile flex flex-col gap-4 rounded-xl border-border/80 p-5 shadow-none @max-[500px]:p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="settings-profile-icon flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground-secondary">
            <ProviderLogo provider={p.provider} size="xl" />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[15px] leading-5 font-semibold tracking-tight">
                {p.name}
              </strong>
              {p.isDefault && <Badge tone="read">{S.isDefault}</Badge>}
              {p.accountId && <Badge tone="neutral">{ST.subscriptionBadge}</Badge>}
            </div>
            <span className="truncate text-[13px] leading-5 text-muted-foreground">
              {provider}
              <span className="mx-1.5 opacity-50">/</span>
              <span className="font-mono">{p.model}</span>
            </span>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-[13px]"
          onClick={async () => {
            if (!open || (await guard.confirmLeave())) setOpen(!open);
          }}
          aria-expanded={open}
        >
          <Icon name={open ? "x" : "pencil"} size="xs" />
          {open ? ST.cancel : ST.edit}
        </Button>
      </div>
      {open && (
        <>
          <Separator />
          <ProfileEditor
            profile={p}
            caps={caps.data ?? undefined}
            onSaved={() => {
              setOpen(false);
              onChanged();
              caps.reload();
            }}
          />
        </>
      )}
      <CapBadges caps={caps.data ?? undefined} />
      {caps.error && (
        <Alert layout="inline" tone="err">
          {caps.error}
        </Alert>
      )}
      <dl className="settings-profile-meta -mx-5 grid grid-cols-1 gap-x-5 gap-y-3 border-y border-border/60 bg-muted/40 px-5 py-3.5 @min-[580px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,.85fr)] @max-[500px]:-mx-4 @max-[500px]:px-4">
        <ParamCell label={S.baseUrl} tip={p.baseUrl ?? ""}>
          {p.baseUrl ?? ST.providerDefault}
        </ParamCell>
        <ParamCell label={p.accountId ? ST.credential : S.apiKey}>
          {p.accountId ? ST.subscriptionCred : (p.apiKeyMasked ?? ST.notConfigured)}
        </ParamCell>
        <ParamCell label={ST.contextAndOutput}>
          {p.contextWindow ? p.contextWindow.toLocaleString() : "—"} /{" "}
          {p.maxOutputTokens ? p.maxOutputTokens.toLocaleString() : "—"}
        </ParamCell>
      </dl>
      {caps.data?.tools?.value === false && (
        <Alert layout="inline" tone="err">
          {ST.noToolsWarn}
        </Alert>
      )}
      <div className="settings-profile-actions flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="text-[13px]"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              const r = await api.testModelProfile(p.id).finally(() => caps.reload());
              if (!r.ok) throw new Error(`${S.testFailed}：${r.error?.message ?? ""}`);
            }, `${S.testOk}`)
          }
        >
          <Icon name="plug" size="xs" />
          {S.testConnection}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-[13px]"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              await api.probeProfile(p.id);
              caps.reload();
            }, ST.probeDone)
          }
        >
          <Icon name="search" size="xs" />
          {act.busy ? ST.probing : ST.probe}
        </Button>
        {!p.isDefault && (
          <Button
            size="sm"
            variant="ghost"
            className="text-[13px]"
            onClick={() =>
              void act.run(async () => {
                await api.setDefaultModelProfile(p.id);
                onChanged();
              })
            }
          >
            {S.setDefault}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="destructive-ghost"
          className="text-[13px]"
          onClick={async () => {
            if (await confirmDelete(ST.confirmTitle.deleteProfile(p.name)))
              void act.run(async () => {
                await api.deleteModelProfile(p.id);
                onChanged();
              });
          }}
        >
          <Icon name="trash" size="xs" />
          {ST.delete}
        </Button>
      </div>
      <Feedback msg={act.msg} />
    </Card>
  );
}

function ProfileEditor({
  profile,
  caps,
  onSaved,
}: {
  profile: ModelProfile;
  caps?: Caps;
  onSaved(): void;
}) {
  const api = apiClientOf();
  const [f, setF] = useState({
    name: profile.name,
    model: profile.model,
    baseUrl: profile.baseUrl ?? "",
    apiKey: "",
    contextWindow: profile.contextWindow ? String(profile.contextWindow) : "",
    maxOutputTokens: profile.maxOutputTokens ? String(profile.maxOutputTokens) : "",
    reasoning: profile.reasoning ?? "provider-default",
    headers: formatPairs(profile.extraHeaders, ":"),
    maxConcurrency: profile.maxConcurrency ? String(profile.maxConcurrency) : "",
  });
  const act = useAction();
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return (
    <form
      className="settings-form flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void act
          .run(async () => {
            await api.updateModelProfile(profile.id, {
              name: f.name,
              model: f.model,
              baseUrl: f.baseUrl === "" ? null : f.baseUrl,
              ...(f.apiKey !== "" ? { apiKey: f.apiKey } : {}),
              contextWindow: num(f.contextWindow),
              maxOutputTokens: num(f.maxOutputTokens),
              reasoning: f.reasoning as ReasoningLevel,
              extraHeaders: f.headers.trim() === "" ? null : parsePairs(f.headers, ":"),
              maxConcurrency: num(f.maxConcurrency),
            });
          })
          .then((ok) => ok && onSaved());
      }}
    >
      <div className="grid grid-cols-1 gap-4 @min-[500px]:grid-cols-2">
        <Field label={S.profileName}>
          <Input value={f.name} required onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={S.model}>
          <Input
            mono
            value={f.model}
            required
            onChange={(e) => setF({ ...f, model: e.target.value })}
          />
        </Field>
      </div>
      <Field label={S.baseUrl}>
        <Input mono value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
      </Field>
      <div className="grid grid-cols-1 gap-4 @min-[500px]:grid-cols-2">
        {!profile.accountId && (
          <Field
            label={S.apiKey}
            hint={
              profile.apiKeyMasked
                ? ST.apiKeyKeepCurrent(ST.apiKeyKeep, profile.apiKeyMasked)
                : undefined
            }
          >
            <Input
              type="password"
              value={f.apiKey}
              onChange={(e) => setF({ ...f, apiKey: e.target.value })}
            />
          </Field>
        )}
        <Field label={ST.reasoning}>
          <SimpleSelect
            value={f.reasoning}
            onChange={(v) => setF({ ...f, reasoning: v })}
            options={reasoningOptions}
            selectedLabel={f.reasoning === "minimal" ? ST.savedMinimalReasoning : undefined}
          />
        </Field>
      </div>
      <Disclosure variant="section" summary={ST.advanced} contentClassName="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 @min-[580px]:grid-cols-3">
          <Field label={ST.contextWindow}>
            <Input
              mono
              inputMode="numeric"
              value={f.contextWindow}
              onChange={(e) => setF({ ...f, contextWindow: e.target.value })}
            />
          </Field>
          <Field label={ST.maxOutput}>
            <Input
              mono
              inputMode="numeric"
              value={f.maxOutputTokens}
              onChange={(e) => setF({ ...f, maxOutputTokens: e.target.value })}
            />
          </Field>
          <Field label={ST.maxConcurrency}>
            <Input
              mono
              inputMode="numeric"
              value={f.maxConcurrency}
              onChange={(e) => setF({ ...f, maxConcurrency: e.target.value })}
            />
          </Field>
        </div>
        <Field label={ST.extraHeaders}>
          <Textarea
            mono
            rows={3}
            value={f.headers}
            onChange={(e) => setF({ ...f, headers: e.target.value })}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground-secondary">{ST.capOverride}</span>
          <div className="grid grid-cols-1 gap-4 @min-[580px]:grid-cols-3">
            {CAP_LABELS.filter(([k]) => k !== "connectivity").map(([k, label]) => (
              <Field key={k} label={label}>
                <SimpleSelect
                  value={caps?.[k]?.source === "manual" ? String(caps[k]?.value) : NONE}
                  onChange={(v) =>
                    void act.run(() =>
                      api.overrideCapabilities(profile.id, {
                        [k]: v === NONE ? null : v === "true",
                      }),
                    )
                  }
                  options={[
                    { value: NONE, label: ST.capAuto },
                    { value: "true", label: ST.capYes },
                    { value: "false", label: ST.capNo },
                  ]}
                />
              </Field>
            ))}
          </div>
        </div>
      </Disclosure>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={act.busy}>
          {ST.save}
        </Button>
        <Feedback msg={act.msg} />
      </div>
    </form>
  );
}

function NewProfile({ providers, onCreated }: { providers: ProviderPreset[]; onCreated(): void }) {
  const api = apiClientOf();
  const [f, setF] = useState({ name: "", provider: "", model: "", baseUrl: "", apiKey: "" });
  const [models, setModels] = useState<string[]>([]);
  const act = useAction();
  const preset = providers.find((p) => p.id === f.provider);
  const needsKey = preset?.auth !== "none" && preset?.auth !== "subscription";
  return (
    <form
      className="settings-form flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void act
          .run(async () => {
            await api.createModelProfile({
              name: f.name,
              provider: f.provider,
              model: f.model,
              ...(f.baseUrl !== "" ? { baseUrl: f.baseUrl } : {}),
              ...(f.apiKey !== "" ? { apiKey: f.apiKey } : {}),
            });
            setF({
              name: "",
              provider: f.provider,
              model: "",
              baseUrl: preset?.defaultBaseUrl ?? "",
              apiKey: "",
            });
          })
          .then((ok) => ok && onCreated());
      }}
    >
      <div className="grid grid-cols-1 gap-4 @min-[500px]:grid-cols-2">
        <Field label={S.provider} hint={preset?.note ?? undefined}>
          <SimpleSelect
            value={f.provider}
            required
            placeholder={ST.pickProvider}
            onChange={(v) => {
              const p = providers.find((x) => x.id === v);
              setModels(p?.suggestedModels ?? []);
              setF({
                ...f,
                provider: v,
                baseUrl: p?.defaultBaseUrl ?? "",
                model: p?.suggestedModels?.[0] ?? "",
              });
            }}
            options={providers
              .filter((p) => p.auth !== "subscription")
              .map((p) => ({
                value: p.id,
                label: (
                  <ProviderLabel provider={p.id}>
                    {`${p.displayName}${p.directChina ? ST.domesticSuffix : ""}`}
                  </ProviderLabel>
                ),
              }))}
          />
        </Field>
        <Field label={S.profileName}>
          <Input
            value={f.name}
            required
            placeholder={preset?.displayName ?? ""}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </Field>
      </div>
      <Field label={S.baseUrl}>
        <Input mono value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
      </Field>
      {needsKey && (
        <div className="flex flex-col gap-1">
          <Field label={S.apiKey}>
            <Input
              type="password"
              value={f.apiKey}
              required={preset !== undefined}
              onChange={(e) => setF({ ...f, apiKey: e.target.value })}
            />
          </Field>
          {preset?.apiKeyHelpUrl && (
            <HelpText>
              <a
                className="text-read-ink underline-offset-2 hover:underline"
                href={preset.apiKeyHelpUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {ST.apiKeyHelp}
              </a>
            </HelpText>
          )}
        </div>
      )}
      <Field label={S.model}>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Combobox
              id="new-profile-model"
              mono
              value={f.model}
              required
              options={models}
              startAdornment={preset && <ProviderLogo provider={preset.id} />}
              renderOption={(model) => <ProviderLabel provider={f.provider}>{model}</ProviderLabel>}
              ariaLabel={S.model}
              onChange={(v) => setF({ ...f, model: v })}
            />
          </div>
          <Button
            variant="outline"
            disabled={!preset || act.busy}
            onClick={() =>
              void act.run(async () => {
                const r = await api.listProviderModels(f.provider, {
                  apiKey: f.apiKey,
                  ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}),
                });
                setModels(r.items.map((m) => m.id));
              }, ST.modelsFetched)
            }
          >
            <Icon name="download" size="xs" />
            {ST.fetchModels}
          </Button>
        </div>
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!preset} loading={act.busy}>
          <Icon name="plus" size="xs" />
          {S.addProfile}
        </Button>
        <Feedback msg={act.msg} />
      </div>
    </form>
  );
}

export function ModelsTab() {
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);
  const api = apiClientOf();
  const catalog = useLoad(() => api.getModelCatalog("__none__"), []);
  const act = useAction();
  const changed = () => void refreshProfiles();
  const [createOpen, setCreateOpen] = useState(profiles.length === 0);
  const createFormId = useId();
  return (
    <Section
      title={S.modelProfiles}
      hint={ST.subscriptionProfileHint}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            className="text-[13px]"
            loading={act.busy}
            onClick={() =>
              void act.run(async () => {
                await api.refreshModelCatalog();
                catalog.reload();
              })
            }
          >
            <Icon name="restore" size="xs" />
            {ST.refreshCatalog}
          </Button>
          <Button
            size="sm"
            className="text-[13px]"
            aria-expanded={createOpen}
            aria-controls={createFormId}
            onClick={() => setCreateOpen(!createOpen)}
          >
            <Icon name={createOpen ? "x" : "plus"} size="xs" />
            {createOpen ? ST.cancel : S.addProfile}
          </Button>
        </>
      }
    >
      {catalog.data && (
        <p className="settings-catalog-note -mt-3 text-2xs leading-5 text-muted-foreground">
          {ST.catalogUpdated(catalog.data.updatedAt, catalog.data.source)}
        </p>
      )}
      {catalog.error && (
        <Alert layout="inline" tone="err">
          {catalog.error}
        </Alert>
      )}
      <Feedback msg={act.msg} />
      <Collapsible open={createOpen} onOpenChange={setCreateOpen} className="empty:hidden">
        <CollapsibleContent id={createFormId}>
          <div className="settings-create-form rounded-xl border border-border/80 bg-muted/20 p-5">
            <NewProfile providers={providers} onCreated={changed} />
          </div>
        </CollapsibleContent>
      </Collapsible>
      <ResourceBrowser
        items={profiles}
        id={(p) => p.id}
        title={(p) => p.name}
        subtitle={(p) => `${p.provider} · ${p.model}`}
        icon={(p) => <ProviderLogo provider={p.provider} size="lg" />}
        label={S.modelProfiles}
        emptyText={ST.empty}
        detail={(p) => <ProfileRow p={p} onChanged={changed} />}
      />
    </Section>
  );
}
