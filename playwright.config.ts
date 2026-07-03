import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  // The E2E gate boots its own isolated daemon+dashboard instance and runs ONLY
  // under playwright.e2e-gate.config.ts. Exclude it here so a plain
  // `npm run test:playwright` does not double-boot and collide on port/instance.
  testIgnore: /e2e-gate\.spec\.ts$/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:39182',
  },
  // Register tsx so we can import .ts source files
  globalSetup: undefined,
});
