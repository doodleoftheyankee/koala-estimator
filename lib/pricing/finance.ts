/** Round to cents. */
export function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round up to the nearest `step` dollars (step <= 0 means cents). Rounding up never erodes margin. */
export function roundUpTo(n: number, step: number): number {
  if (!(step > 0)) return Math.ceil(n * 100 - 1e-9) / 100; // whole cents, still rounding up
  // Subtract a hair so 1000.0000001 does not jump a whole step due to float noise.
  return Math.ceil(n / step - 1e-9) * step;
}

/** Standard amortized monthly payment. apr is a fraction (0.0999). */
export function monthlyPayment(principal: number, apr: number, termMonths: number): number {
  if (termMonths <= 0) throw new RangeError('termMonths must be positive');
  if (principal <= 0) return 0;
  const r = apr / 12;
  if (r === 0) return principal / termMonths;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

/** Round up to a multiple of 0.5 (crew days are scheduled in half days). */
export function ceilHalf(n: number): number {
  return Math.ceil(n * 2 - 1e-9) / 2;
}

/**
 * Splits `total` across weights proportionally, in cents, so the parts sum exactly to the
 * total. The residual cent(s) go to the largest weights first.
 */
export function allocate(total: number, weights: number[]): number[] {
  const cents = Math.round(total * 100);
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const even = weights.map(() => Math.floor(cents / weights.length));
    let rest = cents - even.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i = (i + 1) % even.length, rest--) even[i]! += 1;
    return even.map((c) => c / 100);
  }
  const raw = weights.map((w) => (Math.max(0, w) / sum) * cents);
  const floored = raw.map(Math.floor);
  let rest = cents - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) floored[order[k]!.i]! += 1;
  return floored.map((c) => c / 100);
}
