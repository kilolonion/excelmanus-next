// 设置中心共用的小组件与工具函数。

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { S, ST } from "../../strings.ts";
import { cn } from "../ui/cn.ts";
import { useConfirm } from "../ui/confirm.tsx";
import { Alert, Card } from "../ui/display.tsx";
import { Field as UiField } from "../ui/field.tsx";
import { useFormGuard } from "../ui/form-guard.tsx";
import { toast } from "../ui/overlay.tsx";
import { PageSection, PageState } from "../ui/page-layout.tsx";

/** 加载一次并可手动刷新的异步数据。 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  // 依赖由调用方给出；序列化为稳定键，避免每次渲染重建
  const key = JSON.stringify(deps);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load 随调用方闭包变化，重新加载只由 key 驱动
  const reload = useCallback(() => {
    const current = ++generation.current;
    load()
      .then((d) => {
        if (current !== generation.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (current === generation.current) setError(e instanceof Error ? e.message : String(e));
      });
  }, [key]);
  useEffect(() => {
    setData(null);
    setError(null);
    reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return { data, error, reload };
}

/** 保存反馈：成功用提示框（附录 C P-14），失败留在原位。 */
export function useAction() {
  const inFlight = useRef(false);
  const guard = useFormGuard();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, okText: string = ST.saved): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const submitted = guard.captureSubmit();
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      guard.saved(submitted);
      setMsg({ ok: true, text: okText });
      toast({ tone: "ok", title: okText });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : ST.saveFailed });
      return false;
    } finally {
      inFlight.current = false;
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
    <PageSection
      title={title}
      description={hint}
      actions={actions}
      className={cn("settings-section", className)}
    >
      {children}
    </PageSection>
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
  return <PageState kind="loading" title={ST.loading} />;
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
  return <PageState kind="empty" title={text} />;
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
