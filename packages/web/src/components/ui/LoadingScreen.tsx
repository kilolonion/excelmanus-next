import { Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import {
  BrandWordmark,
  LoadingBrandMark,
  LoadingProgressBar,
  LoadingStatusSpinner,
} from "@/components/ui/loading-visual";
import { isDesktop } from "@/lib/backend/api";

const SLOW_SECONDS = 15;
const RECOVERY_SECONDS = 30;

function feedbackFor(seconds: number, desktop: boolean) {
  const elapsed =
    seconds < 60
      ? `已等待 ${seconds} 秒`
      : `已等待 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const hint =
    seconds >= RECOVERY_SECONDS
      ? desktop
        ? "启动时间较长，可在「帮助」菜单中查看启动日志。"
        : "等待时间较长，你可以继续等待，或重新加载页面。"
      : seconds >= SLOW_SECONDS
        ? "准备时间比平时稍长，完成后会自动进入。"
        : "准备完成后会自动进入。";
  return { elapsed, hint };
}

const startedAt = Date.now();

interface LoadingScreenProps {
  message?: string;
  error?: string | null;
  /** 错误态的主操作（默认重新加载页面）。 */
  action?: { label: string; onClick: () => void };
}

export function LoadingScreen({ message, error, action }: LoadingScreenProps) {
  const desktop = isDesktop();
  const [seconds, setSeconds] = useState(() => Math.floor((Date.now() - startedAt) / 1000));
  useEffect(() => {
    if (error) return;
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [error]);
  const status = error ?? message ?? "正在初始化...";
  const feedback = feedbackFor(seconds, desktop);

  return (
    <div className="em-splash" data-error={error ? "true" : undefined}>
      <div className="em-splash-glow" aria-hidden="true" />

      <header className="em-splash-header">
        <BrandWordmark />
        <span className="em-splash-tag">智能表格助手</span>
      </header>

      <main className="em-splash-main">
        <LoadingBrandMark />

        <h1 className="em-splash-title">
          {error ? "暂时无法进入工作空间" : "正在准备你的工作空间"}
        </h1>
        <p className="em-splash-subtitle">让繁琐的表格工作，变得简单。</p>

        <div className="em-splash-status" role={error ? "alert" : "status"} aria-live="polite">
          {!error && <LoadingStatusSpinner />}
          <span className="em-splash-status-text">{status}</span>
        </div>
        {!error && <LoadingProgressBar />}
        {!error && (
          <p className="em-splash-elapsed" aria-live="off">
            {feedback.elapsed}
          </p>
        )}
        <p className="em-splash-hint" aria-live="polite">
          {error ? (action ? "" : "请重新加载页面后再试。") : feedback.hint}
        </p>
        {(error || !desktop) && (
          <div className="em-splash-recovery">
            <a
              href="/"
              onClick={(event) => {
                event.preventDefault();
                if (action) action.onClick();
                else window.location.reload();
              }}
            >
              {action?.label ?? "重新加载"}
            </a>
          </div>
        )}
      </main>

      <footer className="em-splash-footer">
        <p className="em-splash-tip">
          <Lightbulb strokeWidth={1.75} aria-hidden="true" />
          <span>小提示：用一句话描述需求，即可开始处理表格。</span>
        </p>
      </footer>
    </div>
  );
}
