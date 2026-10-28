/** One lazy formatter per rendered list; no cross-list or process-wide timezone cache. */
export function createDateLabels(options: Intl.DateTimeFormatOptions, invalidLabel?: string) {
  let formatter: Intl.DateTimeFormat | undefined;
  return (value?: string | null): string => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return invalidLabel ?? value;
    formatter ??= new Intl.DateTimeFormat("zh-CN", options);
    return formatter.format(date);
  };
}
