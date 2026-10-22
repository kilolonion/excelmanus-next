// run_script（06 §4.6、08 全章）：在 QuickJS 沙箱中运行 TS/JS，脚本通过 SDK
// 访问工作簿与文本文件；写入先暂存，脚本成功后才逐文档发布，
// 中途失败按逆序回滚；取消/超时/脚本报错全部丢弃。
// 装配层工具：组合 workbook + files 两个模块的能力（模块间不互相依赖）。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import {
  atomicWrite,
  canonicalWorkspaceRoot,
  createReadTable,
  currentToolAccess,
  FileOperationError,
  internalPath,
  PathSafetyError,
  resolveWorkspacePath,
  runWithToolAccess,
  sha256,
  type ToolContext,
  type ToolDefinition,
  TurnAccessError,
  withFileAccessSync,
} from "@excelmanus/kernel";
import { type ToolResult, toToolErrorCode } from "@excelmanus/protocol";
import {
  type RunOutcome,
  type SandboxHost,
  type SandboxPool,
  SdkCallError,
} from "@excelmanus/sandbox";
import {
  type ChangeOp,
  DocNotFoundError,
  type DocumentService,
  WORKBOOK_ANALYZE_SQL_SHEET_PLACEHOLDER,
  WORKBOOK_ANALYZE_SQL_TABLE,
  WorkbookEditInput,
  workbookEditOps,
} from "@excelmanus/workbook";
import { z } from "zod";
import { captureNumericRead } from "./numeric-finalizer.ts";

const MAX_SDK_BYTES = 32 * 1024 * 1024;
const TEXT_BINARY_EXTS = new Set([
  ".xlsx",
  ".xlsm",
  ".csv",
  ".tsv",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".zip",
  ".gz",
  ".7z",
  ".rar",
]);

const SDK_NAMESPACES: Record<string, readonly string[]> = {
  wb: ["read", "analyze", "edit"],
  files: ["find", "readText", "writeText"],
};

const Input = z.object({
  code: z.string().min(1).describe("TS/JS 源码；顶层可用 await 与 return"),
  timeoutSeconds: z.int().min(1).max(300).optional().describe("秒，默认 30"),
  expectedVersions: z
    .record(z.string(), z.string())
    .optional()
    .describe("文本文件发布前的内容哈希校验（pathVersion 返回值）"),
});
type Args = z.infer<typeof Input>;

const WbEditInput = WorkbookEditInput;

interface PendingWorkbook {
  kind: "existing";
  docId: string;
  path: string;
  ops: ChangeOp[];
  firstRev: number;
}
interface PendingCreate {
  kind: "create";
  path: string;
  ops: ChangeOp[];
}
type PendingDoc = PendingWorkbook | PendingCreate;

interface StagedText {
  rel: string;
  stagedFile: string;
  /** 脚本首次写入时目标尚不存在 */
  created: boolean;
}

class PublishError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 文本发布清单（暂存目录内），崩溃恢复据此判定哪些文本已被替换。 */
const TEXT_MANIFEST = "publish-texts.json";
interface TextPublishEntry {
  rel: string;
  /** 发布前目标内容哈希（null = 新建）。 */
  before: string | null;
  after: string;
  /** 回滚副本绝对路径（新建文件为 null）。 */
  rollbackFile: string | null;
}

const err = (code: string, message: string, extra?: { data?: unknown }): ToolResult => ({
  status: "error",
  error: { code: toToolErrorCode(code), message, retryable: false },
  ...(extra?.data !== undefined ? { data: extra.data } : {}),
});

/** 文本 diff 头：新文件取内容前 maxLines 行；已有文件做公共前后缀裁剪的最小差异段。 */
function textDiffHead(oldText: string | null, newText: string, maxLines = 40): string {
  const newLines = newText.split("\n");
  if (oldText === null) return newLines.slice(0, maxLines).join("\n");
  const oldLines = oldText.split("\n");
  let i = 0;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i++;
  let j = 0;
  while (
    j < oldLines.length - i &&
    j < newLines.length - i &&
    oldLines[oldLines.length - 1 - j] === newLines[newLines.length - 1 - j]
  )
    j++;
  const out = [`@@ -${i + 1},${oldLines.length - i - j} +${i + 1},${newLines.length - i - j} @@`];
  for (const l of oldLines.slice(i, oldLines.length - j)) out.push(`-${l}`);
  for (const l of newLines.slice(i, newLines.length - j)) out.push(`+${l}`);
  return out.slice(0, maxLines).join("\n");
}

/** 预览区域截断到 ≤200 格（发布审批卡片展示上限）。 */
function capPreview(
  regions?: { range: string; values: unknown[][] }[],
): { range: string; values: unknown[][] }[] {
  if (!regions) return [];
  let cells = 0;
  const out: { range: string; values: unknown[][] }[] = [];
  for (const r of regions) {
    const area = r.values.length * (r.values[0]?.length ?? 0);
    if (cells + area > 200) break;
    cells += area;
    out.push(r);
  }
  return out;
}

export function runScriptTool(deps: {
  sandbox: SandboxPool;
  documents?: DocumentService;
  tools: Map<string, ToolDefinition>;
  db: DatabaseSync;
}): ToolDefinition<Args> {
  const svc = deps.documents;

  /** 工具的 ToolResult 直接透传给脚本；error 转为 SdkError。 */
  const unwrap = (res: ToolResult): unknown => {
    if (res.status === "ok") return res;
    throw new SdkCallError(res.error?.code ?? "INTERNAL", res.error?.message ?? "工具调用失败");
  };

  return {
    name: "run_script",
    title: "运行脚本",
    description: `在 QuickJS 沙箱中运行 TypeScript/JavaScript 脚本，适合自定义计算、条件逻辑和批量读写。简单观察、编辑或统计也可直接选对应工作簿工具，无需为了使用脚本而拆成额外步骤。
可用 SDK：wb.read({path或docId, mode:"overview"|"range"|"search", ...})、wb.analyze({path或docId, mode:"sql"|"profile", sheet?, range?, sql?})、
wb.analyze 的 sql 会把选定区域注册为 ${WORKBOOK_ANALYZE_SQL_TABLE} 表，也兼容 ${WORKBOOK_ANALYZE_SQL_SHEET_PLACEHOLDER} 作为 ${WORKBOOK_ANALYZE_SQL_TABLE} 的占位符；
wb.edit({path|docId, ops} 或 {path, create:true, ops})；新建默认含空白 Sheet1，ops:[] 创建空工作簿，默认表改名用 sheet.rename，sheet.add 只新增其他工作表。files.find({glob})、files.readText({path})、files.writeText({path, content})、console.log。
所有读取返回 ToolResult 包装：先检查 status，再从 result.data 取内容；例如 const result = await wb.read({path, mode:"range", sheet:"数据", range:"A1:C20"}); const rows = result.data.values。不要直接用 result.values。files.readText 的文本在 result.data.content。
多表写入的 range 必须带表名，如 "'核对'!A1:B5"；sheet.add 不会把后续操作切换到新表。
脚本可顶层 await 与 return 一个 JSON 可序列化的值。
写语义：所有修改先暂存，脚本成功结束后先向你展示待发布清单（工作簿区域预览/文本前几行），批准后才逐一发布；
脚本抛错、超时、被拒绝或被取消时全部丢弃。
注意：同一工作簿先 wb.edit 再 wb.read/wb.analyze 会报错（读不到未发布修改；请先读后写或分两次运行）；
reader 角色的脚本只能读取（wb.edit/files.writeText 会报错）；发布不保证跨文件断电原子性。
默认执行超时 30 秒，timeoutSeconds 最长 300 秒；没有网络和任意 shell 能力，文件访问只在工作区内。
console.log 可输出行数、合计等摘要；逐格 SDK 调用会增加往返开销，适合先批量读取、在内存计算、再批量暂存修改。`,
    input: Input,
    output: z.record(z.string(), z.unknown()),
    effect: "write",
    approval: "publish",
    targets: () => [],
    replay: "unsafe",
    timeoutMs: 310_000,
    roles: ["main", "lead", "worker", "reader"],
    async execute(args, ctx): Promise<ToolResult> {
      const a = Input.parse(args);
      const access = currentToolAccess();
      let sdkCallIndex = 0;
      const toolCallId = ctx.toolCallId;
      const timeoutMs = (a.timeoutSeconds ?? 30) * 1000;

      // 暂存目录：.excelmanus/tmp/script-<toolCallId>/（内部 API，不经路径校验对外暴露）
      const stagingDirRel = `tmp/script-${toolCallId}`;
      let stagedSeq = 0;
      const stagedFile = () => internalPath(ctx.workspaceRoot, `${stagingDirRel}/s${stagedSeq++}`);
      // 清理路径不带副作用（internalPath 会顺带建目录）
      const stagingDirAbs = () =>
        join(
          canonicalWorkspaceRoot(ctx.workspaceRoot),
          ".excelmanus",
          "tmp",
          `script-${toolCallId}`,
        );

      const docOrder: PendingDoc[] = [];
      const docByKey = new Map<string, PendingDoc>();
      const textOrder: string[] = [];
      const texts = new Map<string, StagedText>();
      /** rel → 脚本首次看到时的内容哈希（null = 当时不存在） */
      const firstSight = new Map<string, string | null>();
      const scriptReads = createReadTable();
      const actualReads: Record<string, unknown>[] = [];
      const readDocRevs: Record<string, number> = {};
      const recordRead = (toolName: string, result: ToolResult): unknown => {
        const unwrapped = unwrap(result);
        const read = captureNumericRead(toolName, result);
        if (read) {
          actualReads.push(read);
          for (const [docId, rev] of Object.entries(read.docRevs as Record<string, number>))
            readDocRevs[docId] ??= rev;
        }
        return unwrapped;
      };
      const provenance = () => ({ code: a.code, reads: actualReads });

      /** expectedVersions 的路径键先做规范化（非法路径在进沙箱前拒绝）。 */
      const expectedByRel = new Map<string, string>();
      if (a.expectedVersions) {
        for (const [p, hash] of Object.entries(a.expectedVersions)) {
          const { rel } = resolveWorkspacePath(ctx.workspaceRoot, p);
          expectedByRel.set(rel, hash);
        }
      }

      const sight = (abs: string, rel: string) => {
        if (!firstSight.has(rel)) {
          firstSight.set(
            rel,
            withFileAccessSync({ kind: "file-metadata", path: abs, purpose: "script-sight" }, () =>
              existsSync(abs),
            )
              ? sha256(
                  withFileAccessSync(
                    { kind: "file-bytes", path: abs, purpose: "script-sight" },
                    () => readFileSync(abs),
                  ),
                )
              : null,
          );
        }
      };

      const wbEdit = async (rawArgs: unknown): Promise<unknown> => {
        if (ctx.role === "reader")
          throw new SdkCallError("INVALID_ARGUMENT", "reader 角色的脚本只能读取");
        if (svc === undefined) throw new SdkCallError("UNSUPPORTED_FEATURE", "workbook 模块未装配");
        const raw = rawArgs as Record<string, unknown> | null;
        if (
          raw &&
          typeof raw === "object" &&
          (raw.baseRev !== undefined || raw.dryRun !== undefined)
        ) {
          throw new SdkCallError("INVALID_ARGUMENT", "脚本中不支持 baseRev/dryRun");
        }
        let parsed: z.infer<typeof WbEditInput>;
        try {
          parsed = WbEditInput.parse(rawArgs);
        } catch (e) {
          throw new SdkCallError("INVALID_ARGUMENT", e instanceof Error ? e.message : String(e));
        }
        if (parsed.create) {
          if (parsed.docId !== undefined || parsed.path === undefined) {
            throw new SdkCallError("INVALID_ARGUMENT", "create 需要 path 且不接受 docId");
          }
          const { rel } = resolveWorkspacePath(ctx.workspaceRoot, parsed.path);
          if (extname(rel).toLowerCase() !== ".xlsx") {
            throw new SdkCallError("INVALID_ARGUMENT", "新建工作簿必须使用 .xlsx");
          }
          const key = `create:${rel}`;
          let pd = docByKey.get(key);
          if (pd && parsed.sheetNames)
            throw new SdkCallError(
              "INVALID_ARGUMENT",
              "同一脚本中新建同一路径时，sheetNames 只能在首次 wb.edit 提供",
            );
          if (!pd) {
            pd = { kind: "create", path: rel, ops: [] };
            docByKey.set(key, pd);
            docOrder.push(pd);
          }
          (pd as PendingCreate).ops.push(...workbookEditOps(parsed));
          return {
            status: "ok",
            data: { buffered: true, path: rel, opsCount: (pd as PendingCreate).ops.length },
          };
        }
        if (parsed.docId === undefined && parsed.path === undefined) {
          throw new SdkCallError("INVALID_ARGUMENT", "wb.edit 需要 docId 或 path");
        }
        let docId: string;
        let rel: string;
        if (parsed.docId !== undefined) {
          const e = await svc.entry(parsed.docId, ctx.workspaceRoot);
          docId = e.meta.id;
          rel = e.meta.path;
        } else {
          const opened = await svc.open(ctx.workspaceId, ctx.workspaceRoot, parsed.path!);
          docId = opened.meta.id;
          rel = opened.meta.path;
        }
        const key = `doc:${docId}`;
        let pd = docByKey.get(key);
        if (!pd) {
          pd = {
            kind: "existing",
            docId,
            path: rel,
            ops: [],
            firstRev: svc.headRev(docId),
          };
          docByKey.set(key, pd);
          docOrder.push(pd);
        }
        (pd as PendingWorkbook).ops.push(...parsed.ops);
        return {
          status: "ok",
          data: {
            buffered: true,
            path: rel,
            docId,
            opsCount: (pd as PendingWorkbook).ops.length,
          },
        };
      };

      const filesReadText = (rawArgs: unknown): unknown => {
        const raw = rawArgs as Record<string, unknown> | null;
        const p =
          typeof rawArgs === "string" ? rawArgs : raw && typeof raw === "object" ? raw.path : null;
        const { abs, rel } = resolveWorkspacePath(
          ctx.workspaceRoot,
          typeof p === "string" ? p : "",
        );
        const staged = texts.get(rel);
        if (staged) {
          return {
            status: "ok",
            data: { path: rel, content: readFileSync(staged.stagedFile, "utf8"), staged: true },
          };
        }
        sight(abs, rel);
        if (
          !withFileAccessSync(
            { kind: "file-metadata", path: abs, purpose: "script-read-text" },
            () => existsSync(abs) && statSync(abs).isFile(),
          )
        ) {
          throw new SdkCallError("NOT_FOUND", `路径不存在：${rel}`);
        }
        if (
          withFileAccessSync(
            { kind: "file-metadata", path: abs, purpose: "script-read-text" },
            () => statSync(abs),
          ).size > MAX_SDK_BYTES
        ) {
          throw new SdkCallError("LIMIT_EXCEEDED", "文件超过 32MB");
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "script-read-text" }, () =>
            readFileSync(abs),
          ),
        );
        return { status: "ok", data: { path: rel, content: text } };
      };

      const filesWriteText = (rawArgs: unknown): unknown => {
        if (ctx.role === "reader")
          throw new SdkCallError("INVALID_ARGUMENT", "reader 角色的脚本只能读取");
        // 桥把多参数调用打成数组：writeText("p","c") → ["p","c"]
        const a2 = Array.isArray(rawArgs)
          ? { path: rawArgs[0], content: rawArgs[1] }
          : (rawArgs as { path?: unknown; content?: unknown } | null);
        const { abs, rel } = resolveWorkspacePath(
          ctx.workspaceRoot,
          typeof a2?.path === "string" ? a2.path : "",
        );
        if (typeof a2?.content !== "string") {
          throw new SdkCallError("INVALID_ARGUMENT", "content 必须是字符串");
        }
        if (TEXT_BINARY_EXTS.has(extname(rel).toLowerCase())) {
          throw new SdkCallError("UNSUPPORTED_FEATURE", `${rel} 不是文本文件`);
        }
        const registered = deps.db
          .prepare("SELECT 1 FROM documents WHERE workspace_id = ? AND path = ?")
          .get(ctx.workspaceId, rel);
        if (registered) {
          throw new SdkCallError("UNSUPPORTED_FEATURE", "该路径已注册为工作簿，请用 wb.edit 修改");
        }
        if (Buffer.byteLength(a2.content, "utf8") > MAX_SDK_BYTES) {
          throw new SdkCallError("LIMIT_EXCEEDED", "content 超过 32MB");
        }
        sight(abs, rel);
        let st = texts.get(rel);
        if (!st) {
          st = {
            rel,
            stagedFile: stagedFile(),
            created: !withFileAccessSync(
              { kind: "file-metadata", path: abs, purpose: "script-write-text" },
              () => existsSync(abs),
            ),
          };
          texts.set(rel, st);
          textOrder.push(rel);
        }
        mkdirSync(dirname(st.stagedFile), { recursive: true });
        writeFileSync(st.stagedFile, a2.content, "utf8");
        return { status: "ok", data: { path: rel, staged: true } };
      };

      /** 写后读拦截：目标工作簿在本脚本里已有缓冲的 wb.edit → 明确报错（读不到未发布修改）。 */
      const assertNoBufferedEdit = (callArgs: unknown): void => {
        const a2 = callArgs as { docId?: unknown; path?: unknown } | null;
        const docId = typeof a2?.docId === "string" ? a2.docId : undefined;
        let rel: string | undefined;
        if (typeof a2?.path === "string" && a2.path !== "") {
          rel = resolveWorkspacePath(ctx.workspaceRoot, a2.path).rel;
        }
        const hit = [...docByKey.values()].some(
          (pd) =>
            (docId !== undefined && pd.kind === "existing" && pd.docId === docId) ||
            (rel !== undefined && pd.path === rel),
        );
        if (hit) {
          throw new SdkCallError(
            "UNSUPPORTED_FEATURE",
            "该工作簿在本脚本中已有未发布的修改，读取看不到这些修改；请先读后写，或分两次运行脚本",
          );
        }
      };

      const host: SandboxHost = {
        async call(ns, method, callArgs, signal) {
          const invoke = async () => {
            // 子工具拿脚本级读集与中止信号；工作区/会话/租约沿用外 ctx
            const scriptCtx: ToolContext = { ...ctx, signal, reads: scriptReads };
            try {
              switch (`${ns}.${method}`) {
                case "wb.read": {
                  const t = deps.tools.get("workbook_read");
                  if (!t) throw new SdkCallError("UNSUPPORTED_FEATURE", "workbook 模块未装配");
                  assertNoBufferedEdit(callArgs);
                  return recordRead("workbook_read", await t.execute(callArgs, scriptCtx));
                }
                case "wb.analyze": {
                  const a2 = callArgs as { saveTo?: unknown } | null;
                  if (a2 && typeof a2 === "object" && a2.saveTo !== undefined) {
                    throw new SdkCallError("INVALID_ARGUMENT", "脚本中请用 wb.edit 写入");
                  }
                  const t = deps.tools.get("workbook_analyze");
                  if (!t) throw new SdkCallError("UNSUPPORTED_FEATURE", "workbook 模块未装配");
                  assertNoBufferedEdit(callArgs);
                  return recordRead("workbook_analyze", await t.execute(callArgs, scriptCtx));
                }
                case "wb.edit":
                  return await wbEdit(callArgs);
                case "files.find": {
                  const t = deps.tools.get("find");
                  if (!t) throw new SdkCallError("UNSUPPORTED_FEATURE", "files 模块未装配");
                  return unwrap(await t.execute(callArgs, scriptCtx));
                }
                case "files.readText":
                  return filesReadText(callArgs);
                case "files.writeText":
                  return filesWriteText(callArgs);
                default:
                  throw new SdkCallError("INVALID_ARGUMENT", `未知 SDK 方法 ${ns}.${method}`);
              }
            } catch (e) {
              if (e instanceof SdkCallError) throw e;
              if (e instanceof PathSafetyError || e instanceof TurnAccessError)
                throw new SdkCallError(e.code, e.message);
              if (e instanceof FileOperationError) throw new SdkCallError(e.code, e.message);
              if (e instanceof DocNotFoundError) throw new SdkCallError("NOT_FOUND", e.message);
              if (e instanceof z.ZodError) throw new SdkCallError("INVALID_ARGUMENT", e.message);
              throw e;
            }
          };
          // IPC callbacks run on the pool listener context, not necessarily this invocation.
          if (!access) return invoke();
          const sdkAccess = { ...access, sdkCallIndex: ++sdkCallIndex };
          try {
            return await runWithToolAccess(sdkAccess, invoke);
          } finally {
            access.auditFailed ||= sdkAccess.auditFailed;
          }
        },
      };

      const outcome = await deps.sandbox.run(
        { code: a.code, timeoutMs, namespaces: SDK_NAMESPACES, signal: ctx.signal },
        host,
      );

      try {
        if (outcome.kind !== "ok") {
          // Host phase fact only: staging/reads may have occurred, but buildPlan/publish have not.
          const failure = mapOutcome(outcome);
          return { ...failure, data: {
            ...((failure.data ?? {}) as Record<string, unknown>),
            publicationPhase: "not_started", published: [], committedRevs: [],
          } };
        }
        // 发布时审批（08 §6、02 §1 先看见再同意）：先 dryRun 预演构建待发布清单，
        // 再请求审批，批准后走原有发布管线；预演失败按现有错误返回、什么都不发布。
        let planned: { items: Record<string, unknown>[]; hashMaterial: Record<string, unknown>[] };
        try {
          planned = await buildPlan();
        } catch (e) {
          const code =
            e instanceof PublishError ||
            e instanceof TurnAccessError ||
            e instanceof PathSafetyError
              ? e.code
              : "INTERNAL";
          return err(code, e instanceof Error ? e.message : String(e), {
            data: { rolledBack: [] },
          });
        }
        if (planned.items.length === 0) {
          // 脚本没有写入：不审批不发布
          return {
            status: "ok",
            data: {
              value: outcome.value,
              stdout: outcome.stdout,
              published: [],
              provenance: provenance(),
            },
            docRevs: readDocRevs,
          };
        }
        const planHash = sha256(
          new TextEncoder().encode(
            JSON.stringify(
              planned.hashMaterial
                .slice()
                .sort((x, y) => String(x.path).localeCompare(String(y.path))),
            ),
          ),
        );
        const rawInput = (ctx.rawArgs ?? args) as Record<string, unknown> | undefined;
        if (ctx.destructiveApproved) {
          // 重启后的已批准恢复：脚本重跑，待发布内容必须与批准时一致
          const approvedHash =
            typeof rawInput?.planHash === "string" ? rawInput.planHash : undefined;
          if (approvedHash === undefined || approvedHash !== planHash) {
            return err("VERSION_CONFLICT", "待发布内容与批准时不一致，请重新运行");
          }
        } else if (ctx.requestApproval) {
          const decision = await ctx.requestApproval({
            targets: planned.items.map((i) => String(i.path)),
            effect: "write",
            args: { ...(rawInput ?? {}), planHash, publishPlan: planned.items },
          });
          if (ctx.signal.aborted) {
            const timedOut =
              ctx.signal.reason instanceof Error && ctx.signal.reason.name === "TimeoutError";
            return err(
              timedOut ? "TIMEOUT" : "CANCELLED",
              timedOut ? "等待审批超时" : "已被用户停止",
            );
          }
          if (decision.decision !== "approved") {
            return err(
              "APPROVAL_DENIED",
              decision.reason ? `用户拒绝：${decision.reason}` : "用户拒绝了此操作",
            );
          }
        }
        return await publish(outcome);
      } finally {
        // 无论成败都清暂存目录
        try {
          rmSync(stagingDirAbs(), { recursive: true, force: true });
        } catch {
          // 清理失败不掩盖结果
        }
      }

      /**
       * 构建发布计划（dryRun 预演，不改任何持久状态）：工作簿给出区域摘要与值预览，
       * 文本给出字节数与 diffHead；hashMaterial 供 planHash 核对（ops 原文 / 文本内容哈希）。
       */
      async function buildPlan(): Promise<{
        items: Record<string, unknown>[];
        hashMaterial: Record<string, unknown>[];
      }> {
        const items: Record<string, unknown>[] = [];
        const hashMaterial: Record<string, unknown>[] = [];
        const root = ctx.workspaceRoot;
        const source = { kind: "script" as const, id: `${ctx.sessionId}/${ctx.agentId}` };
        for (const pd of docOrder) {
          resolveWorkspacePath(ctx.workspaceRoot, pd.path);
          if (pd.kind === "create") {
            svc!.validateCreatePath(root, pd.path);
            const res = await svc!.previewCreate(pd.ops, root);
            if (res.status !== "ok") {
              throw new PublishError(
                res.error?.code ?? "INVALID_ARGUMENT",
                res.error?.message ?? "工作簿预览失败",
              );
            }
            const data = res.data as
              | {
                  preview?: { range: string; values: unknown[][] }[];
                  changes?: unknown;
                  sheets?: unknown;
                }
              | undefined;
            items.push({
              path: pd.path,
              kind: "workbook",
              create: true,
              opsCount: pd.ops.length,
              changes: data?.changes,
              sheets: data?.sheets,
              preview: capPreview(data?.preview),
            });
            hashMaterial.push({ path: pd.path, kind: "workbook", ops: pd.ops });
            continue;
          }
          const baseRev = scriptReads.get(pd.docId)?.minRev ?? pd.firstRev;
          const res = await svc!.submit(pd.docId, root, {
            baseRev,
            readSet: scriptReads.get(pd.docId)?.ranges ?? [],
            source,
            sessionId: ctx.sessionId,
            toolCallId,
            ops: pd.ops,
            dryRun: true,
          });
          if (!res.ok) throw new PublishError(res.code, res.message);
          items.push({
            path: pd.path,
            kind: "workbook",
            create: false,
            opsCount: pd.ops.length,
            changes: res.changes,
            preview: capPreview(res.preview),
          });
          hashMaterial.push({ path: pd.path, kind: "workbook", ops: pd.ops });
        }
        for (const rel of textOrder) {
          const t = texts.get(rel)!;
          const { abs } = resolveWorkspacePath(root, rel);
          const content = readFileSync(t.stagedFile, "utf8");
          const original = withFileAccessSync(
            { kind: "file-metadata", path: abs, purpose: "script-preview" },
            () => existsSync(abs),
          )
            ? withFileAccessSync({ kind: "file-bytes", path: abs, purpose: "script-preview" }, () =>
                readFileSync(abs, "utf8"),
              )
            : null;
          items.push({
            path: rel,
            kind: "text",
            created: t.created,
            bytes: Buffer.byteLength(content, "utf8"),
            diffHead: textDiffHead(original, content),
          });
          hashMaterial.push({
            path: rel,
            kind: "text",
            sha256: sha256(new TextEncoder().encode(content)),
          });
        }
        return { items, hashMaterial };
      }

      /** 成功后的发布：租约 → 工作簿逐个提交 → 文本原子替换；失败按逆序回滚。 */
      async function publish(ok: Extract<RunOutcome, { kind: "ok" }>): Promise<ToolResult> {
        const source = { kind: "script" as const, id: `${ctx.sessionId}/${ctx.agentId}` };
        const targets = [...docOrder.map((d) => d.path), ...textOrder];
        try {
          ctx.leases?.assertAvailable(
            { sessionId: ctx.sessionId, agentId: ctx.agentId, targets },
            { mainBypass: true },
          );
        } catch (e) {
          return err("FILE_LEASED", e instanceof Error ? e.message : "文件被租用", {
            data: { rolledBack: [] },
          });
        }

        const committedRevs: Array<{ docId: string; rev: number; path: string }> = [];
        const createdDocs: Array<{ docId: string; path: string }> = [];
        const published: Array<Record<string, unknown>> = [];
        const replacedTexts: Array<{ rel: string; rollbackFile: string }> = [];
        const textManifest: TextPublishEntry[] = [];
        const manifestFile = () => internalPath(root, `${stagingDirRel}/${TEXT_MANIFEST}`);
        const createdTexts: string[] = [];
        const docRevs: Record<string, number> = {};
        const root = ctx.workspaceRoot;

        try {
          for (const pd of docOrder) {
            resolveWorkspacePath(ctx.workspaceRoot, pd.path);
            if (pd.kind === "create") {
              const created = await svc!.create(
                ctx.workspaceId,
                root,
                pd.path,
                ctx.sessionId,
                ctx.agentId,
              );
              const docId = created.meta.id;
              try {
                const res = await svc!.submit(docId, root, {
                  baseRev: 0,
                  readSet: [],
                  source,
                  sessionId: ctx.sessionId,
                  toolCallId,
                  ops: pd.ops,
                  created: true,
                });
                if (!res.ok) throw new PublishError(res.code, res.message);
                committedRevs.push({ docId, rev: res.rev, path: pd.path });
                docRevs[docId] = res.rev;
                await svc!.checkpoint(docId, root);
                createdDocs.push({ docId, path: pd.path });
                published.push({
                  path: pd.path,
                  kind: "workbook",
                  docId,
                  rev: docRevs[docId] ?? 0,
                  created: true,
                  sheets: res.sheets,
                  changes: res.changes,
                });
              } catch (e) {
                await svc!.discardCreated(docId, root, ctx.sessionId).catch(() => {});
                throw e;
              }
            } else {
              const baseRev = scriptReads.get(pd.docId)?.minRev ?? pd.firstRev;
              const res = await svc!.submit(pd.docId, root, {
                baseRev,
                readSet: scriptReads.get(pd.docId)?.ranges ?? [],
                source,
                sessionId: ctx.sessionId,
                toolCallId,
                ops: pd.ops,
              });
              if (!res.ok) throw new PublishError(res.code, res.message);
              committedRevs.push({ docId: pd.docId, rev: res.rev, path: pd.path });
              docRevs[pd.docId] = res.rev;
              ctx.reads.record(pd.docId, res.writeSet?.ranges ?? [], res.rev);
              published.push({
                path: pd.path,
                kind: "workbook",
                docId: pd.docId,
                rev: res.rev,
                changes: res.changes,
              });
            }
          }
          for (const rel of textOrder) {
            const t = texts.get(rel)!;
            const { abs } = resolveWorkspacePath(root, rel);
            const expected = expectedByRel.get(rel) ?? firstSight.get(rel) ?? null;
            const current = withFileAccessSync(
              { kind: "file-metadata", path: abs, purpose: "script-publish" },
              () => existsSync(abs),
            )
              ? sha256(
                  withFileAccessSync(
                    { kind: "file-bytes", path: abs, purpose: "script-publish-hash" },
                    () => readFileSync(abs),
                  ),
                )
              : null;
            if (current !== expected) {
              throw new PublishError("VERSION_CONFLICT", `文件已被外部修改：${rel}`);
            }
            const bytes = readFileSync(t.stagedFile);
            const rollbackFile = current !== null ? `${t.stagedFile}.orig` : null;
            if (current !== null && rollbackFile !== null) {
              ctx.backups.ensureBackup(rel);
              withFileAccessSync(
                { kind: "file-bytes", path: abs, purpose: "script-rollback-copy" },
                () => copyFileSync(abs, rollbackFile),
              );
              replacedTexts.push({ rel, rollbackFile });
            }
            // 04 §8.2：发布前落一份清单（目标前后哈希 + 回滚副本），崩溃恢复据此判定文本是否已改
            textManifest.push({ rel, before: current, after: sha256(bytes), rollbackFile });
            // 临时文件 + rename：崩溃时清单要么是旧版本要么是新版本，不会半截
            writeFileSync(`${manifestFile()}.tmp`, JSON.stringify(textManifest), "utf8");
            renameSync(`${manifestFile()}.tmp`, manifestFile());
            atomicWrite(root, rel, bytes, current);
            if (t.created) ctx.backups.markCreated(rel);
            createdTexts.push(...(t.created ? [rel] : []));
            published.push({ path: rel, kind: "text", created: t.created });
          }
        } catch (e) {
          // ---- 回滚：工作簿逆序 revert / 丢弃新建；文本逆序恢复 / 删除新建 ----
          const rolledBack: string[] = [];
          const unrecovered: string[] = [];
          for (const c of [...committedRevs].reverse()) {
            try {
              resolveWorkspacePath(root, c.path);
              const rr = await svc!.revert(c.docId, root, c.rev, source, ctx.sessionId, toolCallId);
              if (rr.ok) rolledBack.push(c.path);
              else unrecovered.push(c.path);
            } catch {
              unrecovered.push(c.path);
            }
          }
          for (const c of [...createdDocs].reverse()) {
            try {
              resolveWorkspacePath(root, c.path);
              await svc!.discardCreated(c.docId, root, ctx.sessionId);
              rolledBack.push(c.path);
            } catch {
              unrecovered.push(c.path);
            }
          }
          for (const t of [...replacedTexts].reverse()) {
            try {
              const abs = resolveWorkspacePath(root, t.rel).abs;
              const publishedSha = sha256(
                withFileAccessSync(
                  { kind: "file-bytes", path: abs, purpose: "script-rollback-hash" },
                  () => readFileSync(abs),
                ),
              );
              atomicWrite(root, t.rel, readFileSync(t.rollbackFile), publishedSha);
              rolledBack.push(t.rel);
            } catch {
              unrecovered.push(t.rel);
            }
          }
          for (const rel of [...createdTexts].reverse()) {
            try {
              const abs = resolveWorkspacePath(root, rel).abs;
              withFileAccessSync(
                { kind: "file-write", path: abs, purpose: "script-rollback" },
                () => rmSync(abs, { force: true }),
              );
              rolledBack.push(rel);
            } catch {
              unrecovered.push(rel);
            }
          }
          const code =
            e instanceof PublishError ||
            e instanceof TurnAccessError ||
            e instanceof PathSafetyError
              ? e.code
              : "INTERNAL";
          const message = e instanceof Error ? e.message : String(e);
          if (unrecovered.length > 0) {
            return {
              status: "uncertain",
              error: {
                code: toToolErrorCode(code),
                message: `发布失败且回滚不完整：${message}`,
                retryable: false,
              },
              data: { committedRevs, published, rolledBack, unrecovered },
            };
          }
          return err(code, message, { data: { committedRevs, published, rolledBack } });
        }

        return {
          status: "ok",
          data: {
            value: ok.value,
            stdout: ok.stdout,
            published,
            provenance: provenance(),
          },
          docRevs,
        };
      }

      function mapOutcome(o: Exclude<RunOutcome, { kind: "ok" }>): ToolResult {
        if (o.kind === "scriptError") {
          const where = o.line !== undefined ? `脚本第 ${o.line} 行出错：` : "脚本出错：";
          return err("SANDBOX_ERROR", `${where}${o.message}`, {
            data: {
              line: o.line ?? null,
              stack: o.stack?.slice(0, 2000) ?? null,
              stdout: o.stdout,
            },
          });
        }
        const data = { stdout: o.stdout, detail: o.detail ?? null };
        switch (o.reason) {
          case "timeout":
            return err("TIMEOUT", `脚本执行超过 ${timeoutMs / 1000} 秒`, { data });
          case "memory":
            return err("LIMIT_EXCEEDED", "脚本内存超限（256MB）", { data });
          case "output":
            return err("LIMIT_EXCEEDED", "脚本输出超限", { data });
          case "cancelled":
            return err("CANCELLED", "脚本已取消", { data });
          default:
            return err("SANDBOX_ERROR", `沙箱进程崩溃：${o.detail ?? "crash"}`, { data });
        }
      }
    },
    /**
     * 04 §8.2：工作簿看 doc_ops、文本看发布清单与目标当前哈希；有任何已发布或
     * 无法判定的目标 → uncertain 且保留暂存目录（含 .orig 回滚副本）；都没有 → not_executed 并清暂存。
     */
    recover(info) {
      const row = deps.db
        .prepare(
          "SELECT w.path FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?",
        )
        .get(info.sessionId) as { path: string } | undefined;
      const stagingDir = row
        ? join(row.path, ".excelmanus", "tmp", `script-${info.toolCallId}`)
        : undefined;
      const textsChanged: string[] = [];
      let manifestUnreadable = false;
      if (row && stagingDir) {
        let manifest: TextPublishEntry[] = [];
        const manifestPath = join(stagingDir, TEXT_MANIFEST);
        if (existsSync(manifestPath)) {
          try {
            const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
            if (!Array.isArray(parsed)) throw new Error("manifest not array");
            manifest = parsed as TextPublishEntry[];
          } catch {
            // 清单存在却读不出：无法判定哪些文本已替换 → fail-closed（按 uncertain，保留暂存）
            manifestUnreadable = true;
          }
        }
        for (const entry of manifest) {
          let current: string | null | false;
          try {
            const { abs } = resolveWorkspacePath(row.path, entry.rel);
            current = withFileAccessSync(
              { kind: "file-metadata", path: abs, purpose: "script-recovery" },
              () => existsSync(abs),
            )
              ? sha256(
                  withFileAccessSync(
                    { kind: "file-bytes", path: abs, purpose: "script-recovery-hash" },
                    () => readFileSync(abs),
                  ),
                )
              : null;
          } catch {
            current = false;
          }
          // 仍是发布前内容 → 未改；否则（已是新内容或第三种状态）→ 已改/不确定
          if (current !== entry.before) textsChanged.push(entry.rel);
        }
      }
      const committed = svc?.committedByToolCall(info.toolCallId);
      if (committed || textsChanged.length > 0 || manifestUnreadable) {
        return {
          status: "uncertain",
          error: {
            code: "INTERNAL",
            message:
              "进程中断时脚本发布可能部分完成，请重新读取相关文件后再继续；文本回滚副本保留在暂存区",
            retryable: false,
          },
          data: {
            ...(committed ? { committed } : {}),
            ...(textsChanged.length > 0 ? { textsChanged } : {}),
            ...(manifestUnreadable ? { manifestUnreadable: true } : {}),
          },
        };
      }
      if (stagingDir) {
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // 清理失败不影响判定
        }
      }
      return {
        status: "not_executed",
        error: { code: "CANCELLED", message: "脚本未执行；暂存已清理", retryable: false },
      };
    },
  };
}
