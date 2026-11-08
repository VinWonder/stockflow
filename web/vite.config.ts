import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Django runs on :8000. In development Vite forwards /api and /admin to it, so the app and API share one address.
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
      manifest: {
        name: 'StockFlow — Hardware Stock Control',
        short_name: 'StockFlow',
        description: 'Godown and shop stock: deliveries, transfers, sales, approvals and stock commands by SMS/WhatsApp.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#F3F5F9',
        theme_color: '#1F3A5F',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Sell', url: '/sell', icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }] },
          { name: 'Receive delivery', url: '/receive', icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }] },
          { name: 'Inbox', url: '/inbox', icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // The app shell works offline; API data always comes from the server.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/admin/, /^\/static\//, /^\/media\//],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: { cacheName: 'fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
    }),
  ],
  server: {
    host: true, // phones on the same Wi-Fi can open http://<your-PC-IP>:5173
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/admin': { target: backend, changeOrigin: true },
      '/static': { target: backend, changeOrigin: true },
      '/media': { target: backend, changeOrigin: true },
    },
  },
  preview: { host: true },
});
