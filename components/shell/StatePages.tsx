'use client';
// Branded "not found" and "something went wrong" pages, in Daymark, always with a way on.
//
//   <NotFoundState title="We can't find that job" hint="…" primary={{ href: '/jobs', label: 'Go to Jobs' }} />
//   <ErrorState error={error} reset={reset} />          inside error.tsx files
//
// Errors say what happened in plain words and what to do; a technical reference is shown small,
// for whoever helps. With no signal they say so, and that field work stays saved on the phone.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startTransition, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { hasSavedCopy } from '@/lib/offline/phoneCopy';
import { buttonClass, Button } from '../daymark/Button';
import { cx } from '../daymark/cx';
import { ArrowLeft, CloudOff, Compass, Icon, Lock, RefreshCw, TriangleAlert, type LucideIcon } from '../daymark/icons';

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}
function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/** Can the browser go back to a page of this app? */
function useCanGoBack(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.history.length > 1 && document.referrer.startsWith(window.location.origin),
    () => false,
  );
}

function StatePage({ icon, label, title, children, actions, className }: { icon: LucideIcon; label: string; title: ReactNode; children?: ReactNode; actions: ReactNode; className?: string }) {
  return (
    <main className={cx('mx-auto flex min-h-[70dvh] w-full max-w-xl flex-col justify-center gap-4 px-4 py-10', className)}>
      <span className="text-ink">
        <Icon icon={icon} size="xl" />
      </span>
      <p className="sign-label text-ink-2">{label}</p>
      <h1 className="text-[30px] leading-[1.07] font-extrabold tracking-[-0.02em] text-ink">{title}</h1>
      {children ? <div className="space-y-2 text-[17px] font-medium text-ink-2">{children}</div> : null}
      <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{actions}</div>
    </main>
  );
}

function BackButton() {
  const canGoBack = useCanGoBack();
  if (!canGoBack) return null;
  return (
    <Button variant="secondary" icon={ArrowLeft} onClick={() => window.history.back()}>
      Go back
    </Button>
  );
}

export function NotFoundState({
  title = 'We can’t find that page',
  hint = 'The link may be old or mistyped. Nothing you saved is lost.',
  primary,
  secondary,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  /** The way on, named by where it goes: { href: '/jobs', label: 'Go to Jobs' }. */
  primary?: { href: string; label: string };
  /** A quieter second way on (a text link). */
  secondary?: { href: string; label: string };
}) {
  return (
    <StatePage
      icon={Compass}
      label="Page not found"
      title={title}
      actions={
        <>
          {primary ? (
            <Link href={primary.href} prefetch={false} className={buttonClass({ variant: 'main' })}>
              {primary.label}
            </Link>
          ) : null}
          <BackButton />
          {secondary ? (
            <Link href={secondary.href} prefetch={false} className={buttonClass({ variant: 'ghost' })}>
              {secondary.label}
            </Link>
          ) : null}
        </>
      }
    >
      <p>{hint}</p>
    </StatePage>
  );
}

/**
 * A page the signed-in role cannot use (lib/server/auth.ts requireRole sends people here instead
 * of quietly to their home page): says whose page it is and offers the way home.
 */
export function NoAccessState({ title, hint, primary }: { title: ReactNode; hint: ReactNode; primary: { href: string; label: string } }) {
  return (
    <StatePage
      icon={Lock}
      label="Not in your menu"
      title={title}
      actions={
        <>
          <Link href={primary.href} prefetch={false} className={buttonClass({ variant: 'main' })}>
            {primary.label}
          </Link>
          <BackButton />
        </>
      }
    >
      <p>{hint}</p>
    </StatePage>
  );
}

/** "Try again" for an error.tsx boundary: renders the server parts again, then the page. */
export function useRetry(reset: () => void): () => void {
  const router = useRouter();
  return () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
}

/**
 * The body of an error.tsx boundary. `home` adds a link out (the root boundaries have no menu
 * around them); section boundaries sit inside the app shell, so the menu is the way on.
 */
export function ErrorState({
  error,
  retry,
  home,
  savedOnPhone = false,
}: {
  error: Error & { digest?: string };
  /** What "Try again" does: useRetry(reset) in an error.tsx; a reload in global-error. */
  retry: () => void;
  home?: { href: string; label: string };
  /** The field and crew apps keep work on the phone: say so. */
  savedOnPhone?: boolean;
}) {
  const online = useOnline();
  return (
    <StatePage
      icon={online ? TriangleAlert : CloudOff}
      label={online ? 'Something went wrong' : 'No connection'}
      title={online ? 'This page didn’t load' : 'Can’t reach Koala Estimator right now'}
      actions={
        <>
          <Button variant="main" icon={RefreshCw} onClick={retry}>
            Try again
          </Button>
          {home ? (
            <a href={home.href} className={buttonClass({ variant: 'secondary' })}>
              {home.label}
            </a>
          ) : null}
        </>
      }
    >
      <p>{online ? 'Try again. If it keeps happening, tell the office what you were doing.' : 'Check your signal, then try again.'}</p>
      {savedOnPhone || !online ? <p>Work you entered in the field or crew app is saved on this phone.</p> : null}
      {error.digest ? <p className="text-[15px] text-ink-3">Reference for support: {error.digest}</p> : null}
    </StatePage>
  );
}

/**
 * Koala's database or sign-in service did not answer (L36, RF-04): not a sign-out. Says so, keeps
 * the way back to the page (a same-site path), and offers the phone's own copy of the field or crew
 * app, which opens without Koala. Reads no data, so it works while the database is down.
 */
/**
 * The phone's own copy of the app, offered only once the browser is known to hold it (review B
 * flow-B8). With none (first use, cleared site data), the link would lead back here, so the page
 * says so instead. Nothing shows until the check is done.
 */
/** quiet: say nothing when the phone has no saved copy (an app offered only as another way on). */
function PhoneAppLink({ href, copy: shell, label, quiet = false }: { href: string; copy?: string; label: string; quiet?: boolean }) {
  const [copy, setCopy] = useState<{ href: string; saved: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    void hasSavedCopy(shell ?? href).then((saved) => {
      if (live) setCopy({ href, saved });
    });
    return () => {
      live = false;
    };
  }, [href, shell]);
  if (copy?.href !== href) return null;
  if (!copy.saved) return quiet ? null : <p className="text-[17px] font-medium text-ink-2">This phone has no saved copy of the app yet; it needs Koala once.</p>;
  return (
    <a href={href} className={buttonClass({ variant: 'secondary' })}>
      {label}
    </a>
  );
}

type PhoneAppOffer = { href: string; copy?: string; label: string };

/**
 * /unreachable: Try again, the phone's copy of the app being opened, and for any other page
 * (fallbacks, lib/offline/phoneCopy.ts fallbackAppsFor) the apps this phone has saved, plus Go back:
 * in the home-screen app there is no browser back button (release review C FLOW-4).
 */
export function UnreachableState({ next, phoneApp, fallbacks = [] }: { next: string; phoneApp: PhoneAppOffer | null; fallbacks?: readonly PhoneAppOffer[] }) {
  return (
    <StatePage
      icon={CloudOff}
      label="Can’t reach Koala"
      title="Can’t reach Koala right now"
      actions={
        <>
          <a href={next} className={buttonClass({ variant: 'main' })}>
            <Icon icon={RefreshCw} size="s" />
            Try again
          </a>
          {phoneApp ? <PhoneAppLink href={phoneApp.href} copy={phoneApp.copy} label={phoneApp.label} /> : null}
          {fallbacks.map((app) => (
            <PhoneAppLink key={app.href} href={app.href} copy={app.copy} label={app.label} quiet />
          ))}
          <BackButton />
        </>
      }
    >
      <p>Koala is not answering. You are not signed out, and you do not need to sign in again.</p>
      <p>Work in the field or crew app is saved on your phone and syncs when Koala is back. Try again in a minute.</p>
    </StatePage>
  );
}
