import type { ModelProfile } from "@excelmanus/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/backend/api";
import { getProviderDisplayName, inferModelBrand } from "@/lib/provider-brand";
import { defaultProfile, refreshProfiles, useAppStore } from "@/stores/app-store";
import { switchModel, useChatStore } from "@/stores/chat-store";

/** 模型选择器里的一项：一个模型档案。 */
export interface PickerModel {
  id: string;
  label: string;
  profileName: string;
  model: string;
  /** 提供商预设 id（分组用）。 */
  provider: string;
  connectionId?: string;
  providerLabel: string;
  /** 品牌（图标与颜色）。 */
  brand: string;
  isDefault: boolean;
  /** 连通性探测失败。 */
  unhealthy: boolean;
  healthDetail?: string;
  vision: boolean | null;
}

export function toPickerModel(
  profile: ModelProfile,
  providerLabels: Map<string, string>,
): PickerModel {
  const connectivity = profile.capabilities?.connectivity;
  const brand = inferModelBrand({
    model: profile.model,
    provider: profile.provider,
    baseUrl: profile.baseUrl ?? null,
  });
  return {
    id: profile.id,
    label: profile.model,
    profileName: profile.name,
    model: profile.model,
    provider: profile.provider,
    connectionId: profile.connectionId,
    providerLabel:
      providerLabels.get(profile.connectionId) ??
      providerLabels.get(profile.provider) ??
      getProviderDisplayName(brand),
    brand,
    isDefault: profile.isDefault,
    unhealthy: connectivity?.value === false,
    ...(connectivity?.detail ? { healthDetail: connectivity.detail } : {}),
    vision: profile.capabilities?.vision?.value ?? null,
  };
}

export function usePickerModels(): PickerModel[] {
  const profiles = useAppStore((s) => s.profiles);
  const providers = useAppStore((s) => s.providers);
  const connections = useAppStore((s) => s.connections);
  return useMemo(() => {
    const labels = new Map([
      ...providers.map((p) => [p.id, p.displayName] as const),
      ...connections.map((c) => [c.id, c.name] as const),
    ]);
    return profiles.map((p) => toPickerModel(p, labels));
  }, [profiles, providers, connections]);
}

/** 当前代理实际使用的档案：代理指定的，否则全局默认。 */
export function useCurrentProfileId(): string | null {
  const assigned = useChatStore((s) => s.session.roster[s.viewAgentId]?.modelProfileId ?? null);
  const fallback = useAppStore((s) => defaultProfile(s)?.id ?? null);
  const unresolved = useChatStore((s) => s.loading || !!s.loadError);
  return unresolved ? null : (assigned ?? fallback);
}

/** 对话区与侧栏共用的模型选择：会话内切换当前代理的档案；没有会话时设为全局默认。 */
export function useModelSelection() {
  const models = usePickerModels();
  const initialLoading = useAppStore((s) => !s.profilesLoaded && !s.profilesError);
  const initialError = useAppStore((s) => (!s.profilesLoaded ? s.profilesError : null));
  const currentModel = useCurrentProfileId();
  const [switching, setSwitching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const pending = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      await refreshProfiles();
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "无法读取模型列表"));
    } finally {
      setLoading(false);
    }
  }, []);

  const selectModel = useCallback(
    async (id: string) => {
      if (pending.current || useChatStore.getState().loading || useChatStore.getState().loadError)
        return false;
      setSwitchError(null);
      if (id === currentModel) return true;
      pending.current = true;
      setSwitching(true);
      try {
        if (useChatStore.getState().sessionId) await switchModel(id);
        else {
          await api().setDefaultModelProfile(id);
          await refreshProfiles();
        }
        return true;
      } catch (error) {
        setSwitchError(errorMessage(error, "切换失败"));
        return false;
      } finally {
        pending.current = false;
        setSwitching(false);
      }
    },
    [currentModel],
  );

  return {
    currentModel,
    models,
    switching,
    loading: loading || initialLoading,
    loadError: loadError ?? initialError,
    switchError,
    reload,
    selectModel,
  };
}
