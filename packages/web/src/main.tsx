import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@univerjs/preset-sheets-core/lib/index.css";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("缺少 #root");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
