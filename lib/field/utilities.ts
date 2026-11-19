// The electric utility suggestions on the Customer step: the names this phone's estimates already
// use, so each franchise's estimators see their own utilities and no franchise's list is typed into
// the code (hard rule 3, review B flow-B7). Pure; app/field/CustomerStep reads the phone's estimates.

/** Distinct utility names (case-insensitive), most used first, then A to Z; at most `limit`. */
export function utilitySuggestions(drafts: ReadonlyArray<{ property: { utility?: string | null } }>, limit = 12): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const d of drafts) {
    const name = d.property.utility?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const seen = counts.get(key);
    if (seen) seen.n += 1;
    else counts.set(key, { name, n: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((u) => u.name);
}
