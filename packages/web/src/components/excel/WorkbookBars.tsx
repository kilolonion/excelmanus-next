// 工作台顶部的提示条：提交冲突二选一、输入草稿被覆盖、文件被外部修改、写回失败。
// 每种情况都在表格上方给出明确的下一步，不弹窗打断。

import { formatRange } from "@excelmanus/core";
import { AlertTriangle, Eye, RefreshCw, WifiOff } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import { samePath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import {
  type CellValue,
  type ConflictCell,
  type ConflictParty,
  canKeepMine,
  conflictCells,
  conflictParties,
  conflictRegions,
  conflictRevision,
  describeCell,
  partyOf,
} from "@/lib/workbook/conflict";
import { type DocConflict, latestDocConflict } from "@/lib/workbook/doc-sync";
import { useChatStore } from "@/stores/chat-store";
import {
  dismissDocConflict,
  reloadDocument,
  resolveExternal,
  resubmitRejected,
  setDraftConflict,
  useWorkbookStore,
} from "@/stores/workbook-store";
import type { SheetApi } from "./FormatToolbar";

const SHOWN_CELLS = 3;

const PARTY_NAME: Record<ConflictParty | "unknown", string> = {
  agent: "代理",
  window: "其他窗口",
  engine: "公式重算",
  external: "文件的外部修改",
  script: "脚本",
  unknown: "对方",
};

function Bar({
  tone,
  icon,
  children,
}: {
  tone: "warn" | "error";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-shrink-0 items-start gap-2 border-b px-3 py-2 text-xs",
        tone === "warn"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon ?? <AlertTriangle className="h-3.5 w-3.5" />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function BarButton({
  primary,
  onClick,
  children,
  disabled,
}: {
  primary?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors disabled:opacity-50",
        primary
          ? "text-white hover:opacity-90"
          : "border border-current/25 bg-background/60 hover:bg-background",
      )}
      style={primary ? { backgroundColor: "var(--em-primary)" } : undefined}
    >
      {children}
    </button>
  );
}

function ValueChip({ label, value }: { label: string; value: CellValue | null }) {
  const text =
    value === null
      ? "读取中…"
      : value.kind === "text"
        ? value.text
        : value.kind === "empty"
          ? "（空）"
          : "格式修改";
  const plain = value?.kind === "text";
  return (
    <span className="inline-flex min-w-0 max-w-64 items-baseline gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-foreground">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn("min-w-0 truncate font-mono", !plain && "font-sans text-muted-foreground")}
        title={plain ? text : undefined}
      >
        {text}
      </span>
    </span>
  );
}

function partyName(conflict: DocConflict): string {
  const parties = conflictParties(conflict);
  return PARTY_NAME[(parties.length === 1 ? parties[0] : undefined) ?? "unknown"];
}

/** 提交被服务端拒绝：表格已撤回到最新版本，并排列出「你的输入 / 对方的值」二选一。 */
function ChoiceBar({ conflict, api }: { conflict: DocConflict; api: SheetApi | null }) {
  const who = partyName(conflict);
  const sheets = useWorkbookStore((s) => s.doc?.snapshot.sheets) as
    | Record<string, { name?: string }>
    | undefined;
  // 表格已按冲突后的快照重建，对方的值才读得到；订阅修订号让对方再次改动时重新读取
  const loaded = useWorkbookStore((s) => (s.doc?.snapshotRev ?? 0) >= conflictRevision(conflict));
  useWorkbookStore((s) => s.doc?.rev);
  const cells = useMemo(
    () => conflictCells(conflict, (id) => sheets?.[id]?.name),
    [conflict, sheets],
  );
  const shown = cells.slice(0, SHOWN_CELLS);
  const theirs = (cell: ConflictCell): CellValue =>
    describeCell(
      api?.wb.getSheetBySheetId(cell.sheetId)?.getRange(cell.row, cell.col).getCellData(),
    );
  return (
    <Bar tone="warn">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <strong className="font-semibold">你的修改和{who}的修改冲突了</strong>
        <span className="opacity-80">表格已更新为最新内容，选一个保留</span>
        <span className="min-w-2 flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <BarButton onClick={() => dismissDocConflict(conflict.clientOpId)}>采用{who}的</BarButton>
          <BarButton
            primary
            onClick={() => resubmitRejected(conflict.clientOpId, { overwrite: true })}
          >
            保留我的
          </BarButton>
        </div>
      </div>
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {shown.map((cell) => (
            <li
              key={`${cell.sheetId}:${cell.row}:${cell.col}`}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            >
              <span className="w-9 shrink-0 font-mono text-[11px] font-semibold">
                {cell.address}
              </span>
              <ValueChip label="你的输入" value={cell.mine} />
              <ValueChip label={`${who}的值`} value={loaded ? theirs(cell) : null} />
            </li>
          ))}
          {cells.length > shown.length && (
            <li className="opacity-80">另有 {cells.length - shown.length} 处</li>
          )}
        </ul>
      ) : (
        <span className="min-w-0 truncate">冲突区域：{conflictRegions(conflict).join("、")}</span>
      )}
    </Bar>
  );
}

/** 断线时没发出去的编辑：本地内容还在，连接恢复后可以重新发送，或放弃并回到服务端版本。 */
function OfflineBar({ conflict }: { conflict: DocConflict }) {
  const discard = () => {
    dismissDocConflict(conflict.clientOpId);
    void reloadDocument().catch(() => undefined);
  };
  return (
    <Bar tone="warn" icon={<WifiOff className="h-3.5 w-3.5" />}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <strong className="font-semibold">连接已断开，这次修改还没有保存</strong>
        <span className="opacity-80">连接恢复后可以重新发送</span>
        <span className="min-w-2 flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <BarButton onClick={discard}>放弃修改</BarButton>
          {conflict.submitted && (
            <BarButton
              primary
              onClick={() => resubmitRejected(conflict.clientOpId, { overwrite: false })}
            >
              重新发送
            </BarButton>
          )}
        </div>
      </div>
    </Bar>
  );
}

/** 不能二选一的拒绝：结构冲突、写回不支持的格式等，只说明原因。 */
function FailedBar({ conflict }: { conflict: DocConflict }) {
  const regions = conflictRegions(conflict);
  return (
    <Bar tone="warn">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <strong className="font-semibold">这次表格修改没有生效</strong>
        {conflict.message && <span className="min-w-0">{conflict.message}</span>}
        {regions.length > 0 && (
          <span className="min-w-0 truncate">冲突区域：{regions.join("、")}</span>
        )}
        {conflict.code !== "VERSION_CONFLICT" && (
          <span className="font-mono text-[11px] opacity-70">错误码 {conflict.code}</span>
        )}
        <span className="min-w-2 flex-1" />
        <BarButton onClick={() => dismissDocConflict(conflict.clientOpId)}>知道了</BarButton>
      </div>
    </Bar>
  );
}

export function SubmitConflictBar({ api }: { api: SheetApi | null }) {
  // latestDocConflict 每次返回新对象，不能直接作 store 选择器（否则无限重渲染）
  const docSync = useWorkbookStore((s) => s.docSync);
  const conflict = useMemo(() => latestDocConflict(docSync), [docSync]);
  if (!conflict) return null;
  if (conflict.code === "offline") return <OfflineBar conflict={conflict} />;
  if (canKeepMine(conflict)) return <ChoiceBar conflict={conflict} api={api} />;
  return <FailedBar conflict={conflict} />;
}

/** 正在输入的单元格被对方改写：草稿还在，选择是否把它写回去。 */
export function DraftConflictBar({ api }: { api: SheetApi | null }) {
  const draft = useWorkbookStore((s) => s.draftConflict);
  const sheets = useWorkbookStore((s) => s.doc?.snapshot.sheets) as
    | Record<string, { name?: string }>
    | undefined;
  if (!draft) return null;
  const who = PARTY_NAME[partyOf(draft.source) ?? "unknown"];
  const sheetName = sheets?.[draft.sheetId]?.name;
  const address = formatRange({
    startCol: draft.col + 1,
    startRow: draft.row + 1,
    endCol: draft.col + 1,
    endRow: draft.row + 1,
  });
  const keepMine = () => {
    const range = api?.wb.getSheetBySheetId(draft.sheetId)?.getRange(draft.row, draft.col);
    setDraftConflict(null);
    // 以普通编辑写回草稿：同一写入路径，服务端照常判冲突
    void range?.setValue(draft.text);
  };
  return (
    <Bar tone="warn">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <strong className="font-semibold">
          你正在输入的 {sheetName ? `${sheetName}!` : ""}
          {address} 被{who}改写了
        </strong>
        <span className="min-w-2 flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <BarButton onClick={() => setDraftConflict(null)}>采用{who}的</BarButton>
          <BarButton primary disabled={!api} onClick={keepMine}>
            写回我的输入
          </BarButton>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ValueChip
          label="你的输入"
          value={draft.text ? { kind: "text", text: draft.text } : { kind: "empty" }}
        />
        <ValueChip label={`${who}的值`} value={describeCell(draft.theirs)} />
      </div>
    </Bar>
  );
}

/** 文件在应用外被修改，而应用里还有未写回的修订：写回暂停，等用户二选一（另一份存入备份区）。 */
export function ExternalConflictBar() {
  const conflict = useWorkbookStore((s) => s.doc?.externalConflict === true);
  const [busy, setBusy] = useState(false);
  if (!conflict) return null;
  const choose = (choice: "keepApp" | "loadExternal") => {
    setBusy(true);
    void resolveExternal(choice)
      .then((backup) =>
        toast({
          tone: "success",
          title: "已处理外部修改",
          description: `另一份版本已存入备份：${backup}`,
        }),
      )
      .catch((error: unknown) =>
        toast({ tone: "error", title: errorMessage(error, "处理失败，请重试") }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Bar tone="warn" icon={<RefreshCw className="h-3.5 w-3.5" />}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <strong className="font-semibold">文件在应用外被修改了</strong>
        <span className="opacity-80">
          应用里还有未写回的修改，已暂停写回。选择保留哪一份，另一份会存入备份。
        </span>
        <span className="min-w-2 flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <BarButton disabled={busy} onClick={() => choose("loadExternal")}>
            载入外部版本
          </BarButton>
          <BarButton primary disabled={busy} onClick={() => choose("keepApp")}>
            保留应用里的修改
          </BarButton>
        </div>
      </div>
    </Bar>
  );
}

/** 写回文件失败（检查点错误）：修改仍在应用里，修复原因后会继续写回。 */
export function CheckpointErrorBar() {
  const error = useWorkbookStore((s) =>
    s.doc?.externalConflict ? undefined : s.doc?.checkpointError,
  );
  if (!error) return null;
  return (
    <Bar tone="error">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <strong className="font-semibold">修改还没有写回文件</strong>
        <span className="min-w-0 break-all">{error}</span>
      </div>
    </Bar>
  );
}

/** 用户改了代理读过的区域（02 §4.7）：代理下一步会重新读取，期间在表格上方说明。 */
export function AgentRereadBar() {
  const doc = useWorkbookStore((s) => s.doc);
  const notices = useChatStore((s) => s.session.docNotices);
  const roster = useChatStore((s) => s.session.roster);
  const hits = useMemo(
    () =>
      doc
        ? Object.entries(notices).filter(
            ([, n]) => n.docId === doc.docId || samePath(n.path, doc.path),
          )
        : [],
    [doc, notices],
  );
  if (hits.length === 0) return null;
  const names = hits.map(([agentId]) =>
    agentId === "main" ? "代理" : (roster[agentId]?.name ?? agentId),
  );
  const ranges = [...new Set(hits.flatMap(([, n]) => n.ranges))];
  return (
    <div role="status" className="em-reread-bar">
      <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        表格刚被你修改
        {ranges.length > 0 && (
          <span className="em-reread-ranges">{ranges.slice(0, 3).join("、")}</span>
        )}
        ，{names.join("、")}正在重新读取
      </span>
    </div>
  );
}
