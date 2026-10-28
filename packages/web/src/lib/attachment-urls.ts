import { api } from "@/lib/backend/api";

type Entry = { promise: Promise<string>; users: number; url?: string; bytes: number };
const entries = new Map<string, Entry>();
const idle = new Map<string, Entry>();
const MAX_IDLE_ENTRIES = 32;
const MAX_IDLE_BYTES = 32 * 1024 * 1024;
let idleBytes = 0;

function removeIdle(key: string) {
  const entry = idle.get(key);
  if (!entry) return;
  idle.delete(key);
  idleBytes -= entry.bytes;
}

function retainIdle(key: string, entry: Entry) {
  if (entry.users !== 0 || !entry.url || entries.get(key) !== entry) return;
  removeIdle(key);
  idle.set(key, entry);
  idleBytes += entry.bytes;
  while (idle.size > MAX_IDLE_ENTRIES || idleBytes > MAX_IDLE_BYTES) {
    const oldest = idle.keys().next().value!;
    const expired = idle.get(oldest)!;
    removeIdle(oldest);
    entries.delete(oldest);
    URL.revokeObjectURL(expired.url!);
  }
}

/** Mounted thumbnails share a URL; only unused previews may be evicted. */
export function acquireAttachmentUrl(sha256: string): { url: Promise<string>; release(): void } {
  let entry = entries.get(sha256);
  if (!entry) {
    const fresh: Entry = { users: 0, bytes: 0, promise: Promise.resolve("") };
    fresh.promise = api()
      .getAttachment(sha256)
      .then((blob) => {
        fresh.bytes = blob.size;
        fresh.url = URL.createObjectURL(blob);
        retainIdle(sha256, fresh);
        return fresh.url;
      })
      .catch((error) => {
        if (entries.get(sha256) === fresh) entries.delete(sha256);
        throw error;
      });
    entries.set(sha256, fresh);
    entry = fresh;
  }
  removeIdle(sha256);
  entry.users++;
  let released = false;
  return {
    url: entry.promise,
    release() {
      if (released) return;
      released = true;
      entry.users--;
      retainIdle(sha256, entry);
    },
  };
}
