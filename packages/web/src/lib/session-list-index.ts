import type { SessionSummary } from "@excelmanus/protocol";

// Session-store replaces this array on refresh, rename and removal. Old indexes are collectible.
const indexes = new WeakMap<readonly SessionSummary[], Map<string, SessionSummary>>();
export function findSessionSummary(
  sessions: readonly SessionSummary[],
  id: string | null | undefined,
): SessionSummary | undefined {
  if (id == null) return undefined;
  let index = indexes.get(sessions);
  if (!index) {
    index = new Map();
    for (const session of sessions) {
      const key = session.id;
      if (!index.has(key)) index.set(key, session);
    }
    indexes.set(sessions, index);
  }
  return index.get(id);
}
