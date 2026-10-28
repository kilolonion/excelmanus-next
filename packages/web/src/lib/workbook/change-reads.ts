import { api } from "@/lib/backend/api";

type Client = ReturnType<typeof api>;
type Before = ReturnType<Client["getDocRevBefore"]>;
type Snapshot = ReturnType<Client["getDocSnapshot"]>;
const beforeReads = new Map<string, Before>();
const completedBefore = new Map<string, { request: Before; bytes: number }>();
const MAX_BEFORE_PREVIEWS = 32;
const MAX_BEFORE_BYTES = 32 * 1024 * 1024;

function beforeBytes(data: Awaited<Before>): number {
  let bytes = 0;
  for (const cell of data.cells) {
    bytes +=
      64 +
      cell.sheet.length * 2 +
      (cell.formula?.length ?? 0) * 2 +
      (typeof cell.value === "string" ? cell.value.length * 2 : 8);
    if (bytes > MAX_BEFORE_BYTES) break;
  }
  return bytes;
}
const snapshots = new Map<string, Snapshot>();

/** A revision's inverse cells are immutable; both comparison surfaces share them. */
export function readRevisionBefore(workspaceId: string, docId: string, rev: number): Before {
  const key = JSON.stringify([workspaceId, docId, rev]);
  const cached = completedBefore.get(key);
  if (cached) {
    completedBefore.delete(key);
    completedBefore.set(key, cached);
    return cached.request;
  }
  const pending = beforeReads.get(key);
  if (pending) return pending;
  const request = api().getDocRevBefore(workspaceId, docId, rev);
  beforeReads.set(key, request);
  void request.then(
    (data) => {
      beforeReads.delete(key);
      const bytes = beforeBytes(data);
      if (bytes > MAX_BEFORE_BYTES) return;
      completedBefore.set(key, { request, bytes });
      let retained = 0;
      for (const entry of completedBefore.values()) retained += entry.bytes;
      while (completedBefore.size > MAX_BEFORE_PREVIEWS || retained > MAX_BEFORE_BYTES) {
        const oldest = completedBefore.keys().next().value!;
        retained -= completedBefore.get(oldest)!.bytes;
        completedBefore.delete(oldest);
      }
    },
    () => {
      if (beforeReads.get(key) === request) beforeReads.delete(key);
    },
  );
  return request;
}

/** Only coalesce in-flight reads. Later openings must request current values again. */
export function readComparisonSnapshot(
  workspaceId: string,
  docId: string,
  currentRev: number | null,
  force = false,
): Snapshot {
  const key = JSON.stringify([workspaceId, docId, currentRev]);
  const pending = snapshots.get(key);
  if (pending && !force) return pending;
  const request = api().getDocSnapshot(workspaceId, docId);
  snapshots.set(key, request);
  const release = () => {
    if (snapshots.get(key) === request) snapshots.delete(key);
  };
  void request.then(release, release);
  return request;
}
