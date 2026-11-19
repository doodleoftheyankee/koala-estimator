// The town and state a new estimate starts in (L32, OD14): the pair the pricing bundle names
// (business.newEstimate, worked out on the server from the settings), both or neither, never a
// town from one source with a state from another. Offline it is the bundle the phone last
// downloaded. On a phone's first open there is none yet (review B flow-B13): the field app waits
// for it, at most BUNDLE_WAIT_MS, when online, and if it comes later the editor fills both, while
// both are still blank. Pure, apart from the timer.
import type { PricingBundle } from '@/lib/pricing';
import type { EstimateDraft } from '@/lib/sync/draft';

export type Place = { city: string; state: string };

/** How long a new estimate waits for the phone's first bundle before it starts without a town. */
export const BUNDLE_WAIT_MS = 3000;

/** The bundle's town and state for a new estimate, as a pair; null when it names no complete pair. */
export function newEstimatePlace(bundle: Pick<PricingBundle, 'business'> | null | undefined): Place | null {
  const p = bundle?.business?.newEstimate;
  const city = p?.city?.trim() ?? '';
  const state = p?.state?.trim() ?? '';
  return city && state ? { city, state } : null;
}

/** The draft in that town and state, when its town and state are both still blank; else the draft as it is. */
export function withPlaceIfBlank(d: EstimateDraft, place: Place): EstimateDraft {
  if (d.property.city.trim() || d.property.state.trim()) return d;
  return { ...d, property: { ...d.property, city: place.city, state: place.state } };
}

/**
 * The bundle a new estimate starts from: the cached one; with none and a connection, the one being
 * downloaded if it arrives within `ms`; else null (the estimate starts blank and is filled later).
 */
export async function bundleForNewEstimate<B>(cached: B | null, fetchBundle: () => Promise<B | null>, online: boolean, ms = BUNDLE_WAIT_MS): Promise<B | null> {
  if (cached || !online) return cached;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([fetchBundle().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}
