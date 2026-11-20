import type { MetadataRoute } from 'next';
import { THEME_COLORS } from '@/lib/theme';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Koala Insulation Estimator',
    short_name: 'Koala Est.',
    description: 'Field estimates and quotes for insulation',
    start_url: '/field',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // Daymark chalk canvas; the product look, never a franchise colour.
    background_color: THEME_COLORS.day,
    theme_color: THEME_COLORS.day,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
