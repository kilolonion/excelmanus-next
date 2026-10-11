// 开发服务器 5173，/api 与同步 WS 代理到后端（默认 127.0.0.1:8787，可用 EXCELMANUS_PORT 覆盖）。

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

const backend = `http://127.0.0.1:${process.env.EXCELMANUS_PORT ?? 8787}`;

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) {
            return "shared-ui";
          }
          // 共享组件与状态独立于入口，懒加载页面无需反向导入首屏包。
          // components/workbench/ 依赖 Univer，只随懒加载的工作台一起打包，不进首屏。
          if (
            id.includes("/packages/web/src/") &&
            !id.includes("/packages/web/src/components/workbench/") &&
            !/\/(?:main|App|Workbench|SettingsModal)\.[jt]sx?$/.test(id)
          ) {
            return "shared-ui";
          }
          return undefined;
        },
      },
    },
  },
});
