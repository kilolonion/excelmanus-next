import type { Device } from "@excelmanus/protocol";
import { Laptop, Loader2, LogOut, MonitorSmartphone, ShieldCheck, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isDesktop, signOut } from "@/lib/backend/api";
import { listDevices, revokeDevice } from "@/lib/settings/devices";
import { SettingsPageLayout, SettingsPagePanel } from "./SettingsPageLayout";

const KIND_LABELS: Record<string, string> = {
  local: "本机",
  desktop: "桌面版",
  browser: "浏览器",
  mobile: "手机",
};

function formatTime(ts: string | null): string {
  if (!ts) return "从未";
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function AccessTab() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const activeRead = useRef(true);
  const readSequence = useRef(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!activeRead.current) return;
    const request = ++readSequence.current;
    const current = () => activeRead.current && readSequence.current === request;
    setLoading(true);
    setError("");
    try {
      const result = await listDevices();
      if (current()) setDevices(result);
    } catch (err) {
      if (current()) setError(errorMessage(err, "无法读取设备列表"));
    } finally {
      if (current()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRead.current = true;
    void load();
    return () => {
      activeRead.current = false;
      readSequence.current++;
    };
  }, [load]);

  async function revoke(device: Device) {
    const ok = await confirmAction({
      title: `吊销「${device.name}」`,
      description: "吊销后该设备的访问令牌立即失效，需要重新配对才能连接。",
      confirmLabel: "吊销",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(device.id);
    try {
      await revokeDevice(device.id);
      await load();
    } catch (err) {
      toast({ title: "吊销失败", description: errorMessage(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    const ok = await confirmAction({
      title: "退出浏览器登录",
      description: "退出后此浏览器需要重新连接本机服务才能继续使用。",
      confirmLabel: "退出",
    });
    if (!ok) return;
    setBusy("logout");
    await signOut();
  }

  const active = devices?.filter((d) => !d.revokedAt) ?? [];
  const revoked = devices?.filter((d) => d.revokedAt) ?? [];

  return (
    <SettingsPageLayout className="space-y-4 pb-2">
      <SettingsPagePanel>
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-[var(--em-primary)]" />
          <div>
            <h3 className="text-[13px] font-semibold">访问方式</h3>
            <p className="mt-1 text-[11px] leading-[1.65] text-muted-foreground">
              {isDesktop()
                ? "桌面版通过内置令牌直接连接，无需登录。"
                : "此浏览器通过本机会话 Cookie 访问，令牌不会出现在地址栏或本地存储中。"}
            </p>
          </div>
        </div>
        {!isDesktop() && (
          <div className="mt-4 flex justify-end border-t border-border/60 pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => void logout()}
              disabled={busy === "logout"}
            >
              {busy === "logout" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              退出浏览器登录
            </Button>
          </div>
        )}
      </SettingsPagePanel>

      <SettingsPagePanel>
        <div className="mb-3 flex items-start gap-2">
          <MonitorSmartphone className="mt-0.5 h-4 w-4 text-[var(--em-primary)]" />
          <div>
            <h3 className="text-[13px] font-semibold">已授权设备</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              持有访问令牌的设备。不再使用或丢失的设备请及时吊销。
            </p>
          </div>
        </div>
        {error && (
          <div role="alert" className="mb-2 space-y-2 text-xs text-destructive">
            <p>{error}</p>
            {devices && <p className="text-muted-foreground">以下保留上次读取的列表。</p>}
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重新读取列表
            </Button>
          </div>
        )}
        {!devices && loading ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="ml-2 text-xs">正在读取设备列表…</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {active.map((device) => (
              <div
                key={device.id}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
              >
                <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                    <span className="truncate">{device.name}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {KIND_LABELS[device.kind] ?? device.kind}
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    添加于 {formatTime(device.createdAt)} · 最近使用 {formatTime(device.lastSeenAt)}
                  </p>
                </div>
                {device.kind !== "local" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 gap-1 text-xs text-destructive"
                    onClick={() => void revoke(device)}
                    disabled={busy === device.id}
                  >
                    {busy === device.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldOff className="h-3.5 w-3.5" />
                    )}
                    吊销
                  </Button>
                )}
              </div>
            ))}
            {revoked.length > 0 && (
              <details className="pt-1">
                <summary className="cursor-pointer text-[11px] text-muted-foreground">
                  已吊销 {revoked.length} 台
                </summary>
                <div className="mt-1.5 space-y-1">
                  {revoked.map((device) => (
                    <p
                      key={device.id}
                      className="rounded-md bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground"
                    >
                      {device.name} · 吊销于 {formatTime(device.revokedAt)}
                    </p>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </SettingsPagePanel>
    </SettingsPageLayout>
  );
}
