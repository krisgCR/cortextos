import { defineConfig } from '@playwright/test';

/**
 * Dedicated config for the deterministic two-layer E2E GATE.
 * Separate from playwright.config.ts so `npm run test:e2e-gate` runs ONLY the
 * gate spec. Boot/teardown/sentinel live in the spec's own beforeAll/afterAll
 * hooks (the repo is ESM "type":"module", which Playwright's custom-reporter /
 * globalSetup .ts loader does not handle — the test-file loader does).
 */
export default defineConfig({
  testDir: './tests/playwright',
  testMatch: /e2e-gate\.spec\.ts$/,
  timeout: 240_000, // webpack cold compile of the dashboard can be slow
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
});
