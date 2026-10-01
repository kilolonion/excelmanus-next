import {
  type BackupService,
  type CapabilityModule,
  type DatabaseSync,
  FileOperationError,
  isInsidePath,
  resolveWorkspacePath,
  type ToolContext,
} from "@excelmanus/kernel";
import { mutationTools } from "./mutations.ts";
import { FILES_TOOLS } from "./tools.ts";

export const filesModule: CapabilityModule = {
  id: "files",
  tools: FILES_TOOLS,
};

export { PathSafetyError, relOf, resolveWorkspacePath } from "@excelmanus/kernel";
export { FILES_TOOLS };

export function writableFilesModule(db: DatabaseSync, backups: BackupService): CapabilityModule {
  const guard = (ctx: ToolContext, path: string) => {
    const requested = resolveWorkspacePath(ctx.workspaceRoot, path).abs;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='documents'").get();
    if (!exists) return;
    const rows = db
      .prepare("SELECT path FROM documents WHERE workspace_id=?")
      .all(ctx.workspaceId) as { path: string }[];
    if (
      rows.some((r) => {
        try {
          const registered = resolveWorkspacePath(ctx.workspaceRoot, r.path).abs;
          // 双向：动到工作簿本身/其下，或动到包含它的上级目录，都会让文档 actor 失去文件
          return isInsidePath(registered, requested) || isInsidePath(requested, registered);
        } catch {
          return false;
        }
      })
    )
      throw new FileOperationError(
        "UNSUPPORTED_FEATURE",
        "已注册工作簿必须通过文档 actor 修改或另存，不能直接移动或删除",
      );
  };
  return { id: "files", tools: [...FILES_TOOLS, ...mutationTools(backups, guard)] };
}
export { mutationTools } from "./mutations.ts";
