// 工作簿并排对比（一代「对比」）：按表名配对逐格比较值与公式，不比较样式。点差异格在工作台定位。

import type { ApiClient, FileEntry } from "@excelmanus/protocol";
import { ArrowRightLeft, Columns2, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { GlassSelect } from "@/components/settings/model/form-widgets";
import { OverlayCard, OverlayCardBody, OverlayCardHeader } from "@/components/ui/overlay-card";
import { api, errorMessage } from "@/lib/backend/api";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { openWorkspaceFile } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { listAllFiles } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";

type Result = Awaited<ReturnType<ApiClient["compareDocs"]>>;
type Value = Result["sheets"][number]["cells"][number]["left"];

const KIND_LABEL = { added: "新增", deleted: "删除", modified: "修改" } as const;
const STATUS_LABEL = { both: "", leftOnly: "仅左侧有", rightOnly: "仅右侧有" } as const;

function show(v: Value): string {
  if (!v) return "";
  if (v.formula) return v.formula.startsWith("=") ? v.formula : `=${v.formula}`;
  if (v.value === null) return "";
  return String(v.value);
}

const fileName = (path: string) => path.split("/").pop() ?? path;

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

function CompareBody({ left: initialLeft, initialRight }: { left: string; initialRight?: string }) {
  const workspaceId = useChatStore((s) => s.workspaceId);
  const close = useUIStore((s) => s.closeCompare);
  const [left, setLeft] = useState(initialLeft);
  const [right, setRight] = useState(initialRight ?? "");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listAllFiles(1000, 6)
      .then((all) => alive && setFiles(all.filter((f) => isSpreadsheetFile(f.name))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!workspaceId || !left || !right || left === right) {
      setResult(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api()
      .compareDocs(workspaceId, { left: { path: left }, right: { path: right }, limit: 2000 })
      .then((res) => {
        if (!alive) return;
        setResult(res);
        const first = res.sheets.find((s) => s.changed > 0 || s.status !== "both") ?? res.sheets[0];
        setSheet(first?.name ?? null);
      })
      .catch((err: unknown) => alive && setError(errorMessage(err, "对比失败")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [workspaceId, left, right]);

  const options = useMemo(() => files.map((f) => ({ value: f.path, label: f.path })), [files]);
  const current = result?.sheets.find((s) => s.name === sheet) ?? null;
  const total = result?.sheets.reduce((n, s) => n + s.changed, 0) ?? 0;

  const locate = (path: string, cell: string) => {
    close();
    openWorkspaceFile(path, { range: `${current?.name ?? ""}!${cell}` });
  };

  return (
    <>
      <OverlayCardHeader
        icon={<Columns2 className="h-5 w-5" />}
        title="表格对比"
        description="逐格比较两个工作簿的值和公式（不比较样式）。点差异格可在工作台中定位。"
        onClose={close}
      />
      <OverlayCardBody className="space-y-3 pb-5">
        <div className="em-compare-pick">
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
            options={options.filter((o) => o.value !== left)}
            onChange={setRight}
            align="end"
            className="min-w-0 flex-1"
          />
        </div>

        {!right ? (
          <p className="em-compare-empty">选择右侧的表格后开始对比。</p>
        ) : loading ? (
          <p className="em-compare-empty">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在对比…
          </p>
        ) : error ? (
          <p role="alert" className="em-compare-empty text-destructive">
            {error}
          </p>
        ) : result ? (
          <>
            <div className="em-compare-summary" role="status">
              {total === 0 && result.sheets.every((s) => s.status === "both")
                ? "两个表格的值和公式完全一致。"
                : `共 ${total} 处差异${result.truncated ? "（只列出前 2000 处）" : ""}`}
            </div>
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
            {current && current.status !== "both" ? (
              <p className="em-compare-empty">
                工作表「{current.name}」只在{current.status === "leftOnly" ? "左侧" : "右侧"}
                的「{fileName(current.status === "leftOnly" ? result.left.path : result.right.path)}
                」中存在。
              </p>
            ) : current && current.cells.length === 0 ? (
              <p className="em-compare-empty">这张工作表没有差异。</p>
            ) : current ? (
              <div className="em-compare-table-wrap">
                <table className="em-compare-table">
                  <thead>
                    <tr>
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
                    {current.cells.map((c) => (
                      <tr key={c.cell}>
                        <td>
                          <button
                            type="button"
                            className="em-compare-cell"
                            title="在左侧表格中定位"
                            onClick={() => locate(result.left.path, c.cell)}
                          >
                            {c.cell}
                          </button>
                        </td>
                        <td>
                          <span className="em-compare-kind" data-kind={c.kind}>
                            {KIND_LABEL[c.kind]}
                          </span>
                        </td>
                        <td className="em-compare-value" data-side="left">
                          {show(c.left)}
                        </td>
                        <td className="em-compare-value" data-side="right">
                          {show(c.right)}
                        </td>
                      </tr>
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
