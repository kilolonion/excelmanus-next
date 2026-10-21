import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "../../../vite.config";
export default mergeConfig(base, {
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/qa-settings-load/",
  plugins: [{
    name: "qa-settings-tab-failure", enforce: "pre",
    resolveId(source: string, importer?: string) {
      if (importer?.endsWith("/settings/SettingsDialog.tsx") && /^\.\/.+Tab$/.test(source)) return `\0qa-tab:${source.slice(2)}`;
    },
    load(id: string) {
      if (!id.startsWith("\0qa-tab:")) return;
      const name = id.slice("\0qa-tab:".length);
      if (name === "GeneralTab") return 'await new Promise((_, reject) => setTimeout(() => reject(new Error("QA simulated settings module failure")), 300)); export function GeneralTab() { return null; }';
      const exported = name === "McpTab" ? "MCPTab" : name;
      return `import React from "react"; export function ${exported}() { return React.createElement("p", null, "QA 其他设置页可用"); }`;
    },
  }],
  build: { target: "esnext", outDir: fileURLToPath(new URL("../../../dist/qa-settings-load", import.meta.url)), emptyOutDir: false },
});
