import { Crown, Database, Settings2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { RegionStatus } from "@/components/ui/LazyRegion";
import { refreshProfiles, useAppStore } from "@/stores/app-store";
import {
  type ModelSubTab,
  subscribeModelSubTab,
  takePendingModelSubTab,
} from "./model/model-subtab";
import { ProfileSection } from "./model/ProfileSection";
import { RoleModelSection } from "./model/RoleModelSection";
import { SubscriptionPanel } from "./model/SubscriptionPanel";
import { SettingsPageLayout, SettingsPageSubnav } from "./SettingsPageLayout";

type VisibleSubTab = Exclude<ModelSubTab, "diagnostics">;

const SUB_TABS: {
  key: VisibleSubTab;
  label: string;
  icon: ReactNode;
  coachId: string;
  description: string;
}[] = [
  {
    key: "providers",
    label: "模型连接",
    icon: <Database className="h-3 w-3" />,
    coachId: "coach-settings-subtab-providers",
    description: "添加 API 连接，管理可用模型。",
  },
  {
    key: "roles",
    label: "模型配置",
    icon: <Settings2 className="h-3 w-3" />,
    coachId: "coach-settings-subtab-roles",
    description: "选择默认模型、子代理与压缩使用的模型。",
  },
  {
    key: "subscription",
    label: "订阅账号",
    icon: <Crown className="h-3 w-3" />,
    coachId: "coach-settings-subtab-subscription",
    description: "连接已有订阅，免去重复填写 API Key。",
  },
];

function normalize(tab: ModelSubTab): VisibleSubTab {
  return tab === "diagnostics" ? "roles" : tab;
}

export function ModelTab() {
  const loaded = useAppStore((s) => s.profilesLoaded);
  const error = useAppStore((s) => s.profilesError);
  const [subTab, setSubTab] = useState<VisibleSubTab>(() =>
    normalize(takePendingModelSubTab() ?? "providers"),
  );
  const navigate = useCallback((tab: ModelSubTab) => setSubTab(normalize(tab)), []);

  useEffect(() => subscribeModelSubTab(navigate), [navigate]);

  return (
    <SettingsPageLayout className="em-model-page em-settings-page-stack">
      <SettingsPageSubnav
        label="模型工作区"
        showHeader={false}
        activeKey={subTab}
        items={SUB_TABS}
        onChange={(key) => navigate(key as ModelSubTab)}
      />
      <main className="em-model-content" aria-live="polite">
        {subTab !== "subscription" && !loaded ? (
          <RegionStatus
            label="模型配置"
            failed={Boolean(error)}
            onRetry={() => {
              void refreshProfiles().catch(() => undefined);
            }}
          />
        ) : (
          <>
            {subTab === "providers" && <ProfileSection />}
            {subTab === "roles" && <RoleModelSection />}
          </>
        )}
        {subTab === "subscription" && <SubscriptionPanel />}
      </main>
    </SettingsPageLayout>
  );
}
