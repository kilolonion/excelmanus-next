import { OBJECT_LAYER_MUTATION, type ThreadComment, WorkbookObjects } from "@excelmanus/protocol";
import { Check, MessageSquare, Plus, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createDateLabels } from "@/lib/date-labels";
import { createStableCommentSheets, indexCommentReplies } from "@/lib/workbook/comment-threads";
import { useWorkbookStore } from "@/stores/workbook-store";
import type { SheetApi } from "./FormatToolbar";

type Draft = { sheetId: string; ref: string; parentId?: string };
const COMMENT_LIST_MUTATIONS = new Set([
  OBJECT_LAYER_MUTATION,
  "sheet.mutation.set-worksheet-name",
  "sheet.mutation.set-worksheet-order",
  "sheet.mutation.insert-sheet",
  "sheet.mutation.remove-sheet",
]);
const guid = () => `{${crypto.randomUUID().toUpperCase()}}`;
export function ThreadedCommentsPanel({ api, onClose }: { api: SheetApi; onClose(): void }) {
  const revision = useWorkbookStore((s) => s.doc?.rev);
  const [epoch, setEpoch] = useState(0),
    [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState(""),
    [author, setAuthor] = useState("本地用户");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [showResolved, setShowResolved] = useState(false);
  useEffect(() => {
    const sub = api.wb.onCommandExecuted((c) => {
      if (COMMENT_LIST_MUTATIONS.has(c.id)) setEpoch((n) => n + 1);
    });
    return () => sub.dispose();
  }, [api]);
  const stabilizeSheets = useMemo(() => {
    void api; // A replacement workbook owns a fresh display cache.
    return createStableCommentSheets();
  }, [api]);
  const sheets = useMemo(() => {
    void epoch;
    void revision;
    if (api.disposed) return stabilizeSheets([]);
    return stabilizeSheets(
      api.wb.getSheets().map((facade) => {
        const id = facade.getSheetId();
        const sheet = facade.getSheet().getSnapshot();
        const parsed = WorkbookObjects.safeParse(
          sheet.custom?.excelmanusObjects ?? { charts: [], images: [] },
        );
        const comments = parsed.success ? (parsed.data.threadedComments ?? []) : [];
        return { id, name: sheet.name, comments };
      }),
    );
  }, [api, api.disposed, epoch, revision, stabilizeSheets]);
  const roots = useMemo(
    () =>
      sheets.flatMap((sheet) => {
        const replies = indexCommentReplies(sheet.comments);
        return sheet.comments
          .filter((c) => !c.parentId)
          .map((root) => ({
            sheet,
            root,
            replies: replies.get(root.id) ?? [],
          }));
      }),
    [sheets],
  );
  const visible = useMemo(
    () => roots.filter(({ root }) => showResolved || !root.done),
    [roots, showResolved],
  );
  const commit = useCallback(
    async (sheetId: string, change: (comments: ThreadComment[]) => ThreadComment[]) => {
      if (api.disposed) throw Error("表格已关闭");
      const sheet = api.wb.getSheetBySheetId(sheetId)?.getSheet().getSnapshot();
      if (!sheet) throw Error("工作表已不存在");
      const objects = WorkbookObjects.parse(
        sheet.custom?.excelmanusObjects ?? { charts: [], images: [] },
      );
      objects.threadedComments = change(objects.threadedComments ?? []);
      if (
        !(await api.univerAPI.executeCommand(OBJECT_LAYER_MUTATION, {
          unitId: api.wb.getId(),
          subUnitId: sheetId,
          objects,
        }))
      )
        throw Error("批注修改未完成");
      setEpoch((n) => n + 1);
    },
    [api],
  );
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "批注操作失败");
    } finally {
      setBusy(false);
    }
  }, []);
  async function begin() {
    await run(async () => {
      await api.wb.endEditingAsync(true);
      const sheet = api.wb.getActiveSheet();
      const range = sheet?.getSelection()?.getActiveRange()?.getRange();
      if (!sheet || !range) throw Error("请先选择一个单元格");
      const ref = sheet.getRange(range.startRow, range.startColumn, 1, 1).getA1Notation();
      const existing = sheets
        .find((s) => s.id === sheet.getSheetId())
        ?.comments.find((c) => !c.parentId && c.ref === ref && !c.done);
      setDraft({
        sheetId: sheet.getSheetId(),
        ref,
        ...(existing ? { parentId: existing.id } : {}),
      });
      setText("");
    });
  }
  async function submit() {
    if (!draft || !text.trim() || !author.trim()) return;
    const target = draft,
      body = text.trim(),
      name = author.trim();
    await run(async () => {
      await commit(target.sheetId, (comments) => {
        const parent = target.parentId ? comments.find((c) => c.id === target.parentId) : undefined;
        if (target.parentId && (!parent || parent.done))
          throw Error("这条批注已解决或不存在，请刷新后重试");
        return [
          ...comments,
          {
            id: guid(),
            personId: guid(),
            author: name,
            ref: target.ref,
            text: body,
            dateTime: new Date().toISOString(),
            done: false,
            ...(parent ? { parentId: parent.id } : {}),
          },
        ];
      });
      setDraft(null);
      setText("");
    });
  }
  const locate = useCallback(
    (sheetId: string, ref: string) => {
      const sheet = api.wb.getSheetBySheetId(sheetId);
      if (sheet) {
        api.wb.setActiveSheet(sheet);
        sheet.getRange(ref).activate();
      }
    },
    [api],
  );
  const threadRows = useMemo(() => {
    const formatTimestamp = createDateLabels(
      { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" },
      "",
    );
    return visible.map(({ sheet, root, replies }) => (
      <section key={root.id} className="border-b border-[var(--em-hairline)] py-3">
        <div className="mb-2 flex items-center gap-1">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-xs font-medium text-[var(--em-primary)] hover:underline"
            onClick={() => locate(sheet.id, root.ref)}
            title={`${sheet.name}!${root.ref}`}
          >
            {sheet.name} · {root.ref}
          </button>
          {root.done && <span className="text-[10px] text-muted-foreground">已解决</span>}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={root.done ? "重新打开批注" : "解决批注"}
            disabled={busy}
            onClick={() =>
              void run(() =>
                commit(sheet.id, (comments) =>
                  comments.map((c) => (c.id === root.id ? { ...c, done: !root.done } : c)),
                ),
              )
            }
          >
            {root.done ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          </Button>
        </div>
        {[root, ...replies].map((c, i) => (
          <div key={c.id} className={i ? "mt-3 border-l border-[var(--em-hairline)] pl-3" : ""}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs font-medium">{c.author || "未知作者"}</span>
              <time dateTime={c.dateTime} className="text-[10px] text-muted-foreground">
                {formatTimestamp(c.dateTime)}
              </time>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{c.text}</p>
          </div>
        ))}
        {!root.done && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-6 px-0 text-xs text-muted-foreground"
            disabled={busy}
            onClick={() => {
              setDraft({ sheetId: sheet.id, ref: root.ref, parentId: root.id });
              setText("");
              setError("");
            }}
          >
            回复
          </Button>
        )}
      </section>
    ));
  }, [visible, busy, commit, run, locate]);
  if (api.disposed) return null;
  return (
    <aside
      aria-label="工作簿批注"
      className="absolute inset-y-0 right-0 z-30 flex w-80 max-w-full flex-col border-l border-[var(--em-hairline)] bg-background shadow-[-4px_0_16px_rgba(0,0,0,0.03)]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--em-hairline)] px-3">
        <MessageSquare className="size-4 text-[var(--em-primary)]" />
        <h3 className="flex-1 text-sm font-semibold">批注</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="关闭批注面板"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex items-center justify-between border-b border-[var(--em-hairline)] px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-1 text-xs"
          onClick={() => void begin()}
          disabled={busy}
        >
          <Plus className="size-3.5" />
          新建批注
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-1 text-xs text-muted-foreground"
          aria-pressed={showResolved}
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? "隐藏已解决" : "显示已解决"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {error && (
          <p role="alert" className="py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {!visible.length && !draft && (
          <div className="py-10 text-center text-xs leading-6 text-muted-foreground">
            暂无{showResolved ? "" : "未解决的"}批注
            <br />
            选中单元格后新建批注，或查看已解决的讨论。
          </div>
        )}
        {threadRows}
      </div>
      {draft && (
        <form
          className="space-y-2 border-t border-[var(--em-hairline)] bg-muted/20 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-xs font-medium">
            {draft.parentId ? "回复" : "新建"} · {sheets.find((s) => s.id === draft.sheetId)?.name}!
            {draft.ref}
          </p>
          <Input
            aria-label="批注署名"
            value={author}
            maxLength={500}
            onChange={(e) => setAuthor(e.target.value)}
            className="h-8 text-xs"
            placeholder="署名"
          />
          <Textarea
            aria-label="线程批注内容"
            value={text}
            maxLength={32767}
            onChange={(e) => setText(e.target.value)}
            placeholder="写下需要讨论的内容…"
            className="min-h-20 resize-y text-xs"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-7 text-xs"
              disabled={busy || !text.trim() || !author.trim()}
            >
              {busy ? "正在保存…" : draft.parentId ? "发送回复" : "添加批注"}
            </Button>
          </div>
        </form>
      )}
    </aside>
  );
}
