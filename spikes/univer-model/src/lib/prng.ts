// 带种子的 PRNG（mulberry32）——所有随机性统一走这里，序列可复现。

export interface Prng {
  next(): number; // [0,1)
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
  range(min: number, max: number): number; // inclusive int
}

export function createPrng(seed: number): Prng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T,
    chance: (p) => next() < p,
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
  };
}
