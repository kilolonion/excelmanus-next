// 工作簿并排对比（一代「对比」）：按表名配对逐格比较值与公式，不比较样式。点差异格在工作台定位。

import type { ApiClient, FileEntry } from "@excelmanus/protocol";
import { ArrowRightLeft, Columns2, Loader2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { GlassSelect } from "@/components/settings/model/form-widgets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { OverlayCard, OverlayCardBody, OverlayCardHeader } from "@/components/ui/overlay-card";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { openWorkspaceFile } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { listAllFiles, useFilesStore } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";

type Result = Awaited<ReturnType<ApiClient["compareDocs"]>>;
type DiffCell = Result["sheets"][number]["cells"][number];
type Value = DiffCell["left"];
const calculationOnly = (cell: DiffCell) =>
  Boolean(cell.left?.formula && cell.left.formula === cell.right?.formula);

const KIND_LABEL = { added: "新增", deleted: "删除", modified: "修改" } as const;
const STATUS_LABEL = { both: "", leftOnly: "仅左侧有", rightOnly: "仅右侧有" } as const;

function show(v: Value): string {
  if (!v) return "";
  if (v.formula) {
    const formula = v.formula.startsWith("=") ? v.formula : `=${v.formula}`;
    return `${formula} → ${v.value == null ? "（无缓存值）" : String(v.value)}`;
  }
  if (v.value === null) return "";
  return String(v.value);
}

const fileName = (path: string) => path.split("/").pop() ?? path;
const keyOf = (name: string, cell: string) => JSON.stringify([name, cell]);

export function CompareDialog() {
  const compare = useUIStore((s) => s.compare);
  const close = useUIStore((s) => s.closeCompare);
  return (
    <OverlayCard
      open={compare !== null}
      onOpenChange={(open) => !open && close()}
      size="lg"
      tone="primary"
      style={{ "--overlay-card-width": "min(960px, calc(100vw - 24px))" } as React.CSSProperties}
    >
      {compare && (
        <CompareBody key={compare.left} left={compare.left} initialRight={compare.right} />
      )}
    </OverlayCard>
  );
}

export async function readComparisonFiles(
  isActive = () => true,
): Promise<{ files: FileEntry[]; error: string | null }> {
  try {
    const all = await listAllFiles(1000, 6, isActive);
    return { files: all.filter((f) => isSpreadsheetFile(f.name)), error: null };
  } catch (error) {
    return { files: [], error: errorMessage(error, "表格列表读取失败") };
  }
}

function CompareBody({ left: initialLeft, initialRight }: { left: string; initialRight?: string }) {
  const fileVersion = useFilesStore((s) => s.version);
  const workspaceId = useChatStore((s) => s.workspaceId);
  const close = useUIStore((s) => s.closeCompare);
  const [left, setLeft] = useState(initialLeft);
  const [right, setRight] = useState(initialRight ?? "");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesRetry, setFilesRetry] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [sheet, setSheet] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFilesLoading(true);
    setFilesError(null);
    void readComparisonFiles(() => alive).then((res) => {
      if (!alive) return;
      setFiles(res.files);
      setFilesError(res.error);
      setFilesLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [fileVersion, workspaceId, filesRetry]);

  useEffect(() => {
    if (!workspaceId || !left || !right || left === right) {
      setResult(null);
      setLoading(false);
      setError(null);
      setSelected(new Set());
      return;
    }
    let alive = true;
    setSelected(new Set());
    setResult(null);
    setLoading(true);
    setError(null);
    api()
      .compareDocs(workspaceId, { left: { path: left }, right: { path: right }, limit: 2000 })
      .then((res) => {
        if (!alive) return;
        setResult(res);
        const first = res.sheets.find((s) => s.changed > 0 || s.status !== "both") ?? res.sheets[0];
        setSheet((previous) =>
          res.sheets.some((s) => s.name === previous) ? previous : (first?.name ?? null),
        );
      })
      .catch((err: unknown) => alive && setError(errorMessage(err, "对比失败")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [workspaceId, left, right, refresh]);

  const options = useMemo(() => files.map((f) => ({ value: f.path, label: f.path })), [files]);
  const { byName, total, available } = useMemo(() => {
    const sheets = result?.sheets ?? [];
    return {
      byName: new Map(sheets.map((s) => [s.name, s])),
      total: sheets.reduce((n, s) => n + s.changed, 0),
      available: sheets.flatMap((s) =>
        s.cells
          .filter((c) => !calculationOnly(c))
          .map((c) => ({
            key: keyOf(s.name, c.cell),
            target: { sheet: s.name, cell: c.cell },
          })),
      ),
    };
  }, [result]);
  const current = sheet !== null ? (byName.get(sheet) ?? null) : null;
  const chosen = useMemo(
    () => available.filter((c) => selected.has(c.key)).map((c) => c.target),
    [available, selected],
  );
  const merge = async () => {
    if (!result || !workspaceId || merging || !chosen.length) return;
    setMerging(true);
    try {
      const missing = [
        ...new Set(
          chosen.filter((c) => byName.get(c.sheet)?.status === "rightOnly").map((c) => c.sheet),
        ),
      ];
      const ok = await confirmAction({
        title: `合并 ${chosen.length} 处差异到左侧？`,
        description: `目标：${result.left.path}。右侧为空的选中格将清空左侧内容，公式将在目标中重新计算。保留目标样式，可在修订历史一次撤销。${missing.length ? ` 将新建工作表：${missing.join("、")}，只填入勾选内容。` : ""}`,
        confirmLabel: "确认合并",
      });
      if (!ok) return;
      const merged = await api().mergeDocs(workspaceId, {
        sourceDocId: result.right.docId,
        targetDocId: result.left.docId,
        sourceRev: result.right.rev,
        targetRev: result.left.rev,
        cells: chosen,
      });
      toast({
        tone: "success",
        title: `已合并 ${chosen.length} 处差异`,
        description: `修订 ${merged.rev}，可在修订历史撤销。`,
      });
      setSelected(new Set());
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err, "合并失败"));
    } finally {
      setMerging(false);
    }
  };

  const locate = useCallback(
    (cell: string) => {
      if (!current || !result) return;
      close();
      openWorkspaceFile(current.status === "rightOnly" ? result.right.path : result.left.path, {
        range: `${current.name}!${cell}`,
      });
    },
    [close, current, result],
  );
  const selectCell = useCallback((key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const comparisonRows = useMemo(
    () =>
      current?.cells.map((cell) => ({
        key: keyOf(current.name, cell.cell),
        cell,
      })) ?? [],
    [current],
  );
  const rightOptions = useMemo(
    () => options.filter((option) => option.value !== left),
    [options, left],
  );

  return (
    <>
      <OverlayCardHeader
        icon={<Columns2 className="h-5 w-5" />}
        title="表格对比与合并"
        description="勾选差异，将右侧值和公式合并到左侧。保留目标样式，源工作簿不变。"
        onClose={close}
      />
      <OverlayCardBody className="space-y-3 pb-5">
        <fieldset
          disabled={merging || filesLoading || Boolean(filesError)}
          className="em-compare-pick"
        >
          <GlassSelect
            ariaLabel="左侧表格"
            value={left}
            options={options.length ? options : [{ value: left, label: left }]}
            onChange={setLeft}
            align="start"
            className="min-w-0 flex-1"
          />
          <button
            type="button"
            className="em-compare-swap"
            aria-label="交换左右"
            title="交换左右"
            disabled={!right}
            onClick={() => {
              setLeft(right);
              setRight(left);
            }}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
          </button>
          <GlassSelect
            ariaLabel="右侧表格"
            value={right}
            placeholder="选择要对比的表格"
            options={rightOptions}
            onChange={setRight}
            align="end"
            className="min-w-0 flex-1"
          />
        </fieldset>

        {filesLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取工作区表格…
          </p>
        ) : filesError ? (
          <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <span>表格列表读取失败：{filesError}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={merging}
              onClick={() => setFilesRetry((n) => n + 1)}
            >
              重新读取列表
            </Button>
          </div>
        ) : null}

        {!right ? (
          <p className="em-compare-empty">选择右侧的表格后开始对比。</p>
        ) : left === right ? (
          <p role="status" className="em-compare-empty">
            请选择两份不同的表格。
          </p>
        ) : loading ? (
          <p className="em-compare-empty">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在对比…
          </p>
        ) : error ? (
          <p role="alert" className="em-compare-empty text-destructive">
            {error}
            <Button
              size="sm"
              variant="outline"
              disabled={merging}
              onClick={() => setRefresh((n) => n + 1)}
            >
              重新对比
            </Button>
          </p>
        ) : result ? (
          <>
            <div className="em-compare-summary" role="status">
              {total === 0 && result.sheets.every((s) => s.status === "both")
                ? "两个表格的值和公式完全一致。"
                : `共 ${total} 处差异${result.truncated ? "（只列出前 2000 处）" : ""}`}
            </div>
            {available.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    aria-label="选择已列出的全部差异"
                    disabled={merging}
                    checked={chosen.length === available.length}
                    onCheckedChange={(checked) =>
                      setSelected(checked ? new Set(available.map((c) => c.key)) : new Set())
                    }
                  />
                  选择已列出的差异
                </label>
                <span className="text-sm text-muted-foreground">已选 {chosen.length} 处</span>
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={merging || !chosen.length}
                  onClick={() => void merge()}
                >
                  {merging ? "正在处理…" : "右侧 → 合并到左侧"}
                </Button>
                {result.truncated && (
                  <p className="w-full text-xs text-muted-foreground">
                    未列出的差异不会合并；完成后可重新对比继续处理。
                  </p>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              公式相同而结果不同的格只展示，不重复合并；结果取决于目标表的数据。
            </p>
            <div className="em-compare-tabs" role="tablist" aria-label="工作表">
              {result.sheets.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  role="tab"
                  aria-selected={s.name === sheet}
                  className={cn("em-compare-tab", s.name === sheet && "is-active")}
                  onClick={() => setSheet(s.name)}
                >
                  <span className="truncate">{s.name}</span>
                  {s.status !== "both" ? (
                    <span className="em-compare-count" data-tone="muted">
                      {STATUS_LABEL[s.status]}
                    </span>
                  ) : s.changed > 0 ? (
                    <span className="em-compare-count">{s.changed}</span>
                  ) : null}
                </button>
              ))}
            </div>
            {current && current.status !== "both" && (
              <p className="text-sm text-muted-foreground">
                {current.status === "rightOnly"
                  ? `左侧没有「${current.name}」，合并时新建工作表，仅写入勾选内容。`
                  : `右侧没有「${current.name}」，选中格将清空内容，保留左侧工作表。`}
              </p>
            )}
            {current && current.cells.length === 0 ? (
              <p className="em-compare-empty">
                {current.changed
                  ? "此表差异未列出，请先处理已列出的差异后重新对比。"
                  : "这张工作表没有单元格差异。"}
              </p>
            ) : current ? (
              <div className="em-compare-table-wrap">
                <table className="em-compare-table">
                  <thead>
                    <tr>
                      <th scope="col">合并</th>
                      <th scope="col">单元格</th>
                      <th scope="col">变化</th>
                      <th scope="col" title={result.left.path}>
                        {fileName(result.left.path)}
                      </th>
                      <th scope="col" title={result.right.path}>
                        {fileName(result.right.path)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRows.map(({ key, cell }) => (
                      <ComparisonRow
                        key={key}
                        selectionKey={key}
                        cell={cell}
                        sheet={current.name}
                        rightOnly={current.status === "rightOnly"}
                        selected={selected.has(key)}
                        merging={merging}
                        onSelect={selectCell}
                        onLocate={locate}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}
      </OverlayCardBody>
    </>
  );
}

const ComparisonRow = memo(function ComparisonRow({
  selectionKey,
  cell,
  sheet,
  rightOnly,
  selected,
  merging,
  onSelect,
  onLocate,
}: {
  selectionKey: string;
  cell: DiffCell;
  sheet: string;
  rightOnly: boolean;
  selected: boolean;
  merging: boolean;
  onSelect: (key: string, checked: boolean) => void;
  onLocate: (cell: string) => void;
}) {
  const calculation = calculationOnly(cell);
  return (
    <tr>
      <td>
        <Checkbox
          aria-label={`合并 ${sheet}!${cell.cell}`}
          disabled={merging || calculation}
          title={calculation ? "公式相同，仅计算结果不同；请检查目标表引用的数据" : undefined}
          checked={selected}
          onCheckedChange={(checked) => onSelect(selectionKey, Boolean(checked))}
        />
      </td>
      <td>
        <button
          type="button"
          className="em-compare-cell"
          title={rightOnly ? "在右侧表格中定位" : "在左侧表格中定位"}
          onClick={() => onLocate(cell.cell)}
        >
          {cell.cell}
        </button>
      </td>
      <td>
        <span className="em-compare-kind" data-kind={cell.kind}>
          {calculation ? "计算结果" : KIND_LABEL[cell.kind]}
        </span>
      </td>
      <td className="em-compare-value" data-side="left">
        {show(cell.left)}
      </td>
      <td className="em-compare-value" data-side="right">
        {show(cell.right)}
      </td>
    </tr>
  );
});
