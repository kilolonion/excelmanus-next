import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { S } from "../../strings.ts";
import { Button } from "./button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
} from "./dialog.tsx";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const settle = useCallback((v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  }, []);

  const confirm = useCallback<ConfirmFn>((o) => {
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <AlertDialog open={opts !== null} onOpenChange={(o) => !o && settle(false)}>
        {opts && (
          <AlertDialogContent
            title={opts.title}
            description={opts.description
              ?.split("\n")
              .filter(Boolean)
              .map((p) => <p key={p}>{p}</p>)}
            footer={
              <>
                <AlertDialogCancel asChild>
                  <Button variant="outline" autoFocus>
                    {opts.cancelLabel ?? S.cancel}
                  </Button>
                </AlertDialogCancel>
                <AlertDialogAction asChild>
                  <Button
                    variant={opts.tone === "destructive" ? "destructive" : "default"}
                    onClick={(e) => {
                      e.preventDefault();
                      settle(true);
                    }}
                  >
                    {opts.confirmLabel}
                  </Button>
                </AlertDialogAction>
              </>
            }
          />
        )}
      </AlertDialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(Ctx);
  if (!fn) throw new Error(S.confirmProviderMissing);
  return fn;
}
