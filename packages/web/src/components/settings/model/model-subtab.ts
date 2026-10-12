/** diagnostics is kept as a compatibility alias; the UI routes it to roles. */
export type ModelSubTab = "providers" | "roles" | "subscription" | "diagnostics";

type Listener = (tab: ModelSubTab) => void;

const listeners = new Set<Listener>();
let pending: ModelSubTab | null = null;
let pendingProfile: string | null = null;

export function requestModelSubTab(tab: ModelSubTab, profileName?: string) {
  pending = listeners.size === 0 ? tab : null;
  pendingProfile = profileName ?? null;
  for (const fn of listeners) fn(tab);
}

export function takePendingModelSubTab(): ModelSubTab | null {
  const next = pending;
  pending = null;
  return next;
}

export function takePendingModelProfile(): string | null {
  const next = pendingProfile;
  pendingProfile = null;
  return next;
}

export function subscribeModelSubTab(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
