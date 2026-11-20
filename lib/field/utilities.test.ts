import { describe, expect, it } from 'vitest';
import { utilitySuggestions } from './utilities';

// Hard rule 3 (review B flow-B7): the electric utility suggestions on the Customer step are the
// names this phone's estimates already use, not one franchise's list typed into the code.
describe('electric utility suggestions', () => {
  it('the names already used on this phone, most used first, each once', () => {
    const d = (utility: string | null) => ({ property: { utility } });
    expect(utilitySuggestions([d('Metro Power'), d(' Valley Electric '), d('Metro Power'), d(null), d(''), d('metro power'), d('Acme Co-op')])).toEqual([
      'Metro Power',
      'Acme Co-op',
      'Valley Electric',
    ]);
  });
  it('none yet: no suggestions (the estimator types it)', () => {
    expect(utilitySuggestions([])).toEqual([]);
  });
  it('at most the limit', () => {
    expect(utilitySuggestions(Array.from({ length: 20 }, (_, i) => ({ property: { utility: `U${i}` } })), 5)).toHaveLength(5);
  });
});
