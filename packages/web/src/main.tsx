import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "@/app/Root";
import { startRendererOnly } from "@/lib/backend/channel";
import { applyTheme } from "@/lib/theme";
import "@/app/globals.css";
import { api } from "@/lib/backend/api";
import { startFirstScreenMetrics } from "@/lib/first-screen-metrics";

startFirstScreenMetrics(import.meta.env.VITE_QA_FIRST_SCREEN_METRICS === "1", (payload) => {
  void api()
    .reportFirstScreenMetrics(payload)
    .catch(() => undefined);
});

applyTheme();

if (new URLSearchParams(window.location.search).get("renderer") === "1") {
  // 桌面离屏截图窗口：只作 workbook_render 的渲染端
  void startRendererOnly();
} else {
  const el = document.getElementById("root");
  if (!el) throw new Error("缺少 #root");
  createRoot(el).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
