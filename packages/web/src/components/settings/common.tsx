// 设置中心共用的小组件与工具函数。

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { S, ST } from "../../strings.ts";
import { useConfirm } from "../ui/confirm.tsx";
import { Alert, Card, EmptyState } from "../ui/display.tsx";
import { Field as UiField } from "../ui/field.tsx";
import { toast } from "../ui/overlay.tsx";
import { Skeleton } from "../ui/spinner.tsx";

/** 加载一次并可手动刷新的异步数据。 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 依赖由调用方给出；序列化为稳定键，避免每次渲染重建
  const key = JSON.stringify(deps);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load 随调用方闭包变化，重新加载只由 key 驱动
  const reload = useCallback(() => {
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [key]);
  useEffect(() => reload(), [reload]);
  return { data, error, reload };
}

/** 保存反馈：成功用提示框（附录 C P-14），失败留在原位。 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, okText: string = ST.saved): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      toast({ tone: "ok", title: okText });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : ST.saveFailed });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, run, clear: () => setMsg(null) };
}

/** 只在原位显示错误；成功已经以提示框告知。 */
export function Feedback({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg || msg.ok) return null;
  return (
    <Alert layout="inline" tone="err" role="alert">
      {msg.text}
    </Alert>
  );
}

export function Section({
  title,
  hint,
  children,
  actions,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h3 className="text-md font-semibold">{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {hint && <p className="-mt-1.5 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

/** 设置表单字段：标签与说明经 context 关联到内部控件（ui/field.tsx）。 */
export function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <UiField label={label} description={hint} className={className}>
      {children}
    </UiField>
  );
}

/** 列表卡片容器（设置中心统一外观） */
export function ItemCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card elevation="flat" className={`flex flex-col gap-2 p-3.5 ${className ?? ""}`}>
      {children}
    </Card>
  );
}

export function Loading() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label={ST.loading}>
      <Skeleton className="h-16" />
      <Skeleton className="h-16 opacity-70" />
    </div>
  );
}

export function Empty({ text = ST.empty }: { text?: string }) {
  return <EmptyState size="section" title={text} />;
}

/** "名称: 值" 或 "KEY=值" 多行文本 ↔ 对象。 */
export function parsePairs(text: string, sep: ":" | "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k !== "") out[k] = line.slice(i + 1).trim();
  }
  return out;
}

export function formatPairs(rec: Record<string, string> | undefined, sep: ":" | "="): string {
  if (!rec) return "";
  return Object.entries(rec)
    .map(([k, v]) => `${k}${sep === ":" ? ": " : "="}${v}`)
    .join("\n");
}

/** 删除确认（应用内确认框）：title 为具体动作，返回是否确认 */
export function useConfirmDelete() {
  const confirm = useConfirm();
  return (title: string, opts?: { description?: string; confirmLabel?: string }) =>
    confirm({
      title,
      description: opts?.description ?? ST.confirmDelete,
      confirmLabel: opts?.confirmLabel ?? S.confirmLabels.delete,
      tone: "destructive",
    });
}
