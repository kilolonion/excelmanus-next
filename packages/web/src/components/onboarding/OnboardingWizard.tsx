// 首次使用向导：没有任何模型档案时显示（client-layout 控制挂载），以创建模型档案结束。
// 跳过只在本次浏览器会话内生效；下次打开仍会提示连接模型。

import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "framer-motion";
import { Check, Circle } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { openWorkspaceFile } from "@/lib/open-file";
import { refreshProfiles, useAppStore } from "@/stores/app-store";
import { useUIStore } from "@/stores/ui-store";
import type { ProviderGuide } from "./provider-guides";
import { CompletionStep } from "./steps/CompletionStep";
import { ProviderGuideStep } from "./steps/ProviderGuideStep";
import { ProviderSelectStep } from "./steps/ProviderSelectStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { useGuideViewport } from "./useGuideViewport";

const LABELS = ["欢迎", "选择模型", "连接模型", "开始使用"];
const DISMISS_KEY = "excelmanus.onboarding-dismissed";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // 存储不可用时只在本次挂载内关闭
  }
}

export function OnboardingWizard() {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const viewport = useGuideViewport();
  const [step, setStep] = useState(0);
  /** 实际完成过的步骤：跳过的步骤不打勾。 */
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const [direction, setDirection] = useState(1);
  const [selectedProvider, setSelectedProvider] = useState<ProviderGuide | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const hasProviders = useAppStore((s) => s.providers.length > 0);

  useEffect(() => {
    if (!hasProviders) void refreshProfiles().catch(() => undefined);
  }, [hasProviders]);

  const skipAll = () => {
    writeDismissed();
    setDismissed(true);
  };
  // 刷新档案列表：有档案后 client-layout 卸载向导。
  const finish = async (samplePath?: string) => {
    setFinishing(true);
    if (samplePath) openWorkspaceFile(samplePath);
    try {
      await refreshProfiles();
    } catch {
      // 刷新失败也关闭向导，档案列表会在下次同步时更新
    } finally {
      setFinishing(false);
    }
    if (!useAppStore.getState().hasModelProfile) skipAll();
  };
  const openSettings = () => useUIStore.getState().openSettings("model");

  const navigate = (next: number, completed = false) => {
    if (completed) setDone((d) => new Set(d).add(step));
    setDirection(next > step ? 1 : -1);
    setStep(next);
  };
  const skipStep = () => navigate(step === 0 ? 1 : 3);

  if (dismissed) return null;

  return (
    <MotionConfig reducedMotion="user">
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) skipAll();
        }}
      >
        <Dialog.Portal>
          <Dialog.Content
            ref={rootRef}
            aria-describedby={undefined}
            tabIndex={-1}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              skipAll();
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              rootRef.current?.focus();
            }}
            className="em-onboarding fixed z-[200] flex flex-col overflow-hidden outline-none"
            style={{
              top: viewport.top,
              left: viewport.left,
              width: viewport.width,
              height: viewport.height,
            }}
          >
            <Dialog.Title className="sr-only">ExcelManus 首次使用设置</Dialog.Title>
            <header className="em-onboarding-header flex-shrink-0">
              <div className="em-onboarding-header-inner">
                <div className="em-onboarding-brand">
                  <div className="em-onboarding-brand-mark" aria-hidden="true">
                    <span style={{ backgroundImage: "url('/brand-icon.png')" }} />
                  </div>
                  <div>
                    <p className="em-onboarding-brand-name">ExcelManus</p>
                    <p className="em-onboarding-brand-caption">按你的节奏开始</p>
                  </div>
                </div>
                <nav className="em-onboarding-progress" aria-label="设置进度">
                  <ol className="em-onboarding-progress-track">
                    {LABELS.map((label, i) => (
                      <li
                        key={label}
                        aria-current={i === step ? "step" : undefined}
                        className={`em-onboarding-progress-item${i === step ? " is-active" : ""}${done.has(i) ? " is-complete" : ""}`}
                      >
                        <span className="em-onboarding-progress-dot">
                          {done.has(i) ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <Circle aria-hidden="true" />
                          )}
                        </span>
                        <span className="em-onboarding-progress-label">{label}</span>
                      </li>
                    ))}
                  </ol>
                  <span className="em-onboarding-progress-count" aria-live="polite">
                    {step + 1} / 4 · {LABELS[step]}
                  </span>
                </nav>
                <div className="em-onboarding-header-actions">
                  {step < 3 && (
                    <button type="button" onClick={skipStep} className="em-onboarding-skip">
                      跳过此步
                    </button>
                  )}
                  <button type="button" onClick={skipAll} className="em-onboarding-skip">
                    结束引导
                  </button>
                </div>
              </div>
            </header>
            <div ref={contentRef} className="em-onboarding-content flex-1 min-h-0 overflow-y-auto">
              <AnimatePresence
                mode="wait"
                initial={false}
                onExitComplete={() => contentRef.current?.scrollTo(0, 0)}
              >
                <motion.div
                  key={step}
                  initial={{ opacity: 0, x: reduceMotion ? 0 : direction * 18 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: reduceMotion ? 0 : direction * -12 }}
                  transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
                  className="em-onboarding-step-shell"
                  onAnimationComplete={(definition) => {
                    if (
                      typeof definition === "object" &&
                      "opacity" in definition &&
                      definition.opacity === 1
                    ) {
                      contentRef.current
                        ?.querySelector<HTMLElement>("h1, h2")
                        ?.focus({ preventScroll: true });
                    }
                  }}
                >
                  {step === 0 && (
                    <WelcomeStep onNext={() => navigate(1, true)} onSkip={() => navigate(3)} />
                  )}
                  {step === 1 && (
                    <ProviderSelectStep
                      onSelect={(provider) => {
                        setSelectedProvider(provider);
                        navigate(2, true);
                      }}
                      onBack={() => navigate(0)}
                    />
                  )}
                  {step === 2 && selectedProvider && (
                    <ProviderGuideStep
                      key={selectedProvider.id}
                      provider={selectedProvider}
                      onBack={() => navigate(1)}
                      onComplete={(id) => {
                        setProfileId(id);
                        navigate(3, true);
                      }}
                      onSkip={() => navigate(3)}
                    />
                  )}
                  {step === 3 && (
                    <CompletionStep
                      profileId={profileId}
                      finishing={finishing}
                      onFinish={(samplePath) => void finish(samplePath)}
                      onOpenSettings={openSettings}
                      onBack={() => navigate(1)}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </MotionConfig>
  );
}
