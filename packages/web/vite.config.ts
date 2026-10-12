// 开发服务器 5173，/api 与同步 WS 代理到后端（默认 127.0.0.1:8787，可用 EXCELMANUS_PORT 覆盖）。

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

const backend = `http://127.0.0.1:${process.env.EXCELMANUS_PORT ?? 8787}`;

export default defineConfig({
  plugins: [tailwindcss(), react()],
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
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Univer 只随懒加载的工作簿一起下载，不进首屏。
          if (id.includes("/node_modules/") && /@univerjs|\/rxjs\//.test(id)) return "univer";
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return "react";
          return undefined;
        },
      },
    },
  },
});
