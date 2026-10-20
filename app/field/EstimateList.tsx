'use client';
import { db, getCachedBundle, type CachedProfile, type LocalEstimate, type SyncState } from '@/lib/offline/db';
import { timeAgo, usd } from '@/lib/format';
import { Badge, Button } from '@/components/ui';
import { useLive } from './hooks';

const SYNC_BADGE: Record<SyncState, { tone: 'slate' | 'green' | 'amber' | 'red' | 'blue'; label: string }> = {
  local: { tone: 'slate', label: 'Incomplete' },
  pending: { tone: 'amber', label: 'Not synced' },
  synced: { tone: 'green', label: 'Synced' },
  conflict: { tone: 'red', label: 'Conflict' },
  locked: { tone: 'blue', label: 'Signed' },
  invalid: { tone: 'red', label: 'Needs fixing' },
  error: { tone: 'amber', label: 'Retrying' },
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  ready: 'Ready',
  sent: 'Sent',
  viewed: 'Viewed',
  signed: 'Signed',
  lost: 'Lost',
  expired: 'Expired',
  void: 'Void',
};

export function EstimateList({
  profile,
  online,
  onOpen,
  onNew,
  onSync,
}: {
  profile: CachedProfile;
  online: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSync: () => void;
}) {
  const estimates = useLive(
    () => db().estimates.where('ownerId').equals(profile.userId).reverse().sortBy('updatedAt'),
    [profile.userId],
    [] as LocalEstimate[],
  );
  const bundle = useLive(() => getCachedBundle(), [], null);
  const unsynced = estimates.filter((e) => ['pending', 'error', 'invalid', 'conflict'].includes(e.syncState)).length;

  return (
    <div className="pb-28">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold">Estimates</h1>
            <p className="text-xs text-slate-500">
              {profile.fullName} ·{' '}
              <span className={online ? 'text-emerald-700' : 'text-amber-700'}>{online ? 'Online' : 'Offline, saving on this phone'}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {profile.role !== 'estimator' ? (
              <a href="/estimates" className="rounded-lg px-3 py-2 text-sm font-medium text-brand-800 hover:bg-brand-50">
                Office
              </a>
            ) : null}
            <Button size="sm" variant="secondary" onClick={onSync} disabled={!online}>
              Sync{unsynced ? ` (${unsynced})` : ''}
            </Button>
          </div>
        </div>
        {!bundle ? (
          <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900">
            Pricing not downloaded yet. Open this screen once with signal so estimates can be priced offline.
          </p>
        ) : null}
      </header>

      <ul className="space-y-2 p-3">
        {estimates.length === 0 ? (
          <li className="rounded-2xl bg-white p-6 text-center text-slate-500 ring-1 ring-slate-200">No estimates on this phone yet.</li>
        ) : null}
        {estimates.map((e) => {
          const d = e.draft;
          const name = `${d.customer.firstName} ${d.customer.lastName}`.trim() || 'New customer';
          const badge = SYNC_BADGE[e.syncState];
          const total = e.summaryPrice;
          return (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onOpen(e.id)}
                className="block w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{name}</p>
                    <p className="truncate text-sm text-slate-600">{d.property.street || 'No address yet'}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                    <span className="text-xs text-slate-500">{STATUS_LABEL[d.status] ?? d.status}</span>
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {d.areas.length} area{d.areas.length === 1 ? '' : 's'} · updated {timeAgo(e.updatedAt)}
                  {total ? ` · ${usd(total)}` : ''}
                </p>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white px-4 pt-3">
        <div className="mx-auto max-w-2xl">
          <Button size="lg" className="w-full" onClick={onNew}>
            + New estimate
          </Button>
        </div>
      </div>
    </div>
  );
}
