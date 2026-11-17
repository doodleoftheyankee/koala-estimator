// The roof_lookups rows the satellite lookup route (app/api/roof) reads and writes with the service
// role: finding a finished lookup of the same house to use again, and marking a paid lookup done.
// No server-only import, so the tests can hand it a stand-in client.
import type { SupabaseClient } from '@supabase/supabase-js';
import { matchedKey } from './address';
import { addressKey, pickSaved, pinBox, REUSE_HOURS, type LatLng, type RoofResult, type SavedLookup } from './lookup';

export type LookupDb = Pick<SupabaseClient, 'from'>;

/**
 * The keys a typed address can be found by: as typed, and the way an estimate made from it would
 * send it (a Google-style address with ", USA", a ZIP+4 or "DE, 19711" comes to the same key).
 */
export function reuseKeys(address: string): string[] {
  const key = addressKey(address);
  const norm = matchedKey({ address });
  return norm && norm !== key ? [key, norm] : [key];
}

/**
 * The newest finished lookup of this address or pin from the last day, or null. An address is
 * matched as typed first, then against the address Google matched. A check that fails is logged
 * and the next one tried (the matched-address column may not be there yet).
 */
export async function savedLookup(db: LookupDb, address: string | null, pin: LatLng | null) {
  const since = new Date(Date.now() - REUSE_HOURS * 60 * 60 * 1000).toISOString();
  const recent = () => db.from('roof_lookups').select('id, created_at, result, pin_lat, pin_lng').eq('status', 'done').gte('created_at', since);
  const queries = [];
  if (address !== null) {
    const keys = reuseKeys(address);
    queries.push(recent().in('address_key', keys), recent().in('matched_key', keys));
  } else if (pin) {
    const { dLat, dLng } = pinBox(pin);
    queries.push(recent().gte('pin_lat', pin.lat - dLat).lte('pin_lat', pin.lat + dLat).gte('pin_lng', pin.lng - dLng).lte('pin_lng', pin.lng + dLng));
  }
  for (const q of queries) {
    const { data, error } = await q.order('created_at', { ascending: false }).limit(5);
    if (error) {
      console.error('[roof] could not check for a saved lookup', error.message);
      continue;
    }
    const saved = pickSaved((data ?? []) as SavedLookup[], pin);
    if (saved) return saved;
  }
  return null;
}

/**
 * Marks a paid lookup done with its result, then adds the key of the address Google matched on its
 * own, so the lookup is still saved (and used again) if that column isn't there yet.
 */
export async function finishLookup(db: LookupDb, lookupId: string, result: RoofResult): Promise<void> {
  const { error } = await db.from('roof_lookups').update({ status: 'done', result }).eq('id', lookupId);
  if (error) {
    console.error('[roof] could not log the lookup', error.message);
    return;
  }
  const key = matchedKey(result);
  if (key === null) return;
  const { error: keyError } = await db.from('roof_lookups').update({ matched_key: key }).eq('id', lookupId);
  if (keyError) console.error('[roof] could not save the matched address (is migration 20261118000001 applied?)', keyError.message);
}
