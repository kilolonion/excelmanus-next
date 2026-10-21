// 订阅账号：ChatGPT（Codex）账号登录、状态与断开；登录成功后服务端自动创建模型档案。

import type { Account, LoginAttempt } from "@excelmanus/protocol";
import { Copy, ExternalLink, Loader2, LogOut, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { ApiError, api, desktop, errorMessage } from "@/lib/backend/api";
import {
  clearPendingLogin,
  loginFailure,
  loginStorage,
  preferredLoginMethod,
  readPendingLogin,
  savePendingLogin,
} from "@/lib/subscription-login";
import { onAppEvent, refreshProfiles, useAppStore } from "@/stores/app-store";
import { SubscriptionAccountCard } from "./SubscriptionAccountCard";

const PROVIDER = "chatgpt";
const POLL_MS = 2500;

function openLink(url: string) {
  const bridge = desktop();
  if (bridge) bridge.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function LoginProgress({ attempt, onCancel }: { attempt: LoginAttempt; onCancel: () => void }) {
  const [copyMessage, setCopyMessage] = useState("");
  const url = attempt.method === "device" ? attempt.verificationUrl : attempt.authorizeUrl;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/25 p-3">
      <div className="flex items-start gap-2" role="status">
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
        <div className="space-y-1 text-xs">
          <p className="font-medium">
            {attempt.method === "device"
              ? "请在浏览器中输入验证码完成登录"
              : "请在登录窗口中完成授权"}
          </p>
          <p className="leading-relaxed text-muted-foreground">
            授权成功后，这里的账号和模型列表会自动更新。
          </p>
        </div>
      </div>
      {attempt.method === "browser" && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          回调地址是
          localhost:1455，只能回到浏览器所在的电脑。若授权后页面无法连接或这里一直等待，请取消并改用设备码；远程服务器不会自动收到这个回调。
        </p>
      )}
      {attempt.userCode && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="select-all rounded-lg border bg-background px-3 py-2 text-lg font-semibold tracking-widest">
            {attempt.userCode}
          </code>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(attempt.userCode ?? "");
                setCopyMessage("验证码已复制");
              } catch {
                setCopyMessage("无法自动复制，请选中验证码手动复制。");
              }
            }}
          >
            <Copy className="size-3" />
            复制验证码
          </Button>
          {copyMessage && (
            <span role="status" className="text-xs text-muted-foreground">
              {copyMessage}
            </span>
          )}
        </div>
      )}
      {url && (
        <button
          type="button"
          onClick={() => openLink(url)}
          className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <ExternalLink className="size-3" />
          打开登录页{attempt.userCode ? "并输入验证码" : ""}
        </button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-8 text-xs text-muted-foreground"
        onClick={onCancel}
      >
        取消登录
      </Button>
    </div>
  );
}

export function SubscriptionPanel() {
  const primaryMethod = preferredLoginMethod(
    typeof window === "undefined" ? "" : window.location.hostname,
    Boolean(desktop()),
  );
  const profiles = useAppStore((s) => s.profiles);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState<LoginAttempt | null>(null);
  const [starting, setStarting] = useState<"browser" | "device" | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [showDevice, setShowDevice] = useState(false);
  const pollToken = useRef(0);

  const load = useCallback(async () => {
    try {
      const { items } = await api().listAccounts();
      setAccounts(items.filter((a) => a.provider === PROVIDER));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      pollToken.current += 1;
    };
  }, [load]);

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === "accounts.changed") void load();
      }),
    [load],
  );

  const finish = useCallback(
    async (done: LoginAttempt) => {
      clearPendingLogin(loginStorage());
      setError("");
      setAttempt(null);
      if (done.status === "succeeded") {
        const count = done.profileIds?.length ?? 0;
        toast({
          title: "ChatGPT 账号已连接",
          description: count ? `已自动添加 ${count} 个模型` : undefined,
          tone: "success",
        });
        await Promise.all([load(), refreshProfiles().catch(() => undefined)]);
      } else {
        setError(
          done.error || (done.status === "expired" ? "登录已超时，请重试。" : "登录失败，请重试。"),
        );
      }
    },
    [load],
  );

  const poll = useCallback(
    async (attemptId: string, token: number) => {
      while (pollToken.current === token) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (pollToken.current !== token) return;
        try {
          const res = await api().pollLogin(PROVIDER, attemptId);
          if (pollToken.current !== token) return;
          if (res.attempt.status !== "pending") {
            await finish(res.attempt);
            return;
          }
          setError("");
          setAttempt(res.attempt);
        } catch (err) {
          if (pollToken.current !== token) return;
          if (err instanceof ApiError && err.status === 404) {
            clearPendingLogin(loginStorage());
            setAttempt(null);
          }
          setError(
            `${errorMessage(err, "登录状态查询失败")}。若授权页已成功，请重新检查连接状态。`,
          );
          return;
        }
      }
    },
    [finish],
  );

  useEffect(() => {
    const saved = readPendingLogin(loginStorage());
    if (saved) {
      setAttempt({ attemptId: saved.attemptId, method: saved.method, status: "pending" });
      void poll(saved.attemptId, ++pollToken.current);
    }
  }, [poll]);

  async function start(method: "browser" | "device") {
    setError("");
    setStarting(method);
    const token = ++pollToken.current;
    try {
      const res = await api().startLogin(PROVIDER, method);
      savePendingLogin(loginStorage(), res.attempt);
      if (pollToken.current !== token) return;
      setAttempt(res.attempt);
      const url = method === "device" ? res.attempt.verificationUrl : res.attempt.authorizeUrl;
      if (url) openLink(url);
      void poll(res.attempt.attemptId, token);
    } catch (err) {
      setError(loginFailure(errorMessage(err, "无法开始登录"), method));
    } finally {
      setStarting(null);
    }
  }

  function cancel() {
    clearPendingLogin(loginStorage());
    pollToken.current += 1;
    setAttempt(null);
  }

  async function remove(account: Account) {
    const linked = profiles.filter((p) => p.accountId === account.id).length;
    const ok = await confirmAction({
      title: "断开 ChatGPT 账号",
      description: linked
        ? `使用该账号的 ${linked} 个模型将无法继续使用，需要重新登录。`
        : "断开后需要重新登录才能使用订阅模型。",
      confirmLabel: "断开",
      tone: "danger",
    });
    if (!ok) return;
    setRemoving(account.id);
    try {
      await api().deleteAccount(account.id);
      await Promise.all([load(), refreshProfiles().catch(() => undefined)]);
    } catch (err) {
      toast({ title: "断开失败", description: errorMessage(err), tone: "error" });
    } finally {
      setRemoving(null);
    }
  }

  const list = accounts ?? [];
  const healthy = list.filter((a) => !a.error);
  const status =
    accounts === null
      ? undefined
      : healthy.length
        ? "connected"
        : list.length
          ? "expired"
          : "disconnected";
  const modelCount = profiles.filter((p) => p.provider === PROVIDER).length;
  const busy = Boolean(attempt || starting);

  return (
    <div className="flex flex-col gap-3">
      <SubscriptionAccountCard
        provider="openai"
        title="ChatGPT 订阅（Codex）"
        description="使用 ChatGPT Plus / Pro 订阅连接，无需 API Key"
        account={healthy
          .map((a) => [a.email ?? a.label, a.plan].filter(Boolean).join(" · "))
          .join("，")}
        status={status}
        loading={accounts === null && !loadError}
        busy={busy}
        modelCount={modelCount}
        error={error}
        statusError={loadError}
        onRetry={() => void load()}
      >
        {list.length > 0 && (
          <div className="space-y-1.5">
            {list.map((account) => (
              <div
                key={account.id}
                className="flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2"
              >
                <div
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${account.error ? "bg-amber-500" : "bg-green-500"}`}
                />
                <div className="min-w-0 flex-1 text-xs">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    <span className="truncate">{account.email ?? account.label}</span>
                    {account.plan && (
                      <Badge variant="secondary" className="text-[10px] capitalize">
                        {account.plan}
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {profiles.filter((p) => p.accountId === account.id).length} 个模型
                    {account.expiresAt
                      ? ` · 授权有效期至 ${new Date(account.expiresAt).toLocaleString("zh-CN")}`
                      : ""}
                  </p>
                  {account.error && (
                    <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                      {account.error}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 gap-1 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
                  onClick={() => void remove(account)}
                  disabled={removing === account.id || busy}
                >
                  {removing === account.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <LogOut className="h-3 w-3" />
                  )}
                  断开
                </Button>
              </div>
            ))}
          </div>
        )}

        {attempt ? (
          <>
            <LoginProgress attempt={attempt} onCancel={cancel} />
            {error && (
              <Button
                variant="outline"
                onClick={() => {
                  setError("");
                  void poll(attempt.attemptId, ++pollToken.current);
                }}
              >
                重新检查连接状态
              </Button>
            )}
          </>
        ) : (
          <>
            {list.length === 0 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                登录后自动添加可用模型。订阅接口非公开，可用模型以登录后的发现结果为准。
              </p>
            )}
            <Button
              size="sm"
              className="h-10 w-full gap-1.5 text-xs font-medium text-white"
              style={{ backgroundColor: "var(--em-primary)" }}
              onClick={() => void start(primaryMethod)}
              disabled={busy}
            >
              {starting === primaryMethod ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : list.length ? (
                <Plus className="h-3 w-3" />
              ) : (
                <ExternalLink className="h-3 w-3" />
              )}
              {list.length
                ? status === "expired"
                  ? "重新登录 ChatGPT"
                  : "登录其他 ChatGPT 账号"
                : "使用 ChatGPT 账号登录"}
            </Button>
            {primaryMethod === "device" && (
              <p className="text-xs text-muted-foreground">
                当前为远程访问，将使用设备码授权，无需本机回调端口。在 ChatGPT
                安全设置中启用设备码授权后继续。
              </p>
            )}
            <div>
              <button
                type="button"
                aria-expanded={showDevice}
                onClick={() => setShowDevice((v) => !v)}
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {showDevice ? "▾ 收起备选方式" : "▸ 其他连接方式"}
              </button>
              {showDevice && (
                <div className="mt-1.5 space-y-1">
                  <p className="text-[11px] text-muted-foreground">
                    {primaryMethod === "browser"
                      ? "本机回调失败时，可改用设备码在任意设备上登录。"
                      : "浏览器回调仍可选，但 localhost:1455 指向浏览器所在电脑；未配置回调转发时无法返回远程服务器，建议使用设备码。"}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 w-full text-xs"
                    onClick={() => void start(primaryMethod === "browser" ? "device" : "browser")}
                    disabled={busy}
                  >
                    {starting === "device" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    {primaryMethod === "browser" ? "使用设备码登录" : "使用浏览器回调登录"}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </SubscriptionAccountCard>
    </div>
  );
}
