'use client';
// The way into the blower door tool from a job (crew app) or an estimate (field app): a plate with
// the readings already saved to it (on the server or still on this phone) and a plain link, so the
// service worker opens the tool with no signal. With signal it loads the saved readings onto the
// phone, so the estimator's test-in is there when the crew opens the tool in an attic with none.
import { useEffect } from 'react';
import { blowerDoorDb, fetchContext, formKey } from '@/lib/offline/blowerDoor';
import { blowerDoorHref, contextKey, mergeReadings, newestOf, type BlowerDoorContext, type LocalTest } from '@/lib/offline/blowerDoorCore';
import type { LocalContext } from '@/lib/offline/blowerDoor';
import { cfmText } from '@/lib/blowerdoor';
import { buttonClass, ChevronRight, Icon, SignLabel, Wind } from '@/components/daymark';
import { useLive } from '../hooks';

export function BlowerDoorLink({
  context,
  ownerId,
  hint,
  prefetch = true,
}: {
  context: BlowerDoorContext;
  ownerId: string;
  hint: string;
  /** Load the saved readings while there is signal (false: the estimate is not on the server yet). */
  prefetch?: boolean;
}) {
  const saved = useLive<LocalContext | undefined>(() => blowerDoorDb().contexts.get(formKey(ownerId, context)), [ownerId, context.kind, context.id], undefined);
  const local = useLive<LocalTest[]>(
    () =>
      blowerDoorDb()
        .tests.where('contextKey')
        .equals(contextKey(context))
        .and((t) => t.ownerId === ownerId)
        .toArray(),
    [ownerId, context.kind, context.id],
    [],
  );
  useEffect(() => {
    if (prefetch && navigator.onLine) void fetchContext(context, ownerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, context.kind, context.id, prefetch]);
  const shown = mergeReadings(saved?.tests ?? [], local);
  const testIn = newestOf(shown, 'test_in');
  const testOut = newestOf(shown, 'test_out');
  const line = (r: typeof testIn) => (r ? `${cfmText(r.test.cfm50)} CFM50` : 'Not yet');

  return (
    <section aria-labelledby={`bd-${context.id}`} className="plate p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-ink">
          <Icon icon={Wind} size="l" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`bd-${context.id}`} className="text-[19px] leading-snug font-extrabold text-ink">
            Blower door test
          </h2>
          <p className="mt-0.5 text-[15.5px] leading-snug font-medium text-ink-2">{hint}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <dt>
                <SignLabel>Test-in</SignLabel>
              </dt>
              <dd className="gauge-m mt-1 text-[22px] text-ink">{line(testIn)}</dd>
            </div>
            <div>
              <dt>
                <SignLabel>Test-out</SignLabel>
              </dt>
              <dd className="gauge-m mt-1 text-[22px] text-ink">{line(testOut)}</dd>
            </div>
          </dl>
        </div>
      </div>
      {/* A plain page load (not the Next router), so the service worker can open the tool offline. */}
      <a href={blowerDoorHref(context)} className={buttonClass({ block: true }, 'mt-3 no-underline')}>
        {testIn || testOut ? 'Open the blower door test' : 'Start the blower door test'}
        <Icon icon={ChevronRight} />
      </a>
    </section>
  );
}
