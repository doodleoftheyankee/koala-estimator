// The e-sign consent sentence shown next to the signature checkbox and stored in the e-sign audit
// trail. Changing it changes what future signers agree to; a quote keeps the sentence it was sent
// with (hard rule 1), so an already-sent quote is signed under the words it showed.
import type { QuoteDocument } from './model';

/**
 * The sentence quotes carried before the business profile named the state (documents sent before
 * the accuracy round, Nov 2026, have no consent of their own). Kept word for word so those quotes
 * are still signed under the sentence they were sent with; new quotes never use it.
 */
export const LEGACY_ESIGN_CONSENT =
  'I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and Delaware UETA). I accept the option and price I selected above and the terms of this quote.';

/** US states and DC by postal code, for the state the business profile names. */
export const STATE_NAMES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** The state's name for a postal code ("DE" -> "Delaware"), or null when it is not one. */
export function stateName(code: string | null | undefined): string | null {
  return code ? (STATE_NAMES[code.trim().toUpperCase()] ?? null) : null;
}

/**
 * The consent sentence for a new quote, naming the state in the business profile (the profile
 * cannot send a quote without one: lib/quotes/profile.ts). Throws for a code that is not a state.
 */
export function esignConsent(stateCode: string): string {
  const name = stateName(stateCode);
  if (!name) throw new Error(`Not a US state: ${stateCode}`);
  return `I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and ${name} UETA). I accept the option and price I selected above and the terms of this quote.`;
}

/** The sentence a quote is signed under: its own, or for a quote sent before quotes carried one, the sentence it was sent with. */
export function consentFor(doc: Pick<QuoteDocument, 'consent'>): string {
  return doc.consent ?? LEGACY_ESIGN_CONSENT;
}
