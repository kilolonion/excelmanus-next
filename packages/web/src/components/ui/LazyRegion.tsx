import { Loader2, RefreshCw } from "lucide-react";
import { type ComponentType, lazy, Suspense, useState } from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { ErrorBoundary } from "./ErrorBoundary";

interface StatusProps {
  label: string;
  failed?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
}

export function RegionStatus({ label, failed, onRetry, onClose }: StatusProps) {
  return (
    <div
      className="flex min-h-32 h-full flex-col items-center justify-center gap-3 p-5 text-center"
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      {!failed && (
        <Loader2 size={20} className="animate-spin text-muted-foreground" aria-hidden="true" />
      )}
      <p className="text-sm font-medium">{failed ? `${label}暂时无法显示` : `正在加载${label}…`}</p>
      <p className="text-xs text-muted-foreground">
        {failed
          ? "可以重试此区域，其他内容不受影响。"
          : "首次打开需要下载界面资源，可以先关闭并继续其他操作。"}
      </p>
      <div className="flex gap-2">
        {failed && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw size={14} />
            重试
          </Button>
        )}
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        )}
      </div>
    </div>
  );
}

// Cache successful module types only; each opening still owns its component state and props.
const loadedRegions = new WeakMap<object, unknown>();
function freshRegion<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  return lazy(async () => {
    const module = await load();
    loadedRegions.set(load, module.default);
    return module;
  });
}

/** Keep failures and retries inside the affected region; never reload the page or stores. */
export function LazyRegion<P extends object>({
  load,
  componentProps,
  label,
  onClose,
  dialog = false,
}: {
  load: () => Promise<{ default: ComponentType<P> }>;
  componentProps: P;
  label: string;
  onClose?: () => void;
  dialog?: boolean;
}) {
  const [Component, setComponent] = useState<ComponentType<P>>(
    () => (loadedRegions.get(load) as ComponentType<P> | undefined) ?? freshRegion(load),
  );
  // React.lazy remembers rejection. Retrying must create a fresh lazy instance.
  const retry = () => setComponent(() => freshRegion(load));
  const status = (failed = false) => {
    const body = <RegionStatus label={label} failed={failed} onRetry={retry} onClose={onClose} />;
    return dialog ? (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose?.();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{label}</DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    ) : (
      body
    );
  };
  return (
    <ErrorBoundary resetKey={Component} fallback={() => status(true)}>
      <Suspense fallback={status()}>
        <Component {...componentProps} />
      </Suspense>
    </ErrorBoundary>
  );
}
