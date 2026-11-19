// The e-sign consent sentence shown next to the signature checkbox and stored in the e-sign audit
// trail. Changing it changes what future signers agree to; a quote keeps the sentence it was sent
// with (hard rule 1), so an already-sent quote is signed under the words it showed.
import type { QuoteDocument } from './model';

/**
 * The sentence quotes carried before quotes named their own state (documents sent before the
 * accuracy round, Nov 2026, have no consent of their own). Kept word for word so those quotes
 * are still signed under the sentence they were sent with; new quotes never use it.
 */
export const LEGACY_ESIGN_CONSENT =
  'I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and Delaware UETA). I accept the option and price I selected above and the terms of this quote.';

/** US states and DC by postal code, for the state a consent sentence names. */
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
 * A state that never adopted the Uniform Electronic Transactions Act has its own e-signature act,
 * named instead of "<State> UETA" (release review C DOC-2): New York's is the Electronic Signatures
 * and Records Act (State Technology Law, article 3). Counsel to confirm (owner questions).
 */
const OWN_ESIGN_ACT: Readonly<Record<string, string>> = { NY: 'the New York Electronic Signatures and Records Act' };

/**
 * The consent sentence for a new quote (OD14): naming the e-sign law of the state given (the
 * property's state, else the shop address's: lib/quotes/profile.ts consentState), or, with no
 * state, the federal and uniform acts by name. Never throws: a send never waits for a state.
 */
export function esignConsent(stateCode: string | null | undefined): string {
  const name = stateName(stateCode);
  const own = name ? OWN_ESIGN_ACT[stateCode!.trim().toUpperCase()] : undefined;
  const law = own ? `ESIGN Act and ${own}` : name ? `ESIGN Act and ${name} UETA` : 'ESIGN Act and the Uniform Electronic Transactions Act';
  return `I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (${law}). I accept the option and price I selected above and the terms of this quote.`;
}

/** The sentence a quote is signed under: its own, or for a quote sent before quotes carried one, the sentence it was sent with. */
export function consentFor(doc: Pick<QuoteDocument, 'consent'>): string {
  return doc.consent ?? LEGACY_ESIGN_CONSENT;
}
