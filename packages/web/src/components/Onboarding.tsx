// 首次引导（02 §8）：选择接入方式 → 测试与能力探测（在设置中完成）→ 打开示例工作簿跑一个 3 步任务。
// 可跳过；可在设置 → 关于中重新打开。

import { type ReactNode, useState } from "react";
import { openSample, send, setOnboardingOpen, setSettingsOpen, useApp } from "../store.ts";
import { OB, UI } from "../strings.ts";
import { BrandMark, Icon } from "./Icon.tsx";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import { Card } from "./ui/display.tsx";

type StepState = "done" | "ready" | "locked";

function Step({
  n,
  state,
  title,
  hint,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <li className="onboarding-step flex gap-4 border-b border-border/70 py-5 last:border-0">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border text-xs font-semibold",
          state === "done" && "border-transparent bg-ok-soft text-ok-ink",
          state === "ready" && "border-primary bg-primary text-primary-foreground shadow-xs",
          state === "locked" && "border-border text-muted-foreground",
        )}
      >
        {state === "done" ? <Icon name="check" size="xs" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <strong
          className={cn("text-sm font-semibold", state === "locked" && "text-muted-foreground")}
        >
          {title}
        </strong>
        <p className="text-sm leading-6 text-muted-foreground">{hint}</p>
        {children}
      </div>
    </li>
  );
}

export function Onboarding() {
  const hasModelProfile = useApp((s) => s.hasModelProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [samplePath, setSamplePath] = useState<string | null>(null);

  return (
    <Card
      asChild
      elevation="flat"
      className="onboarding-studio flex flex-col gap-5 rounded-none border-transparent p-0 motion-safe:animate-surface-in"
    >
      <section aria-label={OB.title}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandMark className="size-8" />
            <h2 className="text-xl font-semibold tracking-tight">{OB.title}</h2>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setOnboardingOpen(false)}>
            {OB.skip}
          </Button>
        </div>
        <div className="onboarding-layout">
          <div className="onboarding-intro">
            <h1>{UI.onboardingTitle}</h1>
            <p>{UI.onboardingHint}</p>
            <div className="onboarding-privacy">
              <Icon name="monitor" size="lg" />
              <strong>{UI.localFiles}</strong>
              <p>{UI.privacyHint}</p>
            </div>
          </div>
          <ol className="onboarding-steps flex flex-col">
            <Step
              n={1}
              state={hasModelProfile ? "done" : "ready"}
              title={OB.step1}
              hint={OB.step1Hint}
            >
              <div className="mt-1 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setSettingsOpen(true, "models")}>
                  {OB.addKey}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSettingsOpen(true, "accounts")}
                >
                  {OB.loginSubscription}
                </Button>
              </div>
            </Step>
            <Step
              n={2}
              state={hasModelProfile ? "ready" : "locked"}
              title={OB.step2}
              hint={OB.step2Hint}
            />
            <Step
              n={3}
              state={samplePath ? "done" : hasModelProfile ? "ready" : "locked"}
              title={OB.step3}
              hint={OB.step3Hint}
            >
              <div className="mt-1 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void openSample()
                      .then(setSamplePath)
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {OB.openSample}
                </Button>
                {samplePath && hasModelProfile && (
                  <Button
                    size="sm"
                    onClick={() => {
                      void send(OB.samplePrompt(samplePath)).catch(() => {});
                      setOnboardingOpen(false);
                    }}
                  >
                    {OB.tryTask}
                  </Button>
                )}
              </div>
              {error && (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </Step>
          </ol>
        </div>
      </section>
    </Card>
  );
}
