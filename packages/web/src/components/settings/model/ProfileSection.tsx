// 模型连接：按提供商分组列出模型档案，可新增、编辑、测试、设为默认与删除。

import type { ModelProfile } from "@excelmanus/protocol";
import {
  AlertTriangle,
  Database,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { refreshProfiles, useAppStore } from "@/stores/app-store";
import { CapabilityBadges } from "./capability-widgets";
import { formatTokens, groupProfilesByProvider } from "./helpers";
import { takePendingModelProfile } from "./model-subtab";
import { ProfileEditor } from "./ProfileEditor";
import { ProviderAvatar } from "./ProviderLogo";

type EditorState = { mode: "create" } | { mode: "edit"; profile: ModelProfile } | null;

export function ProfileSection() {
  const profiles = useAppStore((s) => s.profiles);
  const providers = useAppStore((s) => s.providers);
  const groups = useMemo(() => groupProfilesByProvider(profiles, providers), [profiles, providers]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);

  useEffect(() => {
    void refreshProfiles().catch(() => undefined);
    const pending = takePendingModelProfile();
    if (pending) {
      const target = useAppStore
        .getState()
        .profiles.find((p) => p.id === pending || p.name === pending);
      if (target) setEditor({ mode: "edit", profile: target });
    }
  }, []);

  async function run(id: string, action: () => Promise<void>, failTitle: string) {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast({ title: failTitle, description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const setDefault = (profile: ModelProfile) =>
    run(
      profile.id,
      async () => {
        await api().setDefaultModelProfile(profile.id);
        await refreshProfiles();
      },
      "设置默认模型失败",
    );

  const test = (profile: ModelProfile) =>
    run(
      profile.id,
      async () => {
        setTests((prev) => {
          const next = { ...prev };
          delete next[profile.id];
          return next;
        });
        const res = await api().testModelProfile(profile.id);
        setTests((prev) => ({
          ...prev,
          [profile.id]: res.ok
            ? {
                ok: true,
                text: `连接成功${res.latencyMs ? ` · ${Math.round(res.latencyMs)} ms` : ""}`,
              }
            : { ok: false, text: res.error?.message ?? "连接失败" },
        }));
      },
      "测试失败",
    );

  const remove = async (profile: ModelProfile) => {
    const ok = await confirmAction({
      title: `删除模型「${profile.name}」`,
      description: profile.isDefault
        ? "这是当前默认模型，删除后需要重新选择默认模型。"
        : "已有任务中使用该模型的代理将无法继续。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    await run(
      profile.id,
      async () => {
        await api().deleteModelProfile(profile.id);
        await refreshProfiles();
      },
      "删除失败",
    );
  };

  async function refreshCatalog() {
    setRefreshingCatalog(true);
    try {
      const res = await api().refreshModelCatalog();
      toast({
        title: "模型目录已更新",
        description: `共 ${res.items.length} 个模型`,
        tone: "success",
      });
    } catch (error) {
      toast({ title: "更新模型目录失败", description: errorMessage(error), tone: "error" });
    } finally {
      setRefreshingCatalog(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <section
        className="em-plugin-panel space-y-3 rounded-xl border p-3"
        data-coach-id="coach-settings-providers"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)]">
              <Database className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-medium">模型连接</h4>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {profiles.length
                  ? `已添加 ${profiles.length} 个模型，来自 ${groups.length} 个提供商`
                  : "添加一个模型后即可开始任务"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => void refreshCatalog()}
              disabled={refreshingCatalog}
              title="更新模型目录（上下文长度、能力等元数据）"
            >
              {refreshingCatalog ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              <span className="hidden sm:inline">更新目录</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={() => setEditor({ mode: "create" })}
              data-coach-id="coach-settings-add-model"
            >
              <Plus className="h-3 w-3" />
              添加模型
            </Button>
          </div>
        </div>
      </section>

      {editor?.mode === "create" && <ProfileEditor onClose={() => setEditor(null)} />}

      {profiles.length === 0 && !editor && (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center">
          <Database className="mx-auto h-7 w-7 text-muted-foreground/30" />
          <p className="mt-2 text-xs font-medium text-muted-foreground">还没有模型</p>
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            填写 API Key 添加模型，或在「订阅账号」中登录 ChatGPT
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section
          key={group.id}
          className="em-settings-section overflow-hidden rounded-xl border border-border"
        >
          <header className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2.5">
            <ProviderAvatar
              id={group.logoId}
              label={group.label}
              color={group.color}
              className="h-8 w-8"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{group.label}</p>
              <p className="text-[10px] text-muted-foreground">{group.profiles.length} 个模型</p>
            </div>
          </header>
          <div className="divide-y divide-border/50">
            {group.profiles.map((profile) => {
              if (editor?.mode === "edit" && editor.profile.id === profile.id) {
                return (
                  <div key={profile.id} className="p-2">
                    <ProfileEditor profile={profile} onClose={() => setEditor(null)} />
                  </div>
                );
              }
              const result = tests[profile.id];
              const auth = providers.find((p) => p.id === profile.provider)?.auth ?? "api_key";
              const missingKey =
                auth === "api_key" &&
                !profile.hasCredential &&
                profile.provider !== "custom-openai-compatible";
              return (
                <div key={profile.id} className="px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium break-words">{profile.name}</span>
                        {profile.isDefault && (
                          <Badge className="border-0 bg-[var(--em-primary-alpha-12)] px-1.5 py-0 text-[9px] text-[var(--em-primary)]">
                            默认
                          </Badge>
                        )}
                        <CapabilityBadges caps={profile.capabilities} />
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                        <code className="font-mono">{profile.model}</code>
                        {profile.contextWindow ? (
                          <span>{formatTokens(profile.contextWindow)} 上下文</span>
                        ) : null}
                        {profile.baseUrl ? (
                          <span className="truncate font-mono" title={profile.baseUrl}>
                            {profile.baseUrl}
                          </span>
                        ) : null}
                      </p>
                      {missingKey && (
                        <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" />
                          未填写 API Key
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      {busy === profile.id ? (
                        <Loader2 className="m-1.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <>
                          {!profile.isDefault && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="设为默认"
                              aria-label="设为默认"
                              onClick={() => void setDefault(profile)}
                            >
                              <Star className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="测试连接"
                            aria-label="测试连接"
                            onClick={() => void test(profile)}
                          >
                            <Zap className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="编辑"
                            aria-label="编辑"
                            onClick={() => setEditor({ mode: "edit", profile })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            title="删除"
                            aria-label="删除"
                            onClick={() => void remove(profile)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {result && (
                    <p
                      role="status"
                      className={`mt-1.5 rounded-md px-2 py-1 text-[11px] ${result.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-destructive/5 text-destructive"}`}
                    >
                      {result.ok ? "✓ " : "✗ "}
                      {result.text}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
