// 模型角色：默认模型（新任务主对话）、子代理模型、上下文压缩模型。

import type { ModelProfile } from "@excelmanus/protocol";
import { Bot, Crown, Layers, Loader2, Settings2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { getProviderColor } from "@/lib/provider-brand";
import { refreshProfiles, refreshSettings, updateSettings, useAppStore } from "@/stores/app-store";
import { SettingsFoldSection } from "../SettingsFoldSection";
import { GlassSelect } from "./form-widgets";
import { getProfileProviderId, getProviderGroupLabel, profileBrand } from "./helpers";
import { requestModelSubTab } from "./model-subtab";
import { ProviderAvatar } from "./ProviderLogo";

const SAME_AS_MAIN = "";

function RoleRow({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border/50 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-[var(--em-primary)]">{icon}</span>
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{title}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
        </div>
      </div>
      <div className="shrink-0 sm:w-72">{children}</div>
    </div>
  );
}

export function RoleModelSection() {
  const profiles = useAppStore((s) => s.profiles);
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) void refreshSettings().catch(() => undefined);
  }, [settings]);

  const defaultProfile = profiles.find((p) => p.isDefault) ?? null;

  const option = (profile: ModelProfile) => {
    const brand = profileBrand(profile);
    const group = getProviderGroupLabel(getProfileProviderId(profile), profile.name, providers);
    return {
      value: profile.id,
      label: `${profile.name} · ${group}`,
      icon: (
        <ProviderAvatar
          id={brand}
          label={profile.name}
          color={getProviderColor(brand)}
          className="h-5 w-5 rounded-md"
          iconClassName="h-3.5 w-3.5"
        />
      ),
    };
  };
  const options = profiles.map(option);
  const withMain = [{ value: SAME_AS_MAIN, label: "与主对话相同" }, ...options];

  async function setDefault(id: string) {
    setSaving("default");
    try {
      await api().setDefaultModelProfile(id);
      await refreshProfiles();
    } catch (error) {
      toast({ title: "设置默认模型失败", description: errorMessage(error), tone: "error" });
    } finally {
      setSaving(null);
    }
  }

  async function setRole(key: "subAgentProfileId" | "compactionProfileId", id: string) {
    setSaving(key);
    try {
      await updateSettings({ [key]: id || null });
    } catch (error) {
      toast({ title: "保存失败", description: errorMessage(error), tone: "error" });
    } finally {
      setSaving(null);
    }
  }

  return (
    <SettingsFoldSection
      title="模型配置"
      description="为不同用途选择模型。修改后立即保存；已开始的任务可在对话中单独切换模型。"
      icon={<Settings2 className="h-4 w-4" style={{ color: "var(--em-primary)" }} />}
      coachId="coach-settings-model-roles"
    >
      <div className="px-3 pb-1">
        {profiles.length === 0 ? (
          <div className="my-2 rounded-xl border border-dashed px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">还没有模型。</p>
            <button
              type="button"
              className="mt-1 text-xs text-[var(--em-primary)] hover:underline"
              onClick={() => requestModelSubTab("providers")}
            >
              去添加模型
            </button>
          </div>
        ) : (
          <>
            <RoleRow
              icon={<Crown className="h-4 w-4" />}
              title="默认模型"
              desc="新建任务时主对话使用的模型。"
            >
              <GlassSelect
                ariaLabel="默认模型"
                value={defaultProfile?.id ?? ""}
                disabled={saving === "default"}
                options={options}
                onChange={(id) => void setDefault(id)}
              />
            </RoleRow>
            <RoleRow
              icon={<Bot className="h-4 w-4" />}
              title="子代理模型"
              desc="主代理分派子任务时，子代理默认使用的模型。"
            >
              {settings ? (
                <GlassSelect
                  ariaLabel="子代理模型"
                  value={settings.subAgentProfileId ?? SAME_AS_MAIN}
                  disabled={saving === "subAgentProfileId"}
                  options={withMain}
                  onChange={(id) => void setRole("subAgentProfileId", id)}
                />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </RoleRow>
            <RoleRow
              icon={<Layers className="h-4 w-4" />}
              title="上下文压缩模型"
              desc="对话过长时用于整理摘要的模型，可选用更快、更便宜的模型。"
            >
              {settings ? (
                <GlassSelect
                  ariaLabel="上下文压缩模型"
                  value={settings.compactionProfileId ?? SAME_AS_MAIN}
                  disabled={saving === "compactionProfileId"}
                  options={withMain}
                  onChange={(id) => void setRole("compactionProfileId", id)}
                />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </RoleRow>
          </>
        )}
      </div>
    </SettingsFoldSection>
  );
}
