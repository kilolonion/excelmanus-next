/** 输入已转小写；子序列匹配中连续命中、词首命中加分，不匹配返回 -1。 */
function score(text: string, query: string): number {
  if (!query) return 0;
  const t = text;
  const q = query;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1;
  let ti = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    total += 10 + streak * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return total;
}

/** Retain only the displayed winners; equal scores keep their original list order. */
export function rankQuickOpenItems<T>(
  list: { item: T; text: string }[],
  query: string,
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const best: { item: T; score: number }[] = [];
  for (const candidate of list) {
    const value = score(candidate.text, query);
    if (value < 0 || (best.length === limit && value <= best[limit - 1].score)) continue;
    let low = 0,
      high = best.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (best[mid].score >= value) low = mid + 1;
      else high = mid;
    }
    best.splice(low, 0, { item: candidate.item, score: value });
    if (best.length > limit) best.pop();
  }
  return best.map(({ item }) => item);
}
