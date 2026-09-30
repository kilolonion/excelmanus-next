// 开发服务器 5173，/api 与同步 WS 代理到后端（默认 127.0.0.1:8787，可用 EXCELMANUS_PORT 覆盖）。

import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

const backend = `http://127.0.0.1:${process.env.EXCELMANUS_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
