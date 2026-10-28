type DraftStorage = Pick<Storage, "getItem" | "setItem">;
/** Read the old tab storage on upgrade; all future writes also survive closing the tab. */
export function persistentDraftStorage(local?: DraftStorage, tab?: DraftStorage): DraftStorage {
  if (!local)
    try {
      local = localStorage;
    } catch {
      /* unavailable */
    }
  if (!tab)
    try {
      tab = sessionStorage;
    } catch {
      /* unavailable */
    }
  return {
    getItem(key) {
      try {
        const value = local?.getItem(key);
        if (value != null) return value;
      } catch {
        /* fallback */
      }
      try {
        return tab?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        local?.setItem(key, value);
      } catch {
        /* fallback */
      }
      try {
        tab?.setItem(key, value);
      } catch {
        /* typing must still work */
      }
    },
  };
}
