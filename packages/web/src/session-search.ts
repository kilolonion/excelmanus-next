import type { SessionSummary } from "@excelmanus/protocol";

/** 按会话标题做本地、不区分大小写的子串搜索，保留当前列表顺序。 */
export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
  untitledLabel = "",
): SessionSummary[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return [...sessions];
  return sessions.filter((session) =>
    (session.title ?? untitledLabel).toLowerCase().includes(normalized),
  );
}
