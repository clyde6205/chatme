import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered from src/lib/sw.ts after first render, off the critical path
      manifest: {
        name: 'CHATme',
        short_name: 'CHATme',
        description: 'Work. Play. Stay Connected. Global with CHATme.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b1020',
        theme_color: '#5b5bf7',
        icons: [
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell + every locale chunk is precached so CHATme opens offline in any language.
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // API responses are never cached by the service worker; the app owns its offline data.
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:8080', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  preview: {
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:8080', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    manifest: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
