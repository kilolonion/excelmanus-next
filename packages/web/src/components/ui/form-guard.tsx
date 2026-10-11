import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { formSignature } from "../../form-state.ts";
import { UI } from "../../strings.ts";
import { useConfirm } from "./confirm.tsx";

const Context = createContext({
  confirmLeave: async () => true,
  captureSubmit: (): HTMLFormElement | null => null,
  saved: (_form: HTMLFormElement | null) => {},
  registerDirty: (_id: string, _dirty: boolean) => {},
});
const signature = (form: HTMLFormElement) =>
  formSignature(Array.from(form.elements) as HTMLInputElement[]);

export function FormGuard({ children }: { children: ReactNode }) {
  const originals = useRef(new Map<HTMLFormElement, string>());
  const submitted = useRef<HTMLFormElement | null>(null);
  const drafts = useRef(new Set<string>());
  const confirm = useConfirm();
  const confirmLeave = useCallback(async () => {
    for (const form of originals.current.keys())
      if (!form.isConnected) originals.current.delete(form);
    const dirty =
      drafts.current.size > 0 ||
      [...originals.current].some(([form, before]) => signature(form) !== before);
    if (!dirty) return true;
    const ok = await confirm({
      title: UI.unsavedTitle,
      description: UI.unsavedHint,
      confirmLabel: UI.discardChanges,
      tone: "destructive",
    });
    return ok;
  }, [confirm]);
  const value = useMemo(
    () => ({
      confirmLeave,
      captureSubmit: () => submitted.current,
      registerDirty: (id: string, dirty: boolean) => {
        if (dirty) drafts.current.add(id);
        else drafts.current.delete(id);
      },
      saved: (form: HTMLFormElement | null) => {
        if (form)
          requestAnimationFrame(() => {
            if (form.isConnected) originals.current.set(form, signature(form));
          });
      },
    }),
    [confirmLeave],
  );
  const remember = (target: EventTarget) => {
    if (!(target instanceof Element)) return;
    const form = target.closest("form");
    if (form && !originals.current.has(form)) originals.current.set(form, signature(form));
  };
  const onSubmit = (event: FormEvent) => {
    submitted.current = event.target instanceof HTMLFormElement ? event.target : null;
    queueMicrotask(() => {
      submitted.current = null;
    });
  };
  return (
    <Context.Provider value={value}>
      <div
        className="contents"
        onFocusCapture={(e) => remember(e.target)}
        onPointerDownCapture={(e) => remember(e.target)}
        onSubmitCapture={onSubmit}
      >
        {children}
      </div>
    </Context.Provider>
  );
}
export function useFormGuard() {
  return useContext(Context);
}

export function useUnsavedChanges(dirty: boolean) {
  const { registerDirty } = useFormGuard();
  const id = useId();
  useEffect(() => {
    registerDirty(id, dirty);
    return () => registerDirty(id, false);
  }, [dirty, id, registerDirty]);
}
