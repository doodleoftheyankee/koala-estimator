// Reads the US address Google matched ("12 Elkton Rd, Newark, DE 19711, USA") into the estimate's
// street, city, state and ZIP, for "Start an estimate here" on the Roof lookup page, and the match
// key the server finds a saved lookup by. Pure.
import { addressKey, lookupAddress, type RoofResult } from './lookup';

export interface UsAddress {
  street: string;
  city: string;
  /** Two capital letters. */
  state: string;
  /** Five digits (a ZIP+4 is cut to its first five). */
  zip: string;
}

/** USPS state codes: the states, DC, and the territories Google can place. */
const STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP'.split(' '),
);
/** The estimate form's limits on street and city. */
const MAX_STREET = 120;
const MAX_CITY = 60;

/**
 * Street, city, state and ZIP from a formatted US address, or null when it isn't one with all four
 * (no street number line, no ZIP, another country, a pin with no address). A suite on its own line
 * stays with the street ("123 Main St, Suite 400").
 */
export function parseUsAddress(text: string | null | undefined): UsAddress | null {
  if (!text) return null;
  const parts = text
    .split(',')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (parts.length && /^(usa|us|u\.s\.a?\.?|united states(?: of america)?)$/i.test(parts.at(-1)!)) parts.pop();
  // "DE 19711", or the state and ZIP as two parts ("DE, 19711").
  if (parts.length >= 2 && /^\d{5}(?:-\d{4})?$/.test(parts.at(-1)!) && /^[A-Za-z]{2}$/.test(parts.at(-2)!)) {
    const zip = parts.pop()!;
    parts.push(`${parts.pop()!} ${zip}`);
  }
  if (parts.length < 3) return null;
  const m = /^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(parts.at(-1)!);
  if (!m) return null;
  const state = m[1]!.toUpperCase();
  if (!STATES.has(state)) return null;
  const city = parts.at(-2)!;
  const street = parts.slice(0, -2).join(', ');
  if (!/[A-Za-z]/.test(city) || /\d{5}/.test(city) || !/[A-Za-z]/.test(street)) return null;
  if (street.length > MAX_STREET || city.length > MAX_CITY) return null;
  return { street, city, state, zip: m[2]! };
}

/** A street that starts with a house number ("12 Elkton Rd", "12B Elkton Rd"). */
const numbered = (a: UsAddress | null) => (a && /^\d/.test(a.street) ? a : null);

/**
 * The address for "Start an estimate here", from Google's address for the house and what was typed:
 * Google's when it has a house number; else the typed address when it is a whole one with a number;
 * else the typed number and street with Google's city, state and ZIP (Google matched only the road);
 * else Google's (a named place or a corner). Null when neither is a whole US address. For a roof
 * tapped on the photo, `google` is the address Google matched when the house was first looked up.
 */
export function estimateAddress(google: string | null | undefined, typed: string | null | undefined): UsAddress | null {
  const g = parseUsAddress(google);
  const t = parseUsAddress(typed);
  if (numbered(g)) return g;
  if (numbered(t)) return t;
  const street = (typed ?? '').split(',')[0]!.replace(/\s+/g, ' ').trim();
  if (g && /^\d+[A-Za-z]?\s+\S*[A-Za-z]/.test(street) && street.length <= MAX_STREET) return { ...g, street };
  return g ?? t;
}

/**
 * The match key of the address Google matched for a lookup, as an estimate made from it would look
 * the house up (its street, city, state and ZIP), or null when that isn't a whole US address.
 */
export function matchedKey(r: Pick<RoofResult, 'address'>): string | null {
  const parsed = parseUsAddress(r.address);
  const address = parsed ? lookupAddress(parsed) : null;
  return address ? addressKey(address) : null;
}
