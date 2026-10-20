export const usd = (n: number, cents = false) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

export const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

export const num = (n: number, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits });

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const JOB_TYPE_LABELS = {
  attic: 'Attic',
  walls: 'Walls',
  crawlspace: 'Crawlspace',
  rim_joist: 'Rim joist',
  garage: 'Garage',
  commercial: 'Commercial',
} as const;

export const ACCESS_LABELS = { easy: 'Easy', moderate: 'Moderate', difficult: 'Difficult', extreme: 'Extreme' } as const;

export const ACCESS_HINTS = {
  easy: 'Walk-up or pull-down stairs, 4 ft+ clearance',
  moderate: 'Scuttle hatch, 3–4 ft clearance, some obstructions',
  difficult: 'Under 3 ft clearance, heavy obstructions, long hose runs',
  extreme: 'Crawl-only, confined space, many small bays',
} as const;

export const TIER_LABELS = { good: 'Good', better: 'Better', best: 'Best' } as const;
