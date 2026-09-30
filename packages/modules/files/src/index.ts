import type { CapabilityModule } from "@excelmanus/kernel";
import { FILES_TOOLS } from "./tools.ts";

export const filesModule: CapabilityModule = {
  id: "files",
  tools: FILES_TOOLS,
};

export { PathSafetyError, relOf, resolveWorkspacePath } from "@excelmanus/kernel";
export { FILES_TOOLS };
