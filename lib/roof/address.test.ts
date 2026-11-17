import { describe, expect, it } from 'vitest';
import { estimateAddress, matchedKey, parseUsAddress } from './address';
import { addressKey, lookupAddress } from './lookup';

describe('parseUsAddress', () => {
  it('reads the addresses Google matches', () => {
    expect(parseUsAddress('12 Elkton Rd, Newark, DE 19711, USA')).toEqual({ street: '12 Elkton Rd', city: 'Newark', state: 'DE', zip: '19711' });
    expect(parseUsAddress('3 Cross Gable Ct, Newark, DE 19711, USA')).toEqual({ street: '3 Cross Gable Ct', city: 'Newark', state: 'DE', zip: '19711' });
    expect(parseUsAddress('1600 Pennsylvania Avenue NW, Washington, DC 20500, USA')).toEqual({ street: '1600 Pennsylvania Avenue NW', city: 'Washington', state: 'DC', zip: '20500' });
    expect(parseUsAddress('210 S Delaware Ave, Bear, DE 19701, United States')).toEqual({ street: '210 S Delaware Ave', city: 'Bear', state: 'DE', zip: '19701' });
  });

  it('keeps a unit or suite with the street', () => {
    expect(parseUsAddress('100 W Main St #2, Newark, DE 19716, USA')).toEqual({ street: '100 W Main St #2', city: 'Newark', state: 'DE', zip: '19716' });
    expect(parseUsAddress('1 Commerce St, Suite 400, Wilmington, DE 19801, USA')).toEqual({ street: '1 Commerce St, Suite 400', city: 'Wilmington', state: 'DE', zip: '19801' });
  });

  it('cuts a ZIP+4 to five digits, and takes a state and ZIP sent apart', () => {
    expect(parseUsAddress('500 Ogletown Rd, Newark, DE 19711-5401, USA')?.zip).toBe('19711');
    expect(parseUsAddress('500 Ogletown Rd, Newark, DE, 19711, USA')).toEqual({ street: '500 Ogletown Rd', city: 'Newark', state: 'DE', zip: '19711' });
  });

  it('tidies spacing and case, and works without the country', () => {
    expect(parseUsAddress('  12  Elkton Rd ,  Newark,de   19711 ')).toEqual({ street: '12 Elkton Rd', city: 'Newark', state: 'DE', zip: '19711' });
    expect(parseUsAddress('7 Old Rd, Elkton, MD 21921')).toEqual({ street: '7 Old Rd', city: 'Elkton', state: 'MD', zip: '21921' });
  });

  it('gives the same address the area lookup sends, so a saved lookup of it is found again', () => {
    const p = parseUsAddress('12 Elkton Rd, Newark, DE 19711, USA')!;
    expect(lookupAddress(p)).toBe('12 Elkton Rd, Newark, DE 19711');
    expect(addressKey(lookupAddress(p)!)).toBe('12 elkton rd newark de 19711');
  });

  it('is null for anything that is not a whole US street address', () => {
    for (const odd of [
      null,
      undefined,
      '',
      'Newark, DE 19711, USA', // no street
      'Delaware, USA',
      '12 Elkton Rd, Newark, DE, USA', // no ZIP
      '12 Elkton Rd, Newark, 19711, USA', // no state
      '10 Downing St, London SW1A 2AA, UK',
      '24 Sussex Dr, Ottawa, ON K1M 1M4, Canada',
      '12 Elkton Rd, Newark, XX 19711, USA', // not a state
      '39.6834, -75.7504',
      '12 Elkton Rd',
      `${'x'.repeat(121)}, Newark, DE 19711, USA`, // longer than the street field
    ]) {
      expect(parseUsAddress(odd), String(odd)).toBeNull();
    }
  });

  it('reads an intersection or a named place as the street', () => {
    expect(parseUsAddress('Elkton Rd & W Main St, Newark, DE 19711, USA')?.street).toBe('Elkton Rd & W Main St');
    expect(parseUsAddress('One Customs House, Wilmington, DE 19801, USA')?.street).toBe('One Customs House');
  });
});

describe('matchedKey', () => {
  it('is the key the area sheet sends for an estimate started from the lookup', () => {
    expect(matchedKey({ address: '3 Cross Gable Ct, Newark, DE 19711, USA' })).toBe(addressKey('3 Cross Gable Ct, Newark, DE 19711'));
    expect(matchedKey({ address: '3 Cross Gable Ct, Newark, DE 19711, USA' })).toBe('3 cross gable ct newark de 19711');
  });

  it('is null for a tapped roof or an address that is not a whole US address', () => {
    expect(matchedKey({ address: null })).toBeNull();
    expect(matchedKey({ address: 'Newark, DE 19711, USA' })).toBeNull();
  });
});

describe('estimateAddress', () => {
  it("takes Google's address when it has a house number", () => {
    expect(estimateAddress('3 Cross Gable Ct, Newark, DE 19711, USA', '3 cross gable')).toEqual({ street: '3 Cross Gable Ct', city: 'Newark', state: 'DE', zip: '19711' });
  });

  it('keeps the typed house number when Google matched only the road', () => {
    // Typed whole: the typed address.
    expect(estimateAddress('Elkton Rd, Newark, DE 19711, USA', '123 Elkton Rd, Newark, DE 19711')).toEqual({ street: '123 Elkton Rd', city: 'Newark', state: 'DE', zip: '19711' });
    // Typed without the ZIP: the typed number and street, Google's city, state and ZIP.
    expect(estimateAddress('Elkton Rd, Newark, DE 19711, USA', '123 Elkton Rd, Newark DE')).toEqual({ street: '123 Elkton Rd', city: 'Newark', state: 'DE', zip: '19711' });
    expect(estimateAddress('Elkton Rd, Newark, DE 19711, USA', '12B Elkton Rd')).toEqual({ street: '12B Elkton Rd', city: 'Newark', state: 'DE', zip: '19711' });
    // Nothing better typed: Google's, as before.
    expect(estimateAddress('Elkton Rd, Newark, DE 19711, USA', 'Elkton Rd Newark')).toEqual({ street: 'Elkton Rd', city: 'Newark', state: 'DE', zip: '19711' });
    expect(estimateAddress('One Customs House, Wilmington, DE 19801, USA', 'customs house')?.street).toBe('One Customs House');
  });

  it('uses the typed address for a tapped roof when there is no earlier Google address', () => {
    expect(estimateAddress(null, '12 Elkton Rd, Newark, DE 19711')).toEqual({ street: '12 Elkton Rd', city: 'Newark', state: 'DE', zip: '19711' });
    expect(estimateAddress(null, '12 Elkton Rd')).toBeNull();
    expect(estimateAddress(null, null)).toBeNull();
    expect(estimateAddress(undefined, '39.6834,-75.7504')).toBeNull();
  });
});
