import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  XCircle,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/backend/api";
import { useUIStore } from "@/stores/ui-store";
import type { ProviderGuide } from "../provider-guides";
import { ProviderMark } from "./ProviderMark";

async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Sandboxed webviews may deny the Clipboard API; use the legacy fallback below.
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

interface ProviderGuideStepProps {
  provider: ProviderGuide;
  onBack: () => void;
  onComplete: (profileId: string) => void;
  onSkip?: () => void;
}

export function ProviderGuideStep({
  provider,
  onBack,
  onComplete,
  onSkip,
}: ProviderGuideStepProps) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedGuide, setExpandedGuide] = useState(true);
  const [copied, setCopied] = useState(false);
  const needsKey = provider.auth === "api_key";

  const connection = useCallback(
    () => ({
      ...(needsKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    }),
    [apiKey, baseUrl, needsKey],
  );

  // 测试：用填写的凭据拉取一次供应商的模型列表，不创建档案。
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api().listProviderModels(provider.id, connection());
      const known = res.items.length === 0 || res.items.some((m) => m.id === model.trim());
      setTestResult(
        known
          ? { ok: true }
          : { ok: true, error: `连接成功，但供应商未列出模型「${model.trim()}」，请确认模型 ID。` },
      );
    } catch (e) {
      setTestResult({ ok: false, error: errorMessage(e, "测试失败") });
    } finally {
      setTesting(false);
    }
  }, [connection, model, provider.id]);

  // 保存为默认模型档案；向导在完成页刷新档案列表后关闭。
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const { profile } = await api().createModelProfile({
        name: `${provider.label} · ${model.trim()}`,
        provider: provider.id,
        model: model.trim(),
        ...connection(),
        isDefault: true,
      });
      onComplete(profile.id);
    } catch (e) {
      setTestResult({ ok: false, error: errorMessage(e, "保存失败") });
    } finally {
      setSaving(false);
    }
  }, [connection, model, onComplete, provider.id, provider.label]);

  const handleCopyUrl = useCallback(async () => {
    if (!provider.purchaseUrl) return;
    const didCopy = await copyText(provider.purchaseUrl);
    setCopied(didCopy);
    window.setTimeout(() => setCopied(false), 2000);
  }, [provider.purchaseUrl]);

  // 订阅账号在设置 → 模型中登录；登录成功后服务端自动创建模型档案，向导随之关闭。
  const handleGoOAuth = useCallback(() => {
    useUIStore.getState().openSettings("model");
  }, []);

  const isOAuthProvider = provider.auth === "subscription";
  const canProceed =
    model.trim().length > 0 &&
    (!needsKey || apiKey.trim().length > 0) &&
    (!provider.requiresBaseUrl || baseUrl.trim().length > 0);

  return (
    <div className="em-onboarding-step em-onboarding-provider-guide">
      <div className="em-onboarding-guide-heading">
        <Button variant="ghost" size="sm" onClick={onBack} className="em-onboarding-back-button">
          <ArrowLeft aria-hidden="true" />
          返回供应商列表
        </Button>
        <div className="em-onboarding-provider-heading">
          <span className="em-onboarding-provider-logo is-large">
            <ProviderMark id={provider.id} />
          </span>
          <div>
            <div className="em-onboarding-eyebrow">第 3 步 · 建立连接</div>
            <h2 tabIndex={-1}>配置 {provider.label}</h2>
            <p>{provider.description}</p>
          </div>
        </div>
      </div>

      <div className="em-onboarding-guide-layout">
        <section className="em-onboarding-guide-card" aria-labelledby="provider-guide-title">
          <button
            type="button"
            className="em-onboarding-guide-toggle"
            onClick={() => setExpandedGuide((expanded) => !expanded)}
            aria-expanded={expandedGuide}
          >
            <span>
              <span className="em-onboarding-guide-kicker">连接前准备</span>
              <strong id="provider-guide-title">
                {isOAuthProvider
                  ? "如何连接订阅"
                  : needsKey
                    ? "如何获取 API Key"
                    : "如何连接本机服务"}
              </strong>
            </span>
            {expandedGuide ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronRight aria-hidden="true" />
            )}
          </button>
          <AnimatePresence initial={false}>
            {expandedGuide && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="em-onboarding-guide-steps">
                  {provider.steps.map((guideStep, i) => (
                    <div key={i} className="em-onboarding-guide-step">
                      <span>{i + 1}</span>
                      <div>
                        <strong>{guideStep.title.replace(/^\d+\.\s*/, "")}</strong>
                        <p>{guideStep.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {provider.purchaseUrl && (
                  <div className="em-onboarding-guide-links">
                    <a href={provider.purchaseUrl} target="_blank" rel="noopener noreferrer">
                      前往 {provider.label}
                      <ExternalLink aria-hidden="true" />
                    </a>
                    <button type="button" onClick={handleCopyUrl}>
                      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      {copied ? "已复制" : "复制链接"}
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        <section className="em-onboarding-config-card" aria-labelledby="provider-config-title">
          <div className="em-onboarding-config-heading">
            <div>
              <span className="em-onboarding-guide-kicker">连接信息</span>
              <h3 id="provider-config-title">
                {isOAuthProvider ? "完成订阅授权" : "填入模型配置"}
              </h3>
            </div>
            <span className="em-onboarding-secure-note">
              <CheckCircle2 aria-hidden="true" /> 私密保存
            </span>
          </div>

          {isOAuthProvider ? (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {provider.label} 使用订阅账号浏览器授权连接，无需填写 API
                Key。点击下方按钮前往「设置 → 模型」完成登录，连接成功后会自动创建模型档案。
              </p>
              <div className="em-onboarding-config-actions">
                <div className="em-onboarding-config-spacer" />
                {onSkip && (
                  <Button variant="ghost" onClick={onSkip}>
                    跳过
                  </Button>
                )}
                <Button onClick={handleGoOAuth} className="em-onboarding-primary-action">
                  <ExternalLink aria-hidden="true" />
                  前往授权
                </Button>
              </div>
              {provider.note && <p className="em-onboarding-config-footnote">{provider.note}</p>}
            </>
          ) : (
            <>
              <label className="em-onboarding-field">
                <span>Model ID</span>
                <Input
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder={provider.model || "填写模型 ID"}
                  autoComplete="off"
                  spellCheck={false}
                  list={`onboarding-models-${provider.id}`}
                />
                {provider.suggestedModels.length > 0 && (
                  <datalist id={`onboarding-models-${provider.id}`}>
                    {provider.suggestedModels.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                )}
              </label>
              <label className="em-onboarding-field">
                <span>Base URL</span>
                <Input
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder={provider.baseUrl || "https://example.com/v1"}
                  autoComplete="url"
                  spellCheck={false}
                />
              </label>
              {needsKey && (
                <label className="em-onboarding-field">
                  <span>API Key</span>
                  <span className="em-onboarding-key-input">
                    <Input
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setTestResult(null);
                      }}
                      type={showKey ? "text" : "password"}
                      placeholder="粘贴你的 API Key"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="API Key"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((shown) => !shown)}
                      aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                    >
                      {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    </button>
                  </span>
                </label>
              )}

              <AnimatePresence initial={false}>
                {testResult && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className={`em-onboarding-test-result ${testResult.ok ? "is-success" : "is-error"}`}
                    role="status"
                  >
                    {testResult.ok ? (
                      <CheckCircle2 aria-hidden="true" />
                    ) : (
                      <XCircle aria-hidden="true" />
                    )}
                    <span>
                      {testResult.ok
                        ? testResult.error || "连接成功，模型可以使用。"
                        : testResult.error || "连接失败，请检查配置。"}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="em-onboarding-config-actions">
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={!canProceed || testing}
                  className="em-onboarding-test-button"
                >
                  {testing ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : testResult?.ok ? (
                    <CheckCircle2 aria-hidden="true" />
                  ) : null}
                  测试连接
                </Button>
                <div className="em-onboarding-config-spacer" />
                {onSkip && (
                  <Button variant="ghost" onClick={onSkip}>
                    跳过
                  </Button>
                )}
                <Button
                  onClick={handleSave}
                  disabled={!canProceed || saving}
                  className="em-onboarding-primary-action"
                >
                  {saving ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <ArrowRight aria-hidden="true" />
                  )}
                  保存并继续
                </Button>
              </div>
              <p className="em-onboarding-config-footnote">
                {provider.note ? `${provider.note}。` : ""}
                配置会保存为默认模型档案，之后可在设置中添加更多模型。
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
