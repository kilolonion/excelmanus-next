import { Download, Loader2, RefreshCw, Server, Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { desktop, errorMessage } from "@/lib/backend/api";
import { useAppStore } from "@/stores/app-store";
import { ProjectLinks } from "./ProjectLinks";
import { SettingsPageLayout, SettingsPagePanel } from "./SettingsPageLayout";

const SHAPE_LABELS: Record<string, string> = {
  "local-web": "本机 Web",
  desktop: "桌面版",
  server: "服务器",
};

const UPDATE_LABELS: Record<string, string> = {
  latest: "当前已是最新版本",
  downloading: "发现新版本，正在后台下载…",
  ready: "新版本已下载完成，重启后安装",
  error: "检查更新失败",
  unavailable: "此构建不支持自动更新",
  denied: "无法检查更新",
};

function DesktopUpdateCard({ current }: { current: string }) {
  const update = useAppStore((s) => s.desktopUpdate);
  const [busy, setBusy] = useState(false);
  const bridge = desktop();
  if (!bridge) return null;

  async function check() {
    if (!bridge) return;
    setBusy(true);
    try {
      const status = await bridge.checkForUpdates();
      useAppStore.setState({ desktopUpdate: status });
    } catch (error) {
      useAppStore.setState({ desktopUpdate: { status: "error", message: errorMessage(error) } });
    } finally {
      setBusy(false);
    }
  }

  const label = update ? (UPDATE_LABELS[update.status] ?? update.status) : "";
  return (
    <SettingsPagePanel>
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-5 w-5 text-[var(--em-primary)]" />
        ExcelManus Desktop
        <Badge variant="secondary">v{current}</Badge>
      </div>
      <p className="mt-2 text-[11px] leading-[1.65] text-muted-foreground">
        检查新版本后在后台下载，下载完成即可重启安装。更新只替换程序，不影响你的工作区文件、会话与设置。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => void check()}
          disabled={busy || update?.status === "downloading"}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          检查更新
        </Button>
        {update?.status === "ready" && (
          <Button size="sm" className="text-xs" onClick={() => bridge.installUpdate()}>
            <Download className="h-4 w-4" />
            重启并安装{update.version ? ` v${update.version}` : ""}
          </Button>
        )}
      </div>
      {update && (
        <p
          role={update.status === "error" ? "alert" : "status"}
          className={`mt-3 text-xs ${update.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {label}
          {update.version && update.status !== "ready"
            ? `（v${update.version}${typeof update.percent === "number" ? ` · ${Math.round(update.percent)}%` : ""}）`
            : ""}
          {update.message ? `：${update.message}` : ""}
        </p>
      )}
    </SettingsPagePanel>
  );
}

export function AboutTab() {
  const appVersion = useAppStore((s) => s.appVersion);
  const shape = useAppStore((s) => s.shape);
  const dataDir = useAppStore((s) => s.dataDir);

  return (
    <SettingsPageLayout className="space-y-4 pb-2">
      <SettingsPagePanel>
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)]">
            <Server className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              ExcelManus
              {appVersion && <Badge variant="secondary">v{appVersion}</Badge>}
            </h2>
            <p className="mt-1 text-[11px] leading-[1.65] text-muted-foreground">
              用自然语言处理表格的智能助手。
            </p>
            <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">运行形态</dt>
              <dd>{SHAPE_LABELS[shape] ?? shape}</dd>
              {dataDir && (
                <>
                  <dt className="text-muted-foreground">数据目录</dt>
                  <dd className="break-all font-mono">{dataDir}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </SettingsPagePanel>
      <DesktopUpdateCard current={appVersion} />
      <ProjectLinks />
    </SettingsPageLayout>
  );
}
