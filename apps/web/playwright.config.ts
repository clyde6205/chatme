import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the production build (vite preview + service worker)
 * against the real API and a real Postgres database (E2E_DATABASE_URL).
 */
const API_PORT = 8090;
const WEB_PORT = 4173;
const dbUrl = process.env.E2E_DATABASE_URL ?? 'postgres://chatme:chatme@localhost:5432/chatme_e2e';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [
    // Representative entry-level Android viewport; network/CPU throttling is applied per test.
    { name: 'android-low', use: { ...devices['Pixel 5'], viewport: { width: 360, height: 640 } } },
  ],
  webServer: [
    {
      command: `pnpm --filter @chatme/api migrate && pnpm --filter @chatme/api exec tsx src/server.ts`,
      url: `http://localhost:${API_PORT}/health/ready`,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: dbUrl,
        PORT: String(API_PORT),
        WEB_ORIGINS: `http://localhost:${WEB_PORT}`,
        LOG_LEVEL: 'warn',
        RATE_LIMIT_AUTH_PER_MIN: '1000',
      },
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      timeout: 60_000,
    },
  ],
});
