// Seeded PRNG for tests: same seed, same sequence, on every machine.

/** Mulberry32: tiny and fast, plenty for synthetic data. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  uniform(min: number, max: number): number;
  int(min: number, max: number): number; // inclusive
  normal(): number; // standard normal (Box-Muller)
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    uniform: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    normal: () => {
      const u = 1 - next(); // (0, 1]: log(0) is not a number
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    pick: (xs) => {
      if (xs.length === 0) throw new RangeError('pick from an empty list');
      return xs[Math.floor(next() * xs.length)]!;
    },
    chance: (p) => next() < p,
  };
}
