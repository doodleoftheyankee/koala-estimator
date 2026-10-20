// Creates the first owner account (or any user) directly, bypassing the invite email.
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run bootstrap:owner -- --email you@example.com --name "Your Name" [--role owner]
import { createClient } from '@supabase/supabase-js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');

const email = args.get('email');
const name = args.get('name');
const role = args.get('role') ?? 'owner';
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
console.log(`Created ${role} ${name} <${email}>. Sign in at /login with an email code.`);
