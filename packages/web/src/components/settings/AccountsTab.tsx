// 设置 → 订阅账号：ChatGPT/Codex 浏览器授权与设备码登录（09 §4），登录后自动建档案。

import type { LoginAttempt } from "@excelmanus/protocol";
import { useEffect, useRef, useState } from "react";
import { apiClientOf, refreshProfiles } from "../../store.ts";
import { ST } from "../../strings.ts";
import { Icon, ProviderLabel, ProviderLogo } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { Alert, Badge, Card } from "../ui/display.tsx";
import { Spinner } from "../ui/spinner.tsx";
import {
  Empty,
  Feedback,
  ItemCard,
  LoadStatus,
  Section,
  useAction,
  useConfirmDelete,
  useLoad,
} from "./common.tsx";

const linkCls = "text-read-ink underline-offset-2 hover:underline break-all";

export function AccountsTab() {
  const api = apiClientOf();
  const accounts = useLoad(() => api.listAccounts(), []);
  const [attempt, setAttempt] = useState<LoginAttempt | null>(null);
  const act = useAction();
  const confirmDelete = useConfirmDelete();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const poll = (a: LoginAttempt) => {
    timer.current = setTimeout(
      () => {
        api
          .pollLogin("chatgpt", a.attemptId)
          .then(({ attempt: next }) => {
            setAttempt(next);
            if (next.status === "pending") poll(next);
            else if (next.status === "succeeded") {
              accounts.reload();
              void refreshProfiles();
            }
          })
          .catch(() => poll(a));
      },
      a.method === "device" ? 3000 : 1500,
    );
  };

  const start = (method: "browser" | "device") =>
    void act.run(async () => {
      if (timer.current) clearTimeout(timer.current);
      const { attempt: a } = await api.startLogin("chatgpt", method);
      setAttempt(a);
      if (a.authorizeUrl) window.open(a.authorizeUrl, "_blank", "noopener,noreferrer");
      poll(a);
    }, ST.loginWaiting);

  return (
    <Section
      title={<ProviderLabel provider="chatgpt">{ST.subscriptionProviderName}</ProviderLabel>}
      hint={ST.subscriptionNote}
    >
      <div className="settings-account-actions flex flex-wrap gap-2">
        <Button disabled={act.busy} onClick={() => start("browser")}>
          <Icon name="monitor" size="xs" />
          {ST.loginBrowser}
        </Button>
        <Button variant="outline" disabled={act.busy} onClick={() => start("device")}>
          <Icon name="keyboard" size="xs" />
          {ST.loginDevice}
        </Button>
      </div>
      <Feedback msg={attempt ? null : act.msg} />
      {attempt && (
        <Card
          className="settings-login-state flex flex-col gap-3 border-border/70 bg-muted/30 p-5"
          aria-live="polite"
        >
          {attempt.status === "pending" && attempt.method === "browser" && attempt.authorizeUrl && (
            <p className="flex items-center gap-2 text-sm">
              <Spinner size="xs" />
              {ST.loginWaiting}
              <a
                className={linkCls}
                href={attempt.authorizeUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {ST.loginOpen}
              </a>
            </p>
          )}
          {attempt.status === "pending" && attempt.method === "device" && (
            <>
              <p className="text-sm">{ST.deviceCodeHint}</p>
              <a
                className={`${linkCls} text-sm`}
                href={attempt.verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {attempt.verificationUrl}
              </a>
              <p className="rounded-md bg-muted py-3 text-center font-mono text-2xl tracking-[0.2em]">
                {attempt.userCode}
              </p>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size="xs" />
                {ST.loginWaiting}
              </p>
            </>
          )}
          {attempt.status === "succeeded" && (
            <Alert tone="ok" layout="inline">
              {ST.loginOk(attempt.account?.email ?? attempt.account?.label ?? "")}
            </Alert>
          )}
          {attempt.status === "failed" && (
            <Alert tone="err" layout="inline">
              {ST.loginFailed}：{attempt.error}
            </Alert>
          )}
          {attempt.status === "expired" && (
            <Alert tone="err" layout="inline">
              {ST.loginExpired}
            </Alert>
          )}
        </Card>
      )}
      <LoadStatus data={accounts.data} error={accounts.error} />
      <div className="settings-list flex flex-col gap-3">
        {accounts.data?.items.length === 0 && <Empty />}
        {accounts.data?.items.map((a) => (
          <ItemCard key={a.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground-secondary">
                  <ProviderLogo provider={a.provider} size="lg" />
                </span>
                <strong className="truncate text-[15px] font-semibold">{a.label}</strong>
                {a.plan && (
                  <Badge tone="neutral">
                    {ST.plan} {a.plan}
                  </Badge>
                )}
              </div>
              <Button
                size="sm"
                variant="destructive-ghost"
                onClick={async () => {
                  const ok = await confirmDelete(ST.confirmTitle.logout(a.label), {
                    description: ST.confirmTitle.logoutBody,
                    confirmLabel: ST.logout,
                  });
                  if (ok)
                    void act.run(async () => {
                      await api.deleteAccount(a.id);
                      accounts.reload();
                      void refreshProfiles();
                    });
                }}
              >
                {ST.logout}
              </Button>
            </div>
            {a.expiresAt && (
              <p className="text-xs text-muted-foreground">
                {ST.expires} {new Date(a.expiresAt).toLocaleString()}
              </p>
            )}
            {a.error && (
              <Alert tone="err" layout="inline">
                {ST.relogin}：{a.error}
              </Alert>
            )}
          </ItemCard>
        ))}
      </div>
    </Section>
  );
}
