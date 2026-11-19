// Where a "Fix" button takes the estimator in the field app: a step of the estimate, and the part of
// it to open. Pure. The measuring check (lib/field/measuring) and the Send checklist
// (lib/field/sendChecks) use these targets; app/field/EstimateEditor follows them.
import type { MeasureField } from '@/lib/measure/measure';
import type { Tier } from '@/lib/pricing';

/** A customer or address field on the Customer step, or the notes for the quote (review B flow-B5). */
export type CustomerField = 'firstName' | 'lastName' | 'email' | 'street' | 'city' | 'state' | 'zip' | 'notes';

export type FixTarget =
  /** Open the Customer step at this field. */
  | { step: 'customer'; field: CustomerField }
  /**
   * Open an area on the Areas step: its measuring sheet ('measure'), its square feet ('size'), or
   * just the card. With no area, the step itself (to add one).
   */
  | {
      step: 'areas';
      areaId: string;
      open?: 'measure' | 'size';
      /** With open 'measure': the first thing to finish in the Measure sheet, focused when it opens (review B flow-B12). */
      field?: MeasureField | null;
    }
  | { step: 'areas'; areaId?: undefined; open?: undefined }
  /** Open the Options step, at one option when given; edit 'price' opens its price editor at Customer price (flow-B12). */
  | { step: 'options'; tier?: Tier; edit?: 'price' }
  /** The Business profile page (owner and office). */
  | { step: 'business' };

export interface Fix {
  /** The button's words, e.g. "Finish measuring". */
  label: string;
  target: FixTarget;
}

/** The element id a fix focuses or scrolls to once its step is open (null: the top of the step). */
export function fixElementId(t: FixTarget): string | null {
  switch (t.step) {
    case 'customer':
      return `customer-${t.field}`;
    case 'areas':
      return t.areaId ? (t.open === 'size' ? `area-${t.areaId}-sqft` : `area-${t.areaId}`) : 'add-area';
    case 'options':
      return t.tier ? (t.edit === 'price' ? `option-${t.tier}-price` : `option-${t.tier}`) : null;
    case 'business':
      return null;
  }
}
