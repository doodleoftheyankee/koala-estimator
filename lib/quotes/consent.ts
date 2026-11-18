// The exact consent text shown next to the signature checkbox and stored in the e-sign audit trail.
// Changing it changes what future signers agree to; never edit it for already-signed quotes.
import { stateName } from '@/lib/locations/location';

/**
 * The consent for a quote from a store in `state`. It names the store's state's version of the
 * Uniform Electronic Transactions Act. New York never adopted UETA (its Electronic Signatures and
 * Records Act applies), so New York stores cite that law instead. Delaware's text is unchanged
 * from before stores existed.
 */
export function esignConsent(state: string): string {
  const code = state.trim().toUpperCase();
  const law = code === 'NY' ? 'New York Electronic Signatures and Records Act' : `${stateName(code)} UETA`;
  return (
    `I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and ${law}). ` +
    'I accept the option and price I selected above and the terms of this quote.'
  );
}
