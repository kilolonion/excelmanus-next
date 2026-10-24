import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { resumeBrowserSession } from "@/lib/backend/api";
import { bootApp } from "@/lib/boot";
import { useAppStore } from "@/stores/app-store";

type LayoutComponent = typeof import("./client-layout").ClientLayout;
let resolvedClientLayout: LayoutComponent | undefined;
let clientLayoutPromise: Promise<{ default: LayoutComponent }> | undefined;

export const loadClientLayout = () => {
  clientLayoutPromise ??= import("./client-layout").then((m) => {
    resolvedClientLayout = m.ClientLayout;
    return { default: m.ClientLayout };
  });
  return clientLayoutPromise;
};
const ClientLayout = lazy(loadClientLayout);

export function Root() {
  const status = useAppStore((s) => s.status);
  const bootMessage = useAppStore((s) => s.bootMessage);

  useEffect(() => {
    // Preload and evaluate modules without mounting; auth/protocol gates remain intact.
    void loadClientLayout().catch(() => undefined);
    void bootApp();
  }, []);

  if (status === "booting") return <LoadingScreen message={bootMessage} />;
  if (status === "signed-out")
    return (
      <LoadingScreen
        error="你已退出本机登录"
        action={{ label: "重新登录", onClick: resumeBrowserSession }}
      />
    );
  if (status === "protocol-mismatch")
    return <LoadingScreen error="界面与服务版本不一致，请刷新页面；桌面版请重启应用" />;
  if (status === "auth-failed")
    return (
      <LoadingScreen
        error="服务连接或加载超时，请检查网络后重试"
        action={{ label: "重试", onClick: () => window.location.reload() }}
      />
    );

  // A completed preload must not suspend again on a fresh lazy initialization.
  // Pending/rejected resources still use the original Suspense/ErrorBoundary path.
  const ReadyLayout = resolvedClientLayout ?? ClientLayout;
  return (
    <ErrorBoundary
      fallback={() => <LoadingScreen error="界面资源加载失败或运行异常，请重新加载页面。" />}
    >
      <Suspense fallback={<LoadingScreen message="服务已连接，正在加载工作区界面..." />}>
        <ReadyLayout />
      </Suspense>
    </ErrorBoundary>
  );
}
