import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Crown, KeyRound, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { buildProviderGuides, type ProviderGuide } from "../provider-guides";
import { ProviderMark } from "./ProviderMark";

const smoothEase: [number, number, number, number] = [0.4, 0, 0.2, 1];

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.08 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: smoothEase } },
};

function ProviderCard({
  provider,
  onSelect,
}: {
  provider: ProviderGuide;
  onSelect: (provider: ProviderGuide) => void;
}) {
  return (
    <motion.button
      variants={cardVariants}
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.985 }}
      onClick={() => onSelect(provider)}
      className={`em-onboarding-provider-card${provider.recommended ? " is-recommended" : ""}`}
      type="button"
      aria-label={`使用 ${provider.label}`}
    >
      <span className="em-onboarding-provider-logo">
        <ProviderMark id={provider.id} />
      </span>
      <span className="em-onboarding-provider-copy">
        <span className="em-onboarding-provider-title">
          {provider.label}
          {provider.recommended && (
            <span className="em-onboarding-recommended">
              <Crown aria-hidden="true" /> 推荐
            </span>
          )}
        </span>
        <span className="em-onboarding-provider-description">{provider.description}</span>
        <span className="em-onboarding-provider-pricing">{provider.pricing}</span>
      </span>
      <ArrowRight className="em-onboarding-provider-arrow" aria-hidden="true" />
    </motion.button>
  );
}

interface ProviderSelectStepProps {
  onSelect: (provider: ProviderGuide) => void;
  onBack: () => void;
}

export function ProviderSelectStep({ onSelect, onBack }: ProviderSelectStepProps) {
  const providers = useAppStore((s) => s.providers);
  const guides = useMemo(() => buildProviderGuides(providers), [providers]);
  const oauthGuides = guides.filter((p) => p.auth === "subscription");
  const apiGuides = guides.filter((p) => p.auth !== "subscription");

  return (
    <div className="em-onboarding-step em-onboarding-provider-select">
      <div className="em-onboarding-step-heading">
        <Button variant="ghost" size="sm" onClick={onBack} className="em-onboarding-back-button">
          <ArrowLeft aria-hidden="true" />
          返回
        </Button>
        <div className="em-onboarding-eyebrow">第 2 步 · 选择连接方式</div>
        <h2 tabIndex={-1}>连接一个 AI 模型</h2>
        <p>
          已有订阅账号可直接浏览器授权，也可以使用供应商 API Key
          连接。之后可在设置中随时切换或添加模型。
        </p>
      </div>

      {oauthGuides.length > 0 && (
        <section aria-label="订阅授权供应商">
          <div className="em-onboarding-eyebrow flex items-center gap-1.5 mb-2">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            订阅授权 · 无需 API Key
          </div>
          <motion.div
            className="em-onboarding-provider-grid"
            variants={containerVariants}
            initial="hidden"
            animate="show"
          >
            {oauthGuides.map((provider) => (
              <ProviderCard key={provider.id} provider={provider} onSelect={onSelect} />
            ))}
          </motion.div>
        </section>
      )}

      <section aria-label="API Key 供应商" className="mt-4">
        <div className="em-onboarding-eyebrow flex items-center gap-1.5 mb-2">
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          API Key 供应商
        </div>
        {apiGuides.length === 0 && (
          <p className="text-sm text-muted-foreground">正在读取供应商列表…</p>
        )}
        <motion.div
          className="em-onboarding-provider-grid"
          variants={containerVariants}
          initial="hidden"
          animate="show"
          aria-label="AI 模型供应商"
        >
          {apiGuides.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} onSelect={onSelect} />
          ))}
        </motion.div>
      </section>
    </div>
  );
}
