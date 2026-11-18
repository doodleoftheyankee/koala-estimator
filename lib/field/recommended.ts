// Which option an estimate recommends, worked out once for the field app's dock, the option
// cards and the list: the option the estimator picked, else Better, else the first option.
// The customer quote marks the same one (lib/quotes/model.ts falls back to Better as well).

/** The tier of the recommended option, and whether the estimator picked it or it is the default. */
export function recommendedTier<T extends string>(
  options: ReadonlyArray<{ tier: T }>,
  selectedTier: string | null | undefined,
): { tier: T; picked: boolean } | null {
  const picked = options.find((o) => o.tier === selectedTier);
  if (picked) return { tier: picked.tier, picked: true };
  const fallback = options.find((o) => o.tier === 'better') ?? options[0];
  return fallback ? { tier: fallback.tier, picked: false } : null;
}
