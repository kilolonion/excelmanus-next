/** Fixed Chinese 24-hour clock, using the browser's current local timezone. */
function localClock(date: Date): string {
  if (Number.isNaN(date.getTime()))
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatClock(at?: string): string | null {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : localClock(d);
}

export function formatTimestamp(at: string): string {
  const date = new Date(at);
  const diff = Date.now() - date.getTime();
  const today = new Date();
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const time = localClock(date);
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
