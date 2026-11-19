// Code minimums as the data has them (L38, RF-17, S2-F18): which assembly the engine prices for each
// job type, and the editions the rows come from, for the Pricing page's banner. No town, state or
// code year is written here (hard rule 3); they are the owner's rows in code_requirements. Pure.

/** The assembly the engine prices for each job type (lib/server/snapshot.ts reads the same table). */
export const PRIMARY_ASSEMBLY: Readonly<Record<string, string>> = {
  attic: 'ceiling',
  walls: 'wood_frame_wall',
  crawlspace: 'floor',
  rim_joist: 'basement_wall',
  garage: 'ceiling',
  commercial: 'ceiling',
};

interface CodeRow {
  job_type: string;
  assembly: string;
  code_edition: string;
}

/** The row the engine prices a job type with: its primary assembly, else the job type's first row. */
export function pricedCodeRequirement<T extends CodeRow>(rows: readonly T[], jobType: string): T | undefined {
  const assembly = PRIMARY_ASSEMBLY[jobType];
  return rows.find((c) => c.job_type === jobType && c.assembly === assembly) ?? rows.find((c) => c.job_type === jobType);
}

/** "2018 IECC (local) and company default": the editions the rows name, in their order. Null when none. */
export function codeEditionsSentence(rows: readonly Pick<CodeRow, 'code_edition'>[]): string | null {
  const editions = [...new Set(rows.map((r) => r.code_edition.trim()).filter(Boolean))];
  if (editions.length === 0) return null;
  return editions.length === 1 ? editions[0]! : `${editions.slice(0, -1).join(', ')} and ${editions[editions.length - 1]}`;
}
