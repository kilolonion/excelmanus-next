// 设置中心共用的小组件与工具函数。

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { S, ST } from "../../strings.ts";
import { cn } from "../ui/cn.ts";
import { useConfirm } from "../ui/confirm.tsx";
import { Alert, Card } from "../ui/display.tsx";
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
  className,
}: {
  title?: ReactNode;
  hint?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("settings-section flex min-w-0 flex-col gap-5", className)}>
      {(title || hint || actions) && (
        <div className="settings-section-heading flex min-h-8 flex-wrap items-start justify-between gap-x-5 gap-y-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {title && (
              <h3 className="text-[15px] leading-6 font-semibold tracking-tight">{title}</h3>
            )}
            {hint && (
              <p className="max-w-[560px] text-xs leading-5 text-muted-foreground">{hint}</p>
            )}
          </div>
          {actions && (
            <div className="settings-section-actions flex flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      )}
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
    <UiField label={label} description={hint} className={cn("settings-field gap-2", className)}>
      {children}
    </UiField>
  );
}

/** 列表卡片容器（设置中心统一外观） */
export function ItemCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card
      elevation="flat"
      className={cn(
        "settings-item flex flex-col gap-3 rounded-lg border-border/70 p-5 shadow-none",
        className,
      )}
    >
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

export function LoadStatus({ data, error }: { data: unknown; error: string | null }) {
  if (error)
    return (
      <Alert layout="inline" tone="err" role="alert">
        {error}
      </Alert>
    );
  return data === null ? <Loading /> : null;
}

export function Empty({ text = ST.empty }: { text?: string }) {
  return (
    <p className="settings-empty rounded-lg bg-muted/40 px-5 py-7 text-sm leading-6 text-muted-foreground">
      {text}
    </p>
  );
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
