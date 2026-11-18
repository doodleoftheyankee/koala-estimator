'use client';
// A failure on this page (lost signal, server error) shows a plain message and Try again, inside
// the app menu, instead of a blank screen.
import { ErrorState, useRetry } from '@/components/shell/StatePages';

export default function SectionError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const retry = useRetry(reset);
  return <ErrorState error={error} retry={retry} savedOnPhone />;
}
