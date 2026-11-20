// Which option an estimate recommends, worked out once for the field app's dock, the option
// cards, the phone's list, the office list (lib/office/estimates.ts), the sync's model total
// (lib/sync/payload.ts) and the customer quote (lib/quotes/model.ts), so the headline price is the
// same option's price everywhere (OD1):
//  - the option the estimator picked; with no pick, Better, the implied pick (OD15);
//  - when that option is not shown (OD6 hides an option that repeats a cheaper one or does not
//    step up), the option shown that does the same work (the engine's sameWorkAs), else the
//    nearest one shown above it, else the nearest one below it. A pick and no pick of Better
//    therefore recommend the same option (review B flow-B4);
//  - with no option of a known tier, the first option.

const ORDER = ['good', 'better', 'best'];
const rank = (tier: string) => {
  const i = ORDER.indexOf(tier);
  return i < 0 ? ORDER.length : i;
};

/** The tier of the recommended option, and whether the estimator picked it or it is the default. */
export function recommendedTier<T extends string>(
  options: ReadonlyArray<{ tier: T; sameWorkAs?: ReadonlyArray<string> }>,
  selectedTier: string | null | undefined,
): { tier: T; picked: boolean } | null {
  const picked = options.find((o) => o.tier === selectedTier);
  if (picked) return { tier: picked.tier, picked: true };
  // No pick (or no tier): Better is the implied pick, exactly as when Better is picked (OD15).
  const want = selectedTier && ORDER.includes(selectedTier) ? selectedTier : 'better';
  const shown = options.find((o) => o.tier === want);
  if (shown) return { tier: shown.tier, picked: false };
  // The pick is not shown: the option doing the same work, else the nearest above, else the nearest below.
  const at = rank(want);
  const byRank = [...options].sort((a, b) => rank(a.tier) - rank(b.tier));
  const next =
    options.find((o) => o.sameWorkAs?.includes(want)) ??
    byRank.find((o) => rank(o.tier) > at && rank(o.tier) < ORDER.length) ??
    byRank.filter((o) => rank(o.tier) < at).pop() ??
    options[0];
  return next ? { tier: next.tier, picked: false } : null;
}
