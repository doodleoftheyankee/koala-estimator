'use client';
// Last resort: the root layout itself failed. It replaces the whole document, so it brings its
// own <html>, the Daymark styles, fonts and theme. Try again reloads the page.
import './globals.css';
import { fontVariables } from './fonts';
import { ThemeInitScript, ThemeRestore } from '@/components/daymark/ThemeRestore';
import { ErrorState } from '@/components/shell/StatePages';

export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <title>Something went wrong · Koala Estimator</title>
        <ThemeInitScript />
      </head>
      <body className="min-h-dvh antialiased">
        <ErrorState error={error} retry={() => window.location.reload()} home={{ href: '/', label: 'Go to the start page' }} />
        <ThemeRestore />
      </body>
    </html>
  );
}
