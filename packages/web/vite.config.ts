// 开发服务器 5173，/api 与同步 WS 代理到后端（默认 127.0.0.1:8787，可用 EXCELMANUS_PORT 覆盖）。
// 不用 @vitejs/plugin-react：其 babel 链路会引入 caniuse-lite（CC-BY-4.0，许可证白名单外）。
// Vite 内置 esbuild 已能编译 JSX/TSX（无 Fast Refresh，M1 可接受）。

import { defineConfig } from "vite";

const backend = `http://127.0.0.1:${process.env.EXCELMANUS_PORT ?? 8787}`;

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
