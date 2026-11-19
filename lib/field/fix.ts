// Where a "Fix" button takes the estimator in the field app: a step of the estimate, and the part of
// it to open. Pure. The measuring check (lib/field/measuring) uses it; a Send checklist can use the
// same targets for its own Fix buttons.

/** Open an area on the Areas step, with its measuring sheet when `open` is 'measure'. */
export type FixTarget = { step: 'areas'; areaId: string; open?: 'measure' };

export interface Fix {
  /** The button's words, e.g. "Finish measuring". */
  label: string;
  target: FixTarget;
}
