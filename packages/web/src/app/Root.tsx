import { lazy, Suspense, useEffect } from "react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { resumeBrowserSession } from "@/lib/backend/api";
import { bootApp } from "@/lib/boot";
import { useAppStore } from "@/stores/app-store";

const ClientLayout = lazy(() =>
  import("./client-layout").then((m) => ({ default: m.ClientLayout })),
);

export function Root() {
  const status = useAppStore((s) => s.status);
  const bootMessage = useAppStore((s) => s.bootMessage);

  useEffect(() => {
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
    return <LoadingScreen error="无法连接本机服务，请确认 ExcelManus 正在运行" />;

  return (
    <Suspense fallback={<LoadingScreen message="服务已连接，正在加载工作区界面..." />}>
      <ClientLayout />
    </Suspense>
  );
}
