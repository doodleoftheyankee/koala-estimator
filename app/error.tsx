'use client';
// Anything that fails outside a section with its own error page: branded, in plain words, with
// Try again and a way to the start page. (Section error pages keep the app menu around them.)
import { ErrorState, useRetry } from '@/components/shell/StatePages';

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const retry = useRetry(reset);
  return <ErrorState error={error} retry={retry} home={{ href: '/', label: 'Go to the start page' }} />;
}
