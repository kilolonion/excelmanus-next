import { useState } from "react";
import { desktop } from "../api.ts";
import { apiClientOf, refreshWorkspaces, switchWorkspace } from "../store.ts";
import { S } from "../strings.ts";
import { Icon } from "./Icon.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Field } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";

export function AddWorkspaceDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdded?(): void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registeredId, setRegisteredId] = useState<string | null>(null);
  const bridge = desktop();
  const changeOpen = (next: boolean) => {
    if (busy) return;
    if (next) {
      setPath("");
      setName("");
      setError(null);
      setRegisteredId(null);
    }
    onOpenChange(next);
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const id =
        registeredId ??
        (await apiClientOf().addWorkspace(path.trim(), name.trim() || undefined)).workspace.id;
      setRegisteredId(id);
      await refreshWorkspaces();
      await switchWorkspace(id);
      onAdded?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : S.addWorkspaceFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogTitle>{S.addWorkspace}</DialogTitle>
        <DialogDescription className="mt-1">{S.addWorkspaceDescription}</DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label={S.workspacePath}>
            <Input
              mono
              required
              value={path}
              disabled={busy || registeredId !== null}
              onChange={(event) => setPath(event.target.value)}
            />
          </Field>
          {bridge && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || registeredId !== null}
              onClick={() => {
                void bridge
                  .chooseDirectory()
                  .then((selected) => {
                    if (selected) setPath(selected);
                  })
                  .catch(() => setError(S.addWorkspaceFailed));
              }}
            >
              <Icon name="folder" size="sm" />
              {S.chooseWorkspaceDirectory}
            </Button>
          )}
          <Field label={S.workspaceName}>
            <Input
              value={name}
              disabled={busy || registeredId !== null}
              placeholder={S.workspaceNamePlaceholder}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => changeOpen(false)}>
              {S.cancel}
            </Button>
            <Button type="submit" loading={busy} disabled={path.trim() === ""}>
              {S.registerWorkspace}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
