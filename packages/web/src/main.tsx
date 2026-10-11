import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startRendererOnly } from "./render.ts";
import { applyAppearance } from "./theme.ts";
import "./styles.css";

applyAppearance();

if (new URLSearchParams(window.location.search).get("renderer") === "1") {
  // 桌面离屏截图窗口：只作 workbook_render 的渲染端
  void startRendererOnly();
} else {
  const el = document.getElementById("root");
  if (!el) throw new Error("缺少 #root");
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
