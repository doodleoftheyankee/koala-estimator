// Totals for the figures over the office lists (/estimates, /jobs). A total is only ever the sum
// of the prices the rows below it show, so anyone can check it by adding up the list.

export interface MoneyGroup {
  count: number;
  /** Sum of the prices the rows show (to the cent); null when no row has a price. */
  total: number | null;
  /** Rows in the group with no price, so not in the total. */
  unpriced: number;
}

const isPrice = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Adds money the way people check it: to the cent, without float noise. */
export function sumMoney(values: readonly number[]): number {
  return values.reduce((cents, v) => cents + Math.round(v * 100), 0) / 100;
}

/** How many rows, the sum of their prices, and how many have no price (left out of the sum). */
export function moneyGroup(rows: ReadonlyArray<{ price: number | null }>): MoneyGroup {
  const priced = rows.map((r) => r.price).filter(isPrice);
  return { count: rows.length, total: priced.length ? sumMoney(priced) : null, unpriced: rows.length - priced.length };
}
