// 模型档案编辑：提供商、模型 ID、接口地址、凭据与高级参数；编辑已有档案时附能力探测。

import type {
  Capabilities,
  CreateModelProfileBody,
  JsonObject,
  ModelProfile,
  OverrideCapabilitiesBody,
  ProviderPreset,
  ReasoningLevel,
  RemoteModel,
  UpdateModelProfileBody,
} from "@excelmanus/protocol";
import {
  Brain,
  ChevronRight,
  ExternalLink,
  ImageIcon,
  Loader2,
  RefreshCw,
  Save,
  ScanSearch,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MiniCheckbox } from "@/components/ui/MiniCheckbox";
import { toast } from "@/components/ui/toaster";
import { api, desktop, errorMessage } from "@/lib/backend/api";
import { getProviderColor, presetBrand } from "@/lib/provider-brand";
import { refreshProfiles, useAppStore } from "@/stores/app-store";
import { CapabilityToggleRow } from "./capability-widgets";
import { FIELD_CLASS, Field, GlassSelect } from "./form-widgets";
import { REASONING_LABELS, uniqueProfileName } from "./helpers";
import { ModelIdCombobox } from "./ModelIdCombobox";
import { ProviderLogo } from "./ProviderLogo";

interface Draft {
  provider: string;
  name: string;
  nameTouched: boolean;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: string;
  maxOutputTokens: string;
  reasoning: string;
  maxConcurrency: string;
  extraHeaders: string;
  providerOptions: string;
  isDefault: boolean;
}

function draftFromProfile(profile: ModelProfile): Draft {
  return {
    provider: profile.provider,
    name: profile.name,
    nameTouched: true,
    model: profile.model,
    baseUrl: profile.baseUrl ?? "",
    apiKey: "",
    contextWindow: profile.contextWindow ? String(profile.contextWindow) : "",
    maxOutputTokens: profile.maxOutputTokens ? String(profile.maxOutputTokens) : "",
    reasoning: profile.reasoning ?? "",
    maxConcurrency: profile.maxConcurrency ? String(profile.maxConcurrency) : "",
    extraHeaders: profile.extraHeaders
      ? Object.entries(profile.extraHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
    providerOptions:
      profile.providerOptions && Object.keys(profile.providerOptions).length
        ? JSON.stringify(profile.providerOptions, null, 2)
        : "",
    isDefault: profile.isDefault,
  };
}

function emptyDraft(provider: string): Draft {
  return {
    provider,
    name: "",
    nameTouched: false,
    model: "",
    baseUrl: "",
    apiKey: "",
    contextWindow: "",
    maxOutputTokens: "",
    reasoning: "",
    maxConcurrency: "",
    extraHeaders: "",
    providerOptions: "",
    isDefault: false,
  };
}

function positiveInt(value: string, label: string, max?: number): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || (max !== undefined && n > max)) {
    throw new Error(`${label}应为${max ? ` 1–${max} 的` : ""}正整数`);
  }
  return n;
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const sep = row.indexOf(":");
    if (sep <= 0) throw new Error("请求头格式应为 Name: Value，每行一个");
    out[row.slice(0, sep).trim()] = row.slice(sep + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function parseOptions(text: string): JsonObject | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as JsonObject;
  } catch {
    throw new Error("提供商参数应为 JSON 对象");
  }
}

function openLink(url: string) {
  const bridge = desktop();
  if (bridge) bridge.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

const REASONING_OPTIONS = [
  { value: "", label: "不指定" },
  ...Object.entries(REASONING_LABELS).map(([value, label]) => ({ value, label })),
];

function CapabilityPanel({ profile }: { profile: ModelProfile }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api()
      .getCapabilities(profile.id)
      .then((res) => !cancelled && setCaps(res.capabilities))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  async function probe() {
    setProbing(true);
    try {
      const res = await api().probeProfile(profile.id);
      setCaps(res.capabilities);
      void refreshProfiles().catch(() => undefined);
    } catch (error) {
      toast({ title: "探测失败", description: errorMessage(error), tone: "error" });
    } finally {
      setProbing(false);
    }
  }

  async function override(body: OverrideCapabilitiesBody) {
    setSaving(true);
    try {
      const res = await api().overrideCapabilities(profile.id, body);
      setCaps(res.capabilities);
      void refreshProfiles().catch(() => undefined);
    } catch (error) {
      toast({ title: "保存失败", description: errorMessage(error), tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  const connectivity = caps?.connectivity;
  return (
    <section className="rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold">模型能力</h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            能力决定 Agent 是否发送工具、图片和推理参数。探测会向模型发送几条很短的测试请求。
          </p>
          {connectivity?.checkedAt && (
            <p
              className={`mt-1 text-[10px] ${connectivity.value === false ? "text-destructive" : "text-muted-foreground"}`}
            >
              {connectivity.value === false ? "最近一次连接失败" : "最近一次探测"} ·{" "}
              {new Date(connectivity.checkedAt).toLocaleString("zh-CN")}
              {connectivity.detail ? ` · ${connectivity.detail}` : ""}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1 text-xs"
          onClick={() => void probe()}
          disabled={probing}
        >
          {probing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ScanSearch className="h-3.5 w-3.5" />
          )}
          探测能力
        </Button>
      </div>
      {!caps ? (
        <div className="flex justify-center py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <div className="mt-2">
          <CapabilityToggleRow
            icon={<Wrench className="h-3.5 w-3.5" />}
            label="工具调用"
            desc="读写表格、运行代码等操作都依赖工具调用；不支持时 Agent 只能对话。"
            cap={caps.tools}
            disabled={saving}
            onToggle={(value) => void override({ tools: value })}
            onReset={() => void override({ tools: null })}
          />
          <CapabilityToggleRow
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            label="图片理解"
            desc="开启后可以向模型发送截图与图片附件。"
            cap={caps.vision}
            disabled={saving}
            onToggle={(value) => void override({ vision: value })}
            onReset={() => void override({ vision: null })}
          />
          <CapabilityToggleRow
            icon={<Brain className="h-3.5 w-3.5" />}
            label="推理"
            desc="开启后按「推理强度」发送思考参数，并在对话中显示思考过程。"
            cap={caps.reasoning}
            disabled={saving}
            onToggle={(value) => void override({ reasoning: value })}
            onReset={() => void override({ reasoning: null })}
          />
        </div>
      )}
    </section>
  );
}

export function ProfileEditor({
  profile,
  initialProvider,
  onClose,
  onSaved,
}: {
  /** 编辑已有档案；省略时新建。 */
  profile?: ModelProfile | null;
  initialProvider?: string;
  onClose: () => void;
  onSaved?: (profile: ModelProfile) => void;
}) {
  const providers = useAppStore((s) => s.providers);
  const profiles = useAppStore((s) => s.profiles);
  const editing = Boolean(profile);
  const selectableProviders = useMemo(
    () => providers.filter((p) => p.auth !== "subscription" || p.id === profile?.provider),
    [providers, profile?.provider],
  );
  const [draft, setDraft] = useState<Draft>(() =>
    profile
      ? draftFromProfile(profile)
      : emptyDraft(initialProvider ?? selectableProviders[0]?.id ?? "openai"),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const preset: ProviderPreset | undefined = providers.find((p) => p.id === draft.provider);
  const needsKey = (preset?.auth ?? "api_key") === "api_key";
  const isSubscription = preset?.auth === "subscription";
  const isCustom = draft.provider === "custom-openai-compatible";
  const usedModelIds = useMemo(
    () =>
      new Set(
        profiles
          .filter((p) => p.provider === draft.provider && p.id !== profile?.id)
          .map((p) => p.model),
      ),
    [profiles, draft.provider, profile?.id],
  );

  // 先用预设建议与模型目录填充候选，拉取远端列表后替换。
  useEffect(() => {
    let cancelled = false;
    setRemoteModels((preset?.suggestedModels ?? []).map((id) => ({ id })));
    api()
      .getModelCatalog(draft.provider)
      .then((res) => {
        if (cancelled || !res.items.length) return;
        setRemoteModels((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const extra = res.items
            .filter((e) => !seen.has(e.model))
            .map((e) => ({
              id: e.model,
              contextWindow: e.contextWindow,
              maxOutputTokens: e.maxOutputTokens,
            }));
          return [...prev, ...extra];
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draft.provider, preset?.suggestedModels]);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (patch.model !== undefined && !next.nameTouched) {
        next.name = patch.model.trim()
          ? uniqueProfileName(
              patch.model.trim(),
              profiles.map((p) => p.name),
            )
          : "";
      }
      return next;
    });
    setTestResult(null);
  };

  async function fetchModels() {
    setFetching(true);
    try {
      const res =
        profile &&
        !draft.apiKey &&
        draft.provider === profile.provider &&
        (draft.baseUrl || "") === (profile.baseUrl ?? "")
          ? await api().listRemoteModels(profile.id)
          : await api().listProviderModels(draft.provider, {
              ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
              ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
              ...(profile?.accountId ? { accountId: profile.accountId } : {}),
            });
      setRemoteModels(res.items);
      setModelsOpen(res.items.length > 0);
      if (!res.items.length)
        toast({ title: "未获取到模型", description: "可以直接手动填写模型 ID。", tone: "info" });
    } catch (error) {
      toast({ title: "获取模型列表失败", description: errorMessage(error), tone: "error" });
    } finally {
      setFetching(false);
    }
  }

  function selectRemote(model: RemoteModel) {
    update({
      model: model.id,
      ...(model.contextWindow && !draft.contextWindow
        ? { contextWindow: String(model.contextWindow) }
        : {}),
      ...(model.maxOutputTokens && !draft.maxOutputTokens
        ? { maxOutputTokens: String(model.maxOutputTokens) }
        : {}),
    });
  }

  async function save(): Promise<ModelProfile | null> {
    if (!draft.model.trim()) {
      toast({ title: "请填写模型 ID", tone: "error" });
      return null;
    }
    if (!draft.name.trim()) {
      toast({ title: "请填写显示名称", tone: "error" });
      return null;
    }
    if (!editing && needsKey && !draft.apiKey.trim() && !isCustom) {
      toast({ title: "请填写 API Key", tone: "error" });
      return null;
    }
    if (isCustom && !draft.baseUrl.trim()) {
      toast({ title: "请填写接口地址", tone: "error" });
      return null;
    }
    setSaving(true);
    try {
      const contextWindow = positiveInt(draft.contextWindow, "上下文长度");
      const maxOutputTokens = positiveInt(draft.maxOutputTokens, "最大输出");
      const maxConcurrency = positiveInt(draft.maxConcurrency, "并发上限", 64);
      const extraHeaders = parseHeaders(draft.extraHeaders);
      const providerOptions = parseOptions(draft.providerOptions);
      const reasoning = (draft.reasoning || undefined) as ReasoningLevel | undefined;
      let saved: ModelProfile;
      if (profile) {
        const body: UpdateModelProfileBody = {
          name: draft.name.trim(),
          provider: draft.provider,
          model: draft.model.trim(),
          baseUrl: draft.baseUrl.trim() || null,
          contextWindow: contextWindow ?? null,
          maxOutputTokens: maxOutputTokens ?? null,
          reasoning: reasoning ?? null,
          maxConcurrency: maxConcurrency ?? null,
          extraHeaders: extraHeaders ?? null,
          providerOptions: providerOptions ?? null,
        };
        if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim();
        saved = (await api().updateModelProfile(profile.id, body)).profile;
        if (draft.isDefault && !profile.isDefault)
          saved = (await api().setDefaultModelProfile(profile.id)).profile;
      } else {
        const body: CreateModelProfileBody = {
          name: draft.name.trim(),
          provider: draft.provider,
          model: draft.model.trim(),
          ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(maxConcurrency ? { maxConcurrency } : {}),
          ...(extraHeaders ? { extraHeaders } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          ...(draft.isDefault || profiles.length === 0 ? { isDefault: true } : {}),
        };
        saved = (await api().createModelProfile(body)).profile;
      }
      await refreshProfiles().catch(() => undefined);
      return saved;
    } catch (error) {
      toast({ title: "保存失败", description: errorMessage(error), tone: "error" });
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndClose() {
    const saved = await save();
    if (!saved) return;
    toast({ title: editing ? "模型已更新" : "模型已添加", tone: "success" });
    onSaved?.(saved);
    onClose();
  }

  async function saveAndTest() {
    const saved = await save();
    if (!saved) return;
    setTesting(true);
    try {
      const res = await api().testModelProfile(saved.id);
      setTestResult(
        res.ok
          ? {
              ok: true,
              text: `连接成功${res.latencyMs ? `，耗时 ${Math.round(res.latencyMs)} ms` : ""}`,
            }
          : { ok: false, text: res.error?.message ?? "连接失败" },
      );
      if (!profile) {
        onSaved?.(saved);
        onClose();
        toast({
          title: res.ok ? "模型已添加，连接成功" : "模型已添加，但连接测试失败",
          description: res.ok ? undefined : res.error?.message,
          tone: res.ok ? "success" : "error",
        });
      }
    } catch (error) {
      setTestResult({ ok: false, text: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  }

  const busy = saving || testing;

  return (
    <div className="space-y-3 rounded-xl border border-[var(--em-primary-alpha-25)] bg-background p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {editing ? `编辑模型：${profile?.name}` : "添加模型"}
        </h4>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="关闭">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="提供商" required>
          <GlassSelect
            ariaLabel="提供商"
            align="start"
            value={draft.provider}
            disabled={isSubscription}
            options={selectableProviders.map((p) => {
              const brand = presetBrand(p.id);
              return {
                value: p.id,
                label: p.displayName,
                icon: (
                  <ProviderLogo
                    id={brand}
                    color={getProviderColor(brand)}
                    className="h-3.5 w-3.5"
                  />
                ),
              };
            })}
            onChange={(value) => update({ provider: value, baseUrl: "" })}
          />
        </Field>
        <Field label="显示名称" required hint="在模型选择器中显示">
          <Input
            className={FIELD_CLASS}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value, nameTouched: true }))}
            placeholder="例如：GPT-5"
          />
        </Field>
      </div>

      {preset?.note && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
          {preset.note}
        </p>
      )}

      <Field
        label="模型 ID"
        required
        extra={
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--em-primary)] hover:underline disabled:opacity-50"
            onClick={() => void fetchModels()}
            disabled={fetching || (needsKey && !editing && !draft.apiKey.trim())}
            title={
              needsKey && !editing && !draft.apiKey.trim()
                ? "先填写 API Key"
                : "从服务商获取可用模型"
            }
          >
            {fetching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            获取模型列表
          </button>
        }
      >
        <ModelIdCombobox
          value={draft.model}
          models={remoteModels}
          usedModelIds={usedModelIds}
          open={modelsOpen}
          onOpenChange={setModelsOpen}
          onChange={(value) => update({ model: value })}
          onSelect={selectRemote}
          disabled={busy}
        />
      </Field>

      {!isSubscription && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="接口地址"
            required={isCustom}
            hint={preset?.defaultBaseUrl ? `留空使用默认：${preset.defaultBaseUrl}` : undefined}
          >
            <Input
              className={`${FIELD_CLASS} font-mono`}
              value={draft.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
              placeholder={preset?.defaultBaseUrl ?? "https://api.example.com/v1"}
              spellCheck={false}
              autoCapitalize="none"
            />
          </Field>
          {preset?.auth !== "none" && (
            <Field
              label="API Key"
              required={needsKey && !editing && !isCustom}
              extra={
                preset?.apiKeyHelpUrl ? (
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-[var(--em-primary)] hover:underline"
                    onClick={() => openLink(preset.apiKeyHelpUrl!)}
                  >
                    获取 Key
                    <ExternalLink className="h-3 w-3" />
                  </button>
                ) : undefined
              }
              hint={
                editing
                  ? profile?.hasCredential
                    ? `已保存 ${profile.apiKeyMasked ?? ""}，留空保持不变`
                    : "尚未保存凭据"
                  : "加密保存在本机"
              }
            >
              <Input
                className={`${FIELD_CLASS} font-mono`}
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder={editing && profile?.hasCredential ? "••••••••" : "sk-..."}
              />
            </Field>
          )}
        </div>
      )}

      <div>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
          />
          高级参数
        </button>
        {advancedOpen && (
          <div className="mt-2 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="上下文长度（tokens）" hint="留空按模型目录或自动识别">
                <Input
                  className={FIELD_CLASS}
                  inputMode="numeric"
                  value={draft.contextWindow}
                  onChange={(e) => update({ contextWindow: e.target.value })}
                  placeholder="例如 128000"
                />
              </Field>
              <Field label="最大输出（tokens）">
                <Input
                  className={FIELD_CLASS}
                  inputMode="numeric"
                  value={draft.maxOutputTokens}
                  onChange={(e) => update({ maxOutputTokens: e.target.value })}
                  placeholder="默认"
                />
              </Field>
              <Field label="推理强度" hint="仅对支持推理的模型生效">
                <GlassSelect
                  ariaLabel="推理强度"
                  align="start"
                  value={draft.reasoning}
                  options={REASONING_OPTIONS}
                  onChange={(value) => update({ reasoning: value })}
                />
              </Field>
              <Field label="并发上限" hint="同时向该模型发出的请求数（1–64）">
                <Input
                  className={FIELD_CLASS}
                  inputMode="numeric"
                  value={draft.maxConcurrency}
                  onChange={(e) => update({ maxConcurrency: e.target.value })}
                  placeholder="默认"
                />
              </Field>
            </div>
            <Field
              label="额外请求头"
              hint="每行一个 Name: Value；已保存的值显示为掩码，不修改则保持原值。"
            >
              <textarea
                className="w-full h-16 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-mono resize-y"
                value={draft.extraHeaders}
                onChange={(e) => update({ extraHeaders: e.target.value })}
                placeholder="X-Custom-Header: value"
                spellCheck={false}
              />
            </Field>
            <Field label="提供商参数（JSON）" hint="原样传给服务商 SDK 的附加选项。">
              <textarea
                className="w-full h-20 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-mono resize-y"
                value={draft.providerOptions}
                onChange={(e) => update({ providerOptions: e.target.value })}
                placeholder='{"temperature": 0.2}'
                spellCheck={false}
              />
            </Field>
          </div>
        )}
      </div>

      {profile && <CapabilityPanel profile={profile} />}

      {testResult && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-xs ${testResult.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-destructive/5 text-destructive"}`}
        >
          {testResult.ok ? "✓ " : "✗ "}
          {testResult.text}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center">
        {!profile?.isDefault && (
          <MiniCheckbox
            checked={draft.isDefault}
            onChange={(checked) => setDraft((d) => ({ ...d, isDefault: checked }))}
            label="设为默认模型"
            className="sm:mr-auto"
          />
        )}
        <div className="flex flex-wrap justify-end gap-2 sm:ml-auto">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            onClick={() => void saveAndTest()}
            disabled={busy}
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanSearch className="h-3.5 w-3.5" />
            )}
            保存并测试
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1 text-xs text-white"
            style={{ backgroundColor: "var(--em-primary)" }}
            onClick={() => void saveAndClose()}
            disabled={busy}
          >
            {saving && !testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
