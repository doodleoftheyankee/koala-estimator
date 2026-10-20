// Demo mode (DEMO_MODE=1): the sign-in page offers one-tap accounts so the app can be shown
// without email codes. The accounts and sample history come from scripts/demo-seed.ts; their
// shared password lives only in the server environment (DEMO_PASSWORD). Turn it off for real use.
export const DEMO_ACCOUNTS = {
  owner: { email: 'owner.demo@example.com', label: 'Owner', who: 'Richard', home: '/estimates', blurb: 'Every estimate, jobs, pricing and the learning dashboard' },
  estimator: { email: 'estimator.demo@example.com', label: 'Estimator', who: 'Erin', home: '/field', blurb: 'Build and send a quote on a phone, even offline' },
  crew: { email: 'crew.demo@example.com', label: 'Crew lead', who: 'Carlos', home: '/crew', blurb: "Today's jobs, start, enter actuals, complete" },
} as const;
/** Fixed ids of the demo accounts (lib/demo/seed.ts references them). */
export const DEMO_USER_IDS = {
  owner: 'd0000000-0000-4000-8000-000000000001',
  estimator: 'd0000000-0000-4000-8000-000000000002',
  crew: 'd0000000-0000-4000-8000-000000000003',
};

export type DemoRole = keyof typeof DEMO_ACCOUNTS;

export const isDemoRole = (v: unknown): v is DemoRole => typeof v === 'string' && Object.hasOwn(DEMO_ACCOUNTS, v);

export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === '1' && !!process.env.DEMO_PASSWORD;
}
