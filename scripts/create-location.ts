// Opens a new store (corporate set-up). Copies the template store's setup (settings, materials,
// labor roles, crews, good/better/best menu, code minimums, lead sources), gives the new store a
// fresh pricing set from the industry starting values (never another store's learned numbers),
// and flags every market-dependent value (costs, crew rates, code minimums) for the new owner.
// Then add the new owner with scripts/create-user.ts --location <the id printed here>.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run create:location -- --name "Koala Insulation of Dover" --short Dover \
//     --tz America/New_York --state DE --zone 4A [--county Kent] [--shop "123 Main St, Dover, DE 19901"] [--template <store id>]
//
// The database refuses until the multi-location cleanup migration is applied (so nothing that
// predates stores can write into the wrong store).
import { createClient } from '@supabase/supabase-js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');

const name = args.get('name');
const short = args.get('short');
const tz = args.get('tz');
const state = args.get('state');
const zone = args.get('zone');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!name || !short || !tz || !state || !zone || !url || !key) {
  console.error(
    'Usage: npm run create:location -- --name "Koala Insulation of Dover" --short Dover --tz America/New_York --state DE --zone 4A ' +
      '[--county Kent] [--shop "address"] [--template <store id>]',
  );
  console.error('Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await supabase.rpc('create_location', {
  p_name: name,
  p_short_name: short,
  p_time_zone: tz,
  p_state: state,
  p_climate_zone: zone,
  p_county: args.get('county') || null,
  p_shop_address: args.get('shop') || null,
  p_template: args.get('template') || null,
});
if (error) {
  console.error(`Could not open the store: ${error.message}`);
  process.exit(1);
}
console.log(`Opened ${name} (store id ${String(data)}).`);
console.log('Next: add its owner with npm run bootstrap:owner -- --email ... --name ... --role owner --location ' + String(data));
console.log('The owner then confirms costs, crew rates and code minimums on the Pricing page, and sets the store sender email.');
