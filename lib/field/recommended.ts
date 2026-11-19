// Which option an estimate recommends, worked out once for the field app's dock, the option
// cards, the phone's list, the office list (lib/office/estimates.ts), the sync's model total
// (lib/sync/payload.ts) and the customer quote (lib/quotes/model.ts), so the headline price is the
// same option's price everywhere (OD1):
//  - the option the estimator picked;
//  - when the picked option is not shown (OD6 hides an option that repeats a cheaper one or does
//    not step up), the next option shown after it, else the nearest one before it;
//  - with no pick, Better, else the first option.

const ORDER = ['good', 'better', 'best'];
const rank = (tier: string) => {
  const i = ORDER.indexOf(tier);
  return i < 0 ? ORDER.length : i;
};

/** The tier of the recommended option, and whether the estimator picked it or it is the default. */
export function recommendedTier<T extends string>(
  options: ReadonlyArray<{ tier: T }>,
  selectedTier: string | null | undefined,
): { tier: T; picked: boolean } | null {
  const picked = options.find((o) => o.tier === selectedTier);
  if (picked) return { tier: picked.tier, picked: true };
  if (selectedTier && ORDER.includes(selectedTier)) {
    // The pick is gone: the next option shown after it, else the nearest one before it.
    const at = rank(selectedTier);
    const byRank = [...options].sort((a, b) => rank(a.tier) - rank(b.tier));
    const next = byRank.find((o) => rank(o.tier) > at) ?? byRank.filter((o) => rank(o.tier) < at).pop();
    if (next) return { tier: next.tier, picked: false };
  }
  const fallback = options.find((o) => o.tier === 'better') ?? options[0];
  return fallback ? { tier: fallback.tier, picked: false } : null;
}
