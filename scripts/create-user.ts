// Creates the first owner account (or any user) directly, bypassing the invite email.
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run bootstrap:owner -- --email you@example.com --name "Your Name" [--role owner] [--location <store id>]
// --location: the store they work in (required once there is more than one store; see
// scripts/create-location.ts). With one store, they join it automatically.
import { createClient } from '@supabase/supabase-js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');

const email = args.get('email');
const name = args.get('name');
const role = args.get('role') ?? 'owner';
const location = args.get('location') || null;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !name || !url || !key || !['owner', 'office', 'estimator', 'crew'].includes(role)) {
  console.error('Usage: npm run bootstrap:owner -- --email you@example.com --name "Your Name" [--role owner|office|estimator|crew]');
  console.error('Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
if (error) {
  console.error(`Could not create auth user: ${error.message}`);
  process.exit(1);
}
const { error: profileError } = await supabase.from('profiles').insert({ id: data.user.id, role, full_name: name, email });
if (profileError) {
  console.error(`Auth user created but profile insert failed: ${profileError.message}`);
  process.exit(1);
}
if (location) {
  const { error: memberError } = await supabase
    .from('location_members')
    .upsert({ location_id: location, profile_id: data.user.id, role, active: true }, { onConflict: 'location_id,profile_id' });
  if (memberError) {
    console.error(`User created but adding them to store ${location} failed: ${memberError.message}`);
    process.exit(1);
  }
} else {
  const { count } = await supabase.from('location_members').select('location_id', { count: 'exact', head: true }).eq('profile_id', data.user.id);
  if (!count) console.warn('There is more than one store: add --location <store id> so this person can use one.');
}
console.log(`Created ${role} ${name} <${email}>${location ? ` in store ${location}` : ''}. Sign in at /login with an email code.`);
