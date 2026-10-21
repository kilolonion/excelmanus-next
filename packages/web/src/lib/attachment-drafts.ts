import { AttachmentRef } from "@excelmanus/protocol";
import type { ComposerAttachment } from "@/stores/chat-store";

type DraftStorage = Pick<Storage, "getItem" | "setItem">;
const keyFor = (scope: string) => `excelmanus.attachment-draft.v1:${scope}`;

/** Persist metadata only; raw pending files live in IndexedDB, never localStorage. */
export function saveAttachmentDraft(
  storage: DraftStorage,
  scope: string,
  items: ComposerAttachment[],
): void {
  try {
    const ready = items;
    storage.setItem(
      keyFor(scope),
      JSON.stringify(
        ready.map(({ id, name, size, ref, path, status }) => ({
          id,
          name,
          size,
          ref,
          path,
          status,
        })),
      ),
    );
  } catch {
    // Storage being unavailable must not prevent uploading or sending.
  }
}

export function readAttachmentDraft(storage: DraftStorage, scope: string): ComposerAttachment[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(keyFor(scope)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): ComposerAttachment[] => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        !Number.isFinite(item.size) ||
        item.size < 0 ||
        !["ready", "uploading", "error"].includes(item.status)
      )
        return [];
      const ref = AttachmentRef.safeParse(item.ref);
      const path = typeof item.path === "string" && item.path.trim() ? item.path : undefined;
      if (!ref.success && !path)
        return [
          {
            id: item.id,
            name: item.name,
            size: item.size,
            status: "error",
            canRetry: false,
            error: "上传未完成，正在检查本地草稿…",
          },
        ];
      return [
        {
          id: item.id,
          name: item.name,
          size: item.size,
          status: "ready",
          ...(ref.success ? { ref: ref.data } : {}),
          ...(path ? { path } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Apply this tab's changes without removing additions made in another tab. */
export function mergeAttachmentDraft(
  shared: ComposerAttachment[],
  previous: ComposerAttachment[],
  current: ComposerAttachment[],
): ComposerAttachment[] {
  const next = new Map(current.map((item) => [item.id, item]));
  const before = new Map(previous.map((item) => [item.id, item]));
  const merged = new Map(
    shared
      .filter((item) => !before.has(item.id) || next.has(item.id))
      .map((item) => [item.id, item]),
  );
  const signature = (item: ComposerAttachment) =>
    JSON.stringify([item.name, item.size, item.path, item.ref, item.status]);
  for (const item of current) {
    const prior = before.get(item.id);
    const remote = merged.get(item.id);
    if (remote?.status === "ready" && item.status !== "ready") continue;
    if (!prior || signature(prior) !== signature(item)) merged.set(item.id, item);
  }
  return [...merged.values()];
}
