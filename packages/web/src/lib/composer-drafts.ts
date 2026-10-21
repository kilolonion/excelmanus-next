/** Draft text stays in this browser, scoped to a conversation and agent. */
export const DRAFTS_KEY = "excelmanus.composer-drafts.v1";
type DraftStorage = Pick<Storage, "getItem" | "setItem">;
// One exact payload only: every access still reads storage so other tabs remain authoritative.
let cached: { raw: string; drafts: Record<string, string> } | undefined;
function decodeDrafts(raw: string): Record<string, string> {
  if (cached?.raw === raw) return cached.drafts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const drafts = Object.fromEntries(
    Object.entries(parsed && typeof parsed === "object" ? parsed : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  cached = { raw, drafts };
  return drafts;
}
export function readDraft(storage: DraftStorage, key: string): string {
  try {
    const value = decodeDrafts(storage.getItem(DRAFTS_KEY) ?? "{}")[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
export function saveDraft(storage: DraftStorage, key: string, text: string): void {
  try {
    const drafts = { ...decodeDrafts(storage.getItem(DRAFTS_KEY) ?? "{}") };
    if (text) drafts[key] = text;
    else delete drafts[key];
    const raw = JSON.stringify(drafts);
    storage.setItem(DRAFTS_KEY, raw);
    cached = { raw, drafts };
  } catch {
    /* Storage may be disabled; typing must still work. */
  }
}
export function appendDraft(current: string, incoming: string): string {
  if (!current.trim()) return incoming;
  if (!incoming.trim() || current.trim() === incoming.trim()) return current;
  return `${current.trimEnd()}\n\n${incoming}`;
}

/** A slow send in one tab must not erase a newer draft saved by another tab. */
export function clearDraftIfUnchanged(storage: DraftStorage, key: string, expected: string): void {
  if (readDraft(storage, key) === expected) saveDraft(storage, key, "");
}
