import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one Postgres database; run files serially.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
