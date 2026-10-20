// Central access to environment variables, with clear errors when one is missing.

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

export const publicEnv = {
  supabaseUrl: () => required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: () => required('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
};

export const serverEnv = {
  serviceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
  appUrl: () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  resendApiKey: () => process.env.RESEND_API_KEY || null,
  quoteFromEmail: () => process.env.QUOTE_FROM_EMAIL || 'Koala Insulation of Newark <onboarding@resend.dev>',
  officeNotifyEmail: () => process.env.OFFICE_NOTIFY_EMAIL || null,
  googleMapsApiKey: () => process.env.GOOGLE_MAPS_API_KEY || null,
  /** Shared secret Vercel Cron sends as `Authorization: Bearer <CRON_SECRET>`. Unset = cron endpoints refuse to run. */
  cronSecret: () => process.env.CRON_SECRET || null,
  /** Where the nightly job reports failures (and, in Phase 4, the weekly owner report). */
  ownerReportEmail: () => process.env.OWNER_REPORT_EMAIL || null,
};
