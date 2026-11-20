import type { Metadata } from 'next';
import { DEMO_ACCOUNTS, demoEnabled, type DemoRole } from '@/lib/demo/accounts';
import { loginErrorMessage } from '@/lib/auth/loginMessages';
import { loadPinNames, PIN_OFF_MESSAGE } from '@/lib/auth/pin';
import { serverEnv } from '@/lib/env';
import { safeNext } from '@/lib/safeNext';
import { createAdminClient } from '@/lib/supabase/admin';
import { Banner } from '@/components/daymark/Banner';
import { Monogram } from '@/components/daymark/Brand';
import { ChevronRight, CloudOff, Icon, LifeBuoy, Satellite, Signature, type LucideIcon } from '@/components/daymark/icons';
import { LoginForm } from './LoginForm';
import { PinSignIn, type PinPerson } from './PinSignIn';

export const metadata: Metadata = { title: 'Sign in' };

// What the product does, for the desktop panel. Facts about the app, no figures.
const FEATURES: Array<{ icon: LucideIcon; text: string }> = [
  { icon: Satellite, text: 'Measure attics and roofs from the satellite photo, or by hand.' },
  { icon: CloudOff, text: 'Estimates keep working in an attic with no signal.' },
  { icon: Signature, text: 'Customers compare options and sign on their own phone.' },
];

/**
 * The people who sign in with their name and PIN, read with the service role (signed out, nobody
 * may read profiles): their id and "First · Role" only. Off without PIN_SECRET.
 */
async function pinPeople(): Promise<{ state: 'off' } | { state: 'unreachable' } | { state: 'on'; people: PinPerson[] }> {
  if (!serverEnv.pinSecret()) return { state: 'off' };
  try {
    const names = await loadPinNames(createAdminClient({ retry: false }));
    return names ? { state: 'on', people: names.map((n) => ({ id: n.id, label: n.label })) } : { state: 'unreachable' };
  } catch {
    return { state: 'unreachable' };
  }
}

// Sign-in: the product's name, not a franchise's. A franchise's own name and colours appear on
// its customer quotes, not here.
// A repeated key (?next=/a&next=/b) arrives as an array: safeNext and the error lookup take one string only.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; error?: string | string[] }> }) {
  const { next, error } = await searchParams;
  const pin = await pinPeople();
  return (
    <main className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Desktop: what the product is. Dark in every theme. */}
      <section aria-label="About Koala Estimator" className="hidden flex-col justify-between bg-frame p-12 text-on-frame lg:flex">
        <Monogram size={56} label="" className="ring-2 ring-on-frame" />
        <div className="max-w-md space-y-8">
          <p className="text-[40px] leading-[1.05] font-extrabold tracking-[-0.02em]">Insulation estimates and quotes, from the attic to the signature.</p>
          <ul className="space-y-4">
            {FEATURES.map((f) => (
              <li key={f.text} className="flex items-start gap-3 text-[17px] font-medium">
                <Icon icon={f.icon} className="mt-0.5" />
                {f.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[15px] font-medium opacity-80">Koala Estimator</p>
      </section>

      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
        <header className="mb-8 flex items-center gap-4">
          <Monogram size={56} label="" />
          <div>
            <h1 className="text-[30px] leading-[1.07] font-extrabold tracking-[-0.02em]">Koala Estimator</h1>
            <p className="text-[16px] font-medium text-ink-2">Insulation estimates and quotes</p>
          </div>
        </header>

        {demoEnabled() ? (
          <section className="mb-8 space-y-3" aria-labelledby="demo">
            <h2 id="demo" className="sign-label text-ink-2">
              Demo: tap to sign in as
            </h2>
            <ul className="overflow-hidden rounded-plate border-[length:var(--bw)] border-solid border-edge bg-surface">
              {(Object.keys(DEMO_ACCOUNTS) as DemoRole[]).map((role, i) => {
                const a = DEMO_ACCOUNTS[role];
                return (
                  <li key={role} className={i > 0 ? 'border-t border-solid border-line' : undefined}>
                    <form action="/auth/demo" method="post">
                      <input type="hidden" name="as" value={role} />
                      <button className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[17px] font-extrabold text-ink">
                            {a.label} · {a.who}
                          </span>
                          <span className="block text-[15px] font-medium text-ink-2">{a.blurb}</span>
                        </span>
                        <Icon icon={ChevronRight} size="s" />
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
            <p className="text-[15px] font-medium text-ink-2">Team members sign in below.</p>
          </section>
        ) : null}

        {pin.state === 'on' && pin.people.length ? (
          <div className="mb-8">
            <PinSignIn people={pin.people} next={safeNext(next)} />
          </div>
        ) : pin.state === 'off' ? (
          <Banner className="mb-8" live={false}>
            {PIN_OFF_MESSAGE}
          </Banner>
        ) : pin.state === 'unreachable' ? (
          <Banner className="mb-8" tone="warn" live={false}>
            Can&rsquo;t load the names for PIN sign-in right now. Try again in a minute, or sign in with your email code.
          </Banner>
        ) : null}

        <section aria-labelledby="email-sign-in" className="space-y-3">
          <h2 id="email-sign-in" className="sign-label text-ink-2">
            Have a work email? Sign in with a code
          </h2>
          <div className="plate p-5">
            <LoginForm next={safeNext(next)} initialError={loginErrorMessage(typeof error === 'string' ? error : null)} />
          </div>
        </section>

        <p className="mt-6 flex gap-2.5 text-[15px] font-medium text-ink-2">
          <Icon icon={LifeBuoy} size="s" className="mt-0.5 text-ink" />
          <span>Trouble signing in? Ask the owner to add you to the team, or to reset your PIN.</span>
        </p>
      </div>
    </main>
  );
}
