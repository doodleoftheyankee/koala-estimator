import { describe, expect, it } from 'vitest';
import { esignConsent } from './consent';

describe('esignConsent', () => {
  it('is word for word the text Delaware signers have always seen', () => {
    expect(esignConsent('DE')).toBe(
      'I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and Delaware UETA). I accept the option and price I selected above and the terms of this quote.',
    );
  });
  it('names the store\'s state', () => {
    expect(esignConsent('tx')).toContain('(ESIGN Act and Texas UETA)');
    expect(esignConsent('NY')).toContain('(ESIGN Act and New York Electronic Signatures and Records Act)');
    expect(esignConsent('TX')).not.toContain('Delaware');
  });
});
