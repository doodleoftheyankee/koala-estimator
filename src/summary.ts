// Summary data shared by the summary screen and exports: per-space numbers, per-type totals,
// the copy-paste text, the JSON export and the Foam Desk link.

import { computeSpace, SPACE_NAME, totalsByType, type Job, type SpaceType } from './model';
import { formatSqft } from './units';

export const FOAM_DESK_URL = 'https://koala-foam-desk.vercel.app';

export function summaryRows(job: Job) {
  return job.spaces.map((space) => {
    const r = computeSpace(space);
    return { space, gross: r.gross, cutouts: r.cutouts, net: r.net, ok: r.errors.length === 0, basis: r.basis };
  });
}

/** Link to the Foam Desk estimator with a type's total net square feet. */
export function foamDeskLink(type: SpaceType, sqft: number): string {
  const url = new URL(FOAM_DESK_URL);
  url.searchParams.set('sqft', String(Math.round(sqft)));
  url.searchParams.set('type', type);
  return url.toString();
}

/** Plain-text summary for pasting into a text, email or CRM note. */
export function summaryText(job: Job, now = new Date()): string {
  const lines = [
    'AtticScan measurement summary',
    `Customer: ${job.customer || '—'}`,
    `Address: ${job.address || '—'}`,
    `Date: ${now.toLocaleDateString('en-US')}`,
    '',
  ];
  for (const row of summaryRows(job)) {
    const type = SPACE_NAME[row.space.type];
    const head = row.space.name.startsWith(type) ? row.space.name : `${row.space.name} (${type})`;
    if (!row.ok) {
      lines.push(`${head}: incomplete`);
      continue;
    }
    lines.push(`${head}: ${formatSqft(row.net)} sq ft net (${formatSqft(row.gross)} gross − ${formatSqft(row.cutouts)} cutouts)`);
    if (row.basis) lines.push(`  ${row.basis}`);
  }
  const totals = totalsByType(job);
  if (totals.length) {
    lines.push('', 'Net totals:');
    for (const t of totals) lines.push(`  ${SPACE_NAME[t.type]}: ${formatSqft(t.net)} sq ft`);
    lines.push(`  All spaces: ${formatSqft(totals.reduce((s, t) => s + t.net, 0))} sq ft`);
  }
  return lines.join('\n');
}

/** Everything about the job as JSON: inputs, computed results and photo counts. */
export function exportJson(job: Job, photoCounts: Record<string, number>, now = new Date()): string {
  return JSON.stringify(
    {
      app: 'AtticScan',
      version: 1,
      exportedAt: now.toISOString(),
      job: {
        id: job.id,
        customer: job.customer,
        address: job.address,
        createdAt: new Date(job.createdAt).toISOString(),
        updatedAt: new Date(job.updatedAt).toISOString(),
      },
      spaces: summaryRows(job).map((row) => ({
        id: row.space.id,
        name: row.space.name,
        type: row.space.type,
        complete: row.ok,
        grossSqft: round1(row.gross),
        cutoutsSqft: round1(row.cutouts),
        netSqft: round1(row.net),
        basis: row.basis,
        photos: photoCounts[row.space.id] ?? 0,
        notes: row.space.notes,
        input: { ...row.space, id: undefined, name: undefined, type: undefined, notes: undefined },
      })),
      totals: totalsByType(job).map((t) => ({ type: t.type, name: SPACE_NAME[t.type], netSqft: round1(t.net), spaces: t.spaces })),
    },
    null,
    2,
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
