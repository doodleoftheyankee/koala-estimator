'use client';

// The quote could not be loaded (the server or database failed). The layout above still draws the
// franchise header with its Call button when it could read the branding. One action: try again.
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/daymark/Button';
import { CloudOff, RefreshCw, TriangleAlert } from '@/components/daymark/icons';
import { useRetry } from '@/components/shell/StatePages';
import { ClosedState } from './parts';

function subscribe(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export default function QuoteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const retry = useRetry(reset);
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  return (
    <ClosedState
      icon={online ? TriangleAlert : CloudOff}
      tone="warn"
      title={online ? 'Your quote didn’t load' : 'No connection'}
      action={
        <Button variant="main" size="lg" icon={RefreshCw} onClick={retry}>
          Try again
        </Button>
      }
    >
      <p>{online ? 'Something went wrong on our side. Nothing has changed with your quote. Please try again in a moment.' : 'Check your signal or Wi-Fi, then try again.'}</p>
      <p>If it keeps happening, contact the person who sent you this link.</p>
      {error.digest ? <p className="text-[15px] text-ink-3">Reference for support: {error.digest}</p> : null}
    </ClosedState>
  );
}
