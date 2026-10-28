import type { ProviderConnection } from "@excelmanus/protocol";
import { Loader2, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { MiniCheckbox } from "@/components/ui/MiniCheckbox";
import { api, errorMessage } from "@/lib/backend/api";
import { refreshProfiles, useAppStore } from "@/stores/app-store";
import { FIELD_CLASS, Field, GlassSelect } from "./form-widgets";

export function ConnectionEditor({
  connection,
  onClose,
  onSaved,
}: {
  connection?: ProviderConnection;
  onClose: () => void;
  onSaved?: (c: ProviderConnection) => void;
}) {
  const savedId = useRef(connection?.id);
  const providers = useAppStore((s) => s.providers);
  const [provider, setProvider] = useState(connection?.provider ?? "custom-openai-compatible");
  const [name, setName] = useState(connection?.name ?? "");
  const [url, setUrl] = useState(connection?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [headers, setHeaders] = useState(
    Object.entries(connection?.extraHeaders ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const preset = providers.find((p) => p.id === provider);
  async function save() {
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      if (!name.trim()) throw new Error("请填写供应商连接名称");
      if (provider === "custom-openai-compatible" && !url.trim()) throw new Error("请填写接口地址");
      if (url.trim()) {
        const u = new URL(url.trim());
        if (!["http:", "https:"].includes(u.protocol))
          throw new Error("接口地址应使用 HTTP 或 HTTPS");
      }
      const extraHeaders: Record<string, string> = {};
      for (const line of headers.split("\n")) {
        if (!line.trim()) continue;
        const i = line.indexOf(":");
        if (i <= 0) throw new Error("请求头格式应为 Name: Value，每行一个");
        extraHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const changed =
        connection &&
        (url.trim() !== (connection.baseUrl ?? "") ||
          !!key ||
          clearKey ||
          headers !==
            Object.entries(connection.extraHeaders ?? {})
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n"));
      if (
        changed &&
        connection.modelCount > 0 &&
        !(await confirmAction({
          title: "更新共享连接",
          description: `会影响该供应商下的 ${connection.modelCount} 个模型，下一次请求使用新配置。`,
          confirmLabel: "更新连接",
        }))
      )
        return;
      const saved = savedId.current
        ? (
            await api().updateProviderConnection(savedId.current, {
              name: name.trim(),
              ...(changed || !connection
                ? {
                    baseUrl: url.trim() || null,
                    extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : null,
                    ...(clearKey ? { apiKey: "" } : key ? { apiKey: key } : {}),
                  }
                : {}),
            })
          ).connection
        : (
            await api().createProviderConnection({
              name: name.trim(),
              provider,
              ...(url.trim() ? { baseUrl: url.trim() } : {}),
              ...(key ? { apiKey: key } : {}),
              ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
            })
          ).connection;
      savedId.current = saved.id;
      await refreshProfiles();
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e, "保存供应商失败"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-3 rounded-xl border border-[var(--em-primary-alpha-25)] bg-background p-3 sm:p-4">
      <div className="flex justify-between items-center">
        <h4 className="text-sm font-semibold">{connection ? "编辑供应商连接" : "添加供应商"}</h4>
        <Button
          size="icon"
          variant="ghost"
          aria-label="关闭供应商编辑"
          disabled={saving}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="连接名称" required>
          <Input
            className={FIELD_CLASS}
            aria-label="连接名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：CPA、OpenAI 工作账号"
          />
        </Field>
        <Field label="接口类型" required>
          <GlassSelect
            ariaLabel="接口类型"
            value={provider}
            disabled={!!connection}
            options={providers
              .filter((p) => p.auth !== "subscription" || p.id === connection?.provider)
              .map((p) => ({ value: p.id, label: p.displayName }))}
            onChange={(v) => {
              setProvider(v);
              setUrl("");
              setKey("");
              setHeaders("");
              if (!name) setName(providers.find((p) => p.id === v)?.displayName ?? v);
            }}
          />
        </Field>
        {provider !== "chatgpt" && (
          <>
            <Field
              label="接口地址"
              hint={
                preset?.defaultBaseUrl
                  ? `默认：${preset.defaultBaseUrl}`
                  : "服务商提供的 API Base URL"
              }
            >
              <Input
                className={FIELD_CLASS}
                aria-label="接口地址"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={preset?.defaultBaseUrl ?? "https://api.example.com/v1"}
              />
            </Field>
            {preset?.auth !== "none" && (
              <Field
                label="API Key"
                hint={
                  connection?.hasCredential
                    ? `已保存 ${connection.apiKeyMasked ?? ""}，留空不更改`
                    : "加密保存，该连接下所有模型共用"
                }
              >
                <Input
                  type="password"
                  autoComplete="off"
                  className={FIELD_CLASS}
                  aria-label="API Key"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setClearKey(false);
                  }}
                  disabled={clearKey}
                  placeholder="可选"
                />
                {connection?.hasCredential && (
                  <MiniCheckbox
                    checked={clearKey}
                    onChange={setClearKey}
                    label="清除已保存的 Key"
                  />
                )}
              </Field>
            )}
          </>
        )}
      </div>
      {provider === "chatgpt" ? (
        <p className="text-xs text-muted-foreground">订阅认证在“订阅账号”页管理。</p>
      ) : (
        <>
          <button
            type="button"
            className="text-xs text-muted-foreground"
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            高级连接设置
          </button>
          {advanced && (
            <Field label="额外请求头" hint="每行 Name: Value，保持掩码即保留原值">
              <textarea
                className="w-full h-20 rounded-lg border bg-background p-2 text-xs font-mono"
                aria-label="额外请求头"
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
              />
            </Field>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
          取消
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}保存连接
        </Button>
      </div>
    </div>
  );
}
