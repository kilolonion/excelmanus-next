import { persistentDraftStorage } from "../draft-storage";
import { initialDocSync } from "./doc-sync";
import { decodeRecovery, encodeRecovery } from "./recovery";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const empty = () => ({ docSync: initialDocSync(0), drafts: [] });
const cellKey = (d: { sheetId: string; row: number; col: number }) =>
  JSON.stringify([d.sheetId, d.row, d.col]);
const stable = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]]),
        )
      : v,
  );
const same = (a: unknown, b: unknown) => a === b || stable(a) === stable(b);
/** Apply only this tab's changes, so an older tab cannot clear a newer saved draft. */
export function createRecoveryStorage(storage?: StorageLike) {
  const observed = new Map<string, string | null>();
  return {
    read(key: string): string | null {
      const raw = (storage ?? persistentDraftStorage()).getItem(key);
      observed.set(key, raw);
      return raw;
    },
    write(key: string, raw: string | null): void {
      const target = storage ?? persistentDraftStorage();
      const beforeRaw = observed.get(key) ?? null;
      const before = decodeRecovery(beforeRaw, 0) ?? empty();
      const next = raw === beforeRaw ? before : (decodeRecovery(raw, 0) ?? empty());
      const currentRaw = target.getItem(key);
      // Share only exact snapshots within this write; another tab's changes still get decoded.
      const current =
        currentRaw === beforeRaw
          ? before
          : currentRaw === raw
            ? next
            : (decodeRecovery(currentRaw, 0) ?? empty());
      const drafts = new Map(current.drafts.map((d) => [cellKey(d), d]));
      const oldDrafts = new Map(before.drafts.map((d) => [cellKey(d), d]));
      const newDrafts = new Map(next.drafts.map((d) => [cellKey(d), d]));
      for (const [id, old] of oldDrafts)
        if (!newDrafts.has(id) && same(drafts.get(id), old)) drafts.delete(id);
      for (const [id, value] of newDrafts)
        if (!same(oldDrafts.get(id), value)) drafts.set(id, value);
      const pending = { ...current.docSync.pending };
      for (const [id, old] of Object.entries(before.docSync.pending))
        if (!(id in next.docSync.pending) && same(pending[id], old)) delete pending[id];
      for (const [id, value] of Object.entries(next.docSync.pending))
        if (!same(before.docSync.pending[id], value)) pending[id] = value;
      // Keep a tombstone so legacy sessionStorage cannot resurrect resolved input.
      const saved =
        encodeRecovery({ rev: 0, pending }, [...drafts.values()]) ??
        '{"version":1,"pending":{},"drafts":[]}';
      target.setItem(key, saved);
      if (target.getItem(key) !== saved) throw new Error("浏览器未能保存单元格草稿");
      observed.set(key, raw);
    },
  };
}
