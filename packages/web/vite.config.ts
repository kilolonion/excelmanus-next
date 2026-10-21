// 开发服务器 5173，/api 与同步 WS 代理到后端（默认 127.0.0.1:8787，可用 EXCELMANUS_PORT 覆盖）。

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import { createWorkbenchChunks } from "./build/workbook-chunks";

const backend = `http://127.0.0.1:${process.env.EXCELMANUS_PORT ?? 8787}`;

export default defineConfig({
  plugins: [tailwindcss(), react()],
  worker: { format: "es" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // 原地部署时保留旧哈希资源，已打开的页面仍可加载其懒加载模块。
    emptyOutDir: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Shared UI helpers must remain outside the lazy workbook chunk.
        onlyExplicitManualChunks: true,
        manualChunks: createWorkbenchChunks(),
      },
    },
  },
});
