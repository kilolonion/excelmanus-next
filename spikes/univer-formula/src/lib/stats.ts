// 延迟统计：min/p50/p95/p99/max/mean

export interface LatStats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function statsOf(samples: number[]): LatStats {
  if (samples.length === 0) {
    return { n: 0, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
  return {
    n: samples.length,
    min: sorted[0] ?? NaN,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}

export function getOrCreate<V>(map: Record<string, V>, key: string, init: () => V): V {
  let v = map[key];
  if (v === undefined) {
    v = init();
    map[key] = v;
  }
  return v;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function roundStats(s: LatStats): LatStats {
  return {
    n: s.n,
    min: r2(s.min),
    p50: r2(s.p50),
    p95: r2(s.p95),
    p99: r2(s.p99),
    max: r2(s.max),
    mean: r2(s.mean),
  };
}
