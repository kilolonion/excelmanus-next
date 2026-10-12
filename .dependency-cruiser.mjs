import { depcruiseForbiddenRules } from "./scripts/dependency-matrix.ts";

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [...depcruiseForbiddenRules()],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)dist/" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
