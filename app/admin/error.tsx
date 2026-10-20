'use client';
// Error boundary for the admin pages: a failed save (lost signal, server error) shows a retry
// instead of a blank screen. Nothing is lost; forms re-render with their last saved values.
import { Alert, Button } from '@/components/ui';

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <Alert tone="red">
        <p className="font-semibold">Something went wrong loading or saving this page.</p>
        <p className="mt-1 text-sm">{navigatorOffline() ? 'You appear to be offline. Reconnect and try again.' : 'Try again. If it keeps happening, tell the owner.'}</p>
        {error.digest ? <p className="mt-1 text-xs text-red-700">Reference: {error.digest}</p> : null}
      </Alert>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}

function navigatorOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
