import type { AppSettings, DispatchMode, UpdateSettingsBody } from "@excelmanus/protocol";
import {
  Globe,
  Keyboard,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Save,
  ShieldCheck,
  Sun,
  Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import { shortcutHelp } from "@/lib/shortcuts";
import { getTheme, setTheme, type ThemePref } from "@/lib/theme";
import { refreshSettings, updateSettings, useAppStore } from "@/stores/app-store";
import { GlassSelect } from "./model/form-widgets";
import { SettingsPageLayout, SettingsPagePanel } from "./SettingsPageLayout";

export const PERMISSION_MODE_OPTIONS: {
  value: AppSettings["defaultPermissionMode"];
  label: string;
  desc: string;
}[] = [
  { value: "confirm", label: "逐项确认", desc: "每次修改文件或执行操作前都先询问" },
  { value: "standard", label: "标准", desc: "只读操作直接执行，写入和高风险操作需要确认" },
  { value: "auto", label: "自动执行", desc: "所有操作自动执行，修改仍会保留备份" },
];

export const DISPATCH_MODE_OPTIONS: { value: DispatchMode; label: string; desc: string }[] = [
  { value: "steer", label: "引导当前任务", desc: "补充当前任务的要求，在下一步生效。" },
  {
    value: "interrupt",
    label: "中断并发送",
    desc: "停止当前任务，待正在执行的操作收尾后处理新消息。",
  },
  { value: "queue", label: "排队发送", desc: "等待当前任务完成，再处理新消息。" },
];

const THEME_OPTIONS: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: "system", label: "跟随系统", icon: <Monitor className="h-3.5 w-3.5" /> },
  { value: "light", label: "浅色", icon: <Sun className="h-3.5 w-3.5" /> },
  { value: "dark", label: "深色", icon: <Moon className="h-3.5 w-3.5" /> },
];

function SettingRow({
  id,
  label,
  desc,
  children,
}: {
  id: string;
  label: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
        </label>
        {desc && (
          <p id={`${id}-desc`} className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {desc}
          </p>
        )}
      </div>
      <div className="shrink-0 sm:w-56">{children}</div>
    </div>
  );
}

function PanelTitle({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="mb-4 flex items-start gap-2">
      <span className="mt-0.5 text-[var(--em-primary)]">{icon}</span>
      <div>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{desc}</p>
      </div>
    </div>
  );
}

export function GeneralTab() {
  const settings = useAppStore((s) => s.settings);
  const [theme, setThemeState] = useState<ThemePref>(getTheme);
  const [saving, setSaving] = useState<string | null>(null);
  const [proxy, setProxy] = useState("");
  const [noProxy, setNoProxy] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    refreshSettings().catch((error) => setLoadError(errorMessage(error, "无法读取设置")));
  }, []);

  useEffect(() => {
    setProxy(settings?.httpProxy ?? "");
    setNoProxy(settings?.noProxy ?? "");
  }, [settings?.httpProxy, settings?.noProxy]);

  async function patch(key: string, body: UpdateSettingsBody, successText?: string) {
    setSaving(key);
    try {
      const { restartRequired } = await updateSettings(body);
      if (restartRequired.length) toast({ title: "已保存，重启后生效", tone: "info" });
      else if (successText) toast({ title: successText, tone: "success" });
    } catch (error) {
      toast({ title: "保存失败", description: errorMessage(error), tone: "error" });
    } finally {
      setSaving(null);
    }
  }

  const proxyDirty = settings
    ? proxy.trim() !== (settings.httpProxy ?? "") || noProxy.trim() !== (settings.noProxy ?? "")
    : false;

  return (
    <SettingsPageLayout className="space-y-4 pb-2">
      <SettingsPagePanel>
        <PanelTitle
          icon={<Palette className="h-4 w-4" />}
          title="外观"
          desc="此设备偏好 · 自动保存，立即生效。"
        />
        <SettingRow id="settings-theme" label="主题" desc="选择浅色、深色，或跟随系统切换。">
          <GlassSelect
            id="settings-theme"
            ariaLabel="主题"
            value={theme}
            options={THEME_OPTIONS}
            onChange={(value) => {
              setTheme(value as ThemePref);
              setThemeState(value as ThemePref);
            }}
          />
        </SettingRow>
      </SettingsPagePanel>

      {!settings ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        >
          {loadError ? (
            <span className="text-destructive">{loadError}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取设置…
            </>
          )}
        </div>
      ) : (
        <>
          <SettingsPagePanel>
            <PanelTitle
              icon={<ShieldCheck className="h-4 w-4" />}
              title="对话与任务"
              desc="新建任务的默认行为 · 修改后立即保存。"
            />
            <div className="space-y-4">
              <SettingRow
                id="settings-permission"
                label="默认权限模式"
                desc={
                  PERMISSION_MODE_OPTIONS.find((o) => o.value === settings.defaultPermissionMode)
                    ?.desc
                }
              >
                <GlassSelect
                  id="settings-permission"
                  ariaLabel="默认权限模式"
                  value={settings.defaultPermissionMode}
                  disabled={saving === "permission"}
                  options={PERMISSION_MODE_OPTIONS}
                  onChange={(value) =>
                    void patch("permission", {
                      defaultPermissionMode: value as AppSettings["defaultPermissionMode"],
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                id="settings-dispatch"
                label="任务进行中发送消息"
                desc={
                  DISPATCH_MODE_OPTIONS.find((o) => o.value === settings.defaultDispatchMode)?.desc
                }
              >
                <GlassSelect
                  id="settings-dispatch"
                  ariaLabel="任务进行中发送消息"
                  value={settings.defaultDispatchMode}
                  disabled={saving === "dispatch"}
                  options={DISPATCH_MODE_OPTIONS}
                  onChange={(value) =>
                    void patch("dispatch", { defaultDispatchMode: value as DispatchMode })
                  }
                />
              </SettingRow>
              <SettingRow
                id="settings-auto-title"
                label="自动生成对话标题"
                desc="第一轮完成后用模型概括一个标题；手动改过的标题不会被覆盖。"
              >
                <div className="flex justify-end">
                  <Switch
                    id="settings-auto-title"
                    checked={settings.autoTitle}
                    disabled={saving === "title"}
                    onCheckedChange={(checked) => void patch("title", { autoTitle: checked })}
                  />
                </div>
              </SettingRow>
            </div>
          </SettingsPagePanel>

          <SettingsPagePanel>
            <PanelTitle
              icon={<Workflow className="h-4 w-4" />}
              title="运行"
              desc="上下文压缩与子代理并发 · 修改后立即保存。"
            />
            <div className="space-y-4">
              <SettingRow
                id="settings-auto-compact"
                label="自动压缩上下文"
                desc="对话接近模型上下文上限时，自动把较早的内容整理为摘要。"
              >
                <div className="flex justify-end">
                  <Switch
                    id="settings-auto-compact"
                    checked={settings.autoCompact}
                    disabled={saving === "compact"}
                    onCheckedChange={(checked) => void patch("compact", { autoCompact: checked })}
                  />
                </div>
              </SettingRow>
              <SettingRow
                id="settings-subagents"
                label="子代理并发上限"
                desc="同时运行的子代理数量（1–16）。"
              >
                <GlassSelect
                  id="settings-subagents"
                  ariaLabel="子代理并发上限"
                  value={String(settings.maxConcurrentSubAgents)}
                  disabled={saving === "subagents"}
                  options={Array.from({ length: 16 }, (_, i) => ({
                    value: String(i + 1),
                    label: `${i + 1} 个`,
                  }))}
                  onChange={(value) =>
                    void patch("subagents", { maxConcurrentSubAgents: Number(value) })
                  }
                />
              </SettingRow>
            </div>
          </SettingsPagePanel>

          <SettingsPagePanel>
            <PanelTitle
              icon={<Globe className="h-4 w-4" />}
              title="网络代理"
              desc="模型请求与技能导入使用的 HTTP(S) 代理；留空则使用系统环境变量。"
            />
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void patch(
                  "proxy",
                  { httpProxy: proxy.trim() || null, noProxy: noProxy.trim() || null },
                  "代理设置已保存",
                );
              }}
            >
              <div>
                <label htmlFor="settings-proxy" className="mb-1.5 block text-[11px] font-medium">
                  代理地址
                </label>
                <Input
                  id="settings-proxy"
                  className="h-9 text-xs md:text-xs"
                  placeholder="http://127.0.0.1:7890"
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </div>
              <div>
                <label htmlFor="settings-no-proxy" className="mb-1.5 block text-[11px] font-medium">
                  不使用代理的地址
                </label>
                <Input
                  id="settings-no-proxy"
                  className="h-9 text-xs md:text-xs"
                  placeholder="localhost,127.0.0.1"
                  value={noProxy}
                  onChange={(e) => setNoProxy(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </div>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  className="text-xs"
                  disabled={!proxyDirty || saving === "proxy"}
                >
                  {saving === "proxy" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  保存代理设置
                </Button>
              </div>
            </form>
          </SettingsPagePanel>
        </>
      )}
      <SettingsPagePanel>
        <PanelTitle
          icon={<Keyboard className="h-4 w-4" />}
          title="快捷键"
          desc="在网页版和桌面版中通用。"
        />
        <div className="em-shortcut-list">
          {shortcutHelp().map((item) => (
            <div key={item.label} className="em-shortcut-row">
              <span>{item.label}</span>
              <span className="flex items-center gap-1">
                {item.keys.map((k) => (
                  <kbd key={k} className="em-kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </SettingsPagePanel>
    </SettingsPageLayout>
  );
}
