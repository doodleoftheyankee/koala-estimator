'use client';
// Last resort: the root layout itself failed. It replaces the whole document, so it brings its
// own <html>, the Daymark styles, fonts and theme. Try again reloads the page.
import './globals.css';
import { fontVariables } from './fonts';
import { ThemeRestore } from '@/components/daymark/Theme';
import { ErrorState } from '@/components/shell/StatePages';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <title>Something went wrong · Koala Estimator</title>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <ErrorState error={error} retry={() => window.location.reload()} home={{ href: '/', label: 'Go to the start page' }} />
        <ThemeRestore />
      </body>
    </html>
  );
}
