import type { Metadata, Viewport } from 'next';
import './globals.css';
import { fontVariables } from './fonts';
import { ThemeRestore } from '@/components/daymark/Theme';
import { ToastProvider } from '@/components/daymark/Toast';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { THEME_COLORS, THEME_INIT_SCRIPT } from '@/lib/theme';

export const metadata: Metadata = {
  title: { default: 'Koala Estimator', template: '%s · Koala Estimator' },
  description: 'Insulation estimates and quotes',
  applicationName: 'Koala Estimator',
  appleWebApp: { capable: true, title: 'Koala Estimator', statusBarStyle: 'default' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  // The page canvas per theme; the theme switcher updates these when a theme is chosen by hand.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: THEME_COLORS.night },
    { media: '(prefers-color-scheme: light)', color: THEME_COLORS.day },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is set before first paint by the script below, so React must not complain that
    // the server sent <html> without it.
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <ToastProvider>{children}</ToastProvider>
        <ServiceWorkerRegistrar />
        <ThemeRestore />
      </body>
    </html>
  );
}
