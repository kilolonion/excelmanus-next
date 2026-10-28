import type {
  Capabilities,
  JsonObject,
  ModelProfile,
  OverrideCapabilitiesBody,
  ProviderConnection,
  ReasoningLevel,
  RemoteModel,
} from "@excelmanus/protocol";
import {
  Brain,
  ChevronRight,
  ImageIcon,
  Loader2,
  RefreshCw,
  ScanSearch,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MiniCheckbox } from "@/components/ui/MiniCheckbox";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { refreshProfiles, useAppStore } from "@/stores/app-store";
import { CapabilityToggleRow } from "./capability-widgets";
import { FIELD_CLASS, Field, GlassSelect } from "./form-widgets";
import { REASONING_LABELS } from "./helpers";
import { ModelIdCombobox } from "./ModelIdCombobox";

function positiveInt(value: string, label: string, max?: number): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || (max !== undefined && n > max))
    throw new Error(`${label}应为${max ? `1–${max} 的` : ""}正整数`);
  return n;
}
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
  connection,
  onClose,
  onSaved,
}: {
  profile?: ModelProfile | null;
  connection: ProviderConnection;
  onClose: () => void;
  onSaved?: (p: ModelProfile) => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const [model, setModel] = useState(profile?.model ?? "");
  const [name, setName] = useState(profile?.name ?? "");
  const [context, setContext] = useState(String(profile?.contextWindow ?? ""));
  const [output, setOutput] = useState(String(profile?.maxOutputTokens ?? ""));
  const [reasoning, setReasoning] = useState(profile?.reasoning ?? "");
  const [concurrency, setConcurrency] = useState(String(profile?.maxConcurrency ?? ""));
  const [options, setOptions] = useState(
    profile?.providerOptions ? JSON.stringify(profile.providerOptions, null, 2) : "",
  );
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? false);
  const [overrides, setOverrides] = useState<OverrideCapabilitiesBody>({});
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<RemoteModel[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savedId = useRef(profile?.id);
  const used = useMemo(
    () =>
      new Set(
        profiles
          .filter((p) => p.connectionId === connection.id && p.id !== profile?.id)
          .map((p) => p.model),
      ),
    [profiles, connection.id, profile?.id],
  );
  useEffect(() => {
    let cancelled = false;
    api()
      .getConnectionModels(connection.id)
      .then((r) => {
        if (!cancelled) setModels(r.items);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id]);
  async function refresh() {
    setFetching(true);
    setError("");
    try {
      const r = await api().refreshConnectionModels(connection.id);
      setModels(r.items);
      setModelsOpen(true);
      await refreshProfiles();
    } catch (e) {
      setError(errorMessage(e, "刷新失败，保留上次目录，可手填模型 ID"));
    } finally {
      setFetching(false);
    }
  }
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      if (!model.trim()) throw new Error("请选择或输入模型 ID");
      const contextWindow = positiveInt(context, "上下文长度"),
        maxOutputTokens = positiveInt(output, "最大输出"),
        maxConcurrency = positiveInt(concurrency, "并发上限", 64);
      if (contextWindow && maxOutputTokens && maxOutputTokens > contextWindow)
        throw new Error("最大输出不能超过模型上下文");
      let providerOptions: JsonObject | undefined;
      if (options.trim()) {
        const parsed: unknown = JSON.parse(options);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("提供商参数应为 JSON 对象");
        providerOptions = parsed as JsonObject;
      }
      let saved: ModelProfile;
      if (savedId.current) {
        saved = (
          await api().updateModelProfile(savedId.current, {
            name: name.trim() || model.trim(),
            model: model.trim(),
            contextWindow: contextWindow ?? null,
            maxOutputTokens: maxOutputTokens ?? null,
            maxConcurrency: maxConcurrency ?? null,
            reasoning: (reasoning || null) as ReasoningLevel | null,
            providerOptions: providerOptions ?? null,
          })
        ).profile;
      } else {
        saved = (
          await api().createModelProfile({
            connectionId: connection.id,
            model: model.trim(),
            ...(name.trim() ? { name: name.trim() } : {}),
            contextWindow,
            maxOutputTokens,
            maxConcurrency,
            reasoning: (reasoning || undefined) as ReasoningLevel | undefined,
            providerOptions,
            capabilityOverrides: overrides,
            isDefault,
          })
        ).profile;
        savedId.current = saved.id;
      }
      if (isDefault && !saved.isDefault) await api().setDefaultModelProfile(saved.id);
      await refreshProfiles();
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e, "保存失败"));
    } finally {
      setSaving(false);
    }
  }
  const picked = models.find((m) => m.id === model);
  return (
    <div className="space-y-3 rounded-xl border border-[var(--em-primary-alpha-25)] bg-background p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">{profile ? "编辑模型" : "添加模型"}</h4>
          <p className="text-xs text-muted-foreground">
            {connection.name} · 共用此供应商的连接配置
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭模型编辑"
          disabled={saving}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <Field
        label="模型 ID"
        required
        extra={
          <Button
            size="sm"
            variant="ghost"
            disabled={fetching || saving}
            onClick={() => void refresh()}
          >
            {fetching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            刷新列表
          </Button>
        }
      >
        <ModelIdCombobox
          value={model}
          models={models}
          usedModelIds={used}
          open={modelsOpen}
          onOpenChange={setModelsOpen}
          onChange={setModel}
          onSelect={(m) => setModel(m.id)}
          disabled={saving}
        />
      </Field>
      <p className="text-[11px] text-muted-foreground">
        可搜索目录或直接输入模型 ID。选择后即可保存，高级参数留空时自动采用目录默认值。
      </p>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        aria-expanded={advanced}
        onClick={() => setAdvanced((v) => !v)}
      >
        <ChevronRight className={`h-3 w-3 ${advanced ? "rotate-90" : ""}`} />
        高级选项
      </button>
      {advanced && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="别名（可选）" hint="模型名始终优先显示">
              <Input
                className={FIELD_CLASS}
                aria-label="模型别名"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={model || "可留空"}
              />
            </Field>
            <Field label="上下文长度（tokens）" hint="留空为自动">
              <Input
                className={FIELD_CLASS}
                inputMode="numeric"
                aria-label="上下文长度"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={picked?.contextWindow ? `自动：${picked.contextWindow}` : "自动"}
              />
            </Field>
            <Field label="最大输出（tokens）" hint="留空采用目录默认值">
              <Input
                className={FIELD_CLASS}
                inputMode="numeric"
                aria-label="最大输出"
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                placeholder={picked?.maxOutputTokens ? `自动：${picked.maxOutputTokens}` : "自动"}
              />
            </Field>
            <Field label="思考强度">
              <GlassSelect
                ariaLabel="思考强度"
                value={reasoning}
                options={[
                  { value: "", label: "自动" },
                  ...Object.entries(REASONING_LABELS).map(([value, label]) => ({ value, label })),
                ]}
                onChange={(v) => setReasoning(v as ReasoningLevel)}
              />
            </Field>
            <Field label="并发上限" hint="1–64，留空采用默认值">
              <Input
                className={FIELD_CLASS}
                inputMode="numeric"
                aria-label="并发上限"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                placeholder="自动"
              />
            </Field>
          </div>
          {!profile && (
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["vision", "图片输入"],
                  ["tools", "工具调用"],
                  ["reasoning", "思考能力"],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label}>
                  <GlassSelect
                    ariaLabel={label}
                    value={overrides[k] === true ? "yes" : overrides[k] === false ? "no" : "auto"}
                    options={[
                      { value: "auto", label: "自动 / 未知" },
                      { value: "yes", label: "支持" },
                      { value: "no", label: "不支持" },
                    ]}
                    onChange={(v) =>
                      setOverrides((o) => ({ ...o, [k]: v === "auto" ? null : v === "yes" }))
                    }
                  />
                </Field>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            输入支持文本与图片，输出为文本。能力手动覆盖不等于已通过实际探测。
          </p>
          <Field label="提供商参数（JSON）">
            <textarea
              className="w-full h-20 rounded-lg border border-input bg-background p-2 text-xs font-mono"
              aria-label="提供商参数"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="{}"
            />
          </Field>
          {profile && <CapabilityPanel profile={profile} />}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        {!profile?.isDefault && (
          <MiniCheckbox checked={isDefault} onChange={setIsDefault} label="设为默认模型" />
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}保存模型
          </Button>
        </div>
      </div>
    </div>
  );
}
