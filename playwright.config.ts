import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, IS_CI } from './config/env';

/**
 * Root Playwright configuration (AXI-1261 scaffold).
 *
 * Shared, single-source config: stories add spec files under `tests/<EPIC-KEY>/`
 * and never fork this file (NFR11). Later stories extend it in place —
 * environment targeting (AXI-1262), a fail-closed preflight `globalSetup`
 * (AXI-1263), the auth `setup` project (AXI-1264), and the artifact/report
 * policy (AXI-1268) — each marked below.
 */
export default defineConfig({
  testDir: './tests',
  // Fail-closed preflight (AXI-1263): verifies front-end/API reachability and the
  // seed baseline before any test; aborts with the reserved infra-fault code (FR9/FR10).
  globalSetup: './preflight/global-setup.ts',
  // One folder per epic (tests/<EPIC-KEY>/); path filter runs full suite, a single
  // epic, or a single story with no config change (AC2, FR4).
  fullyParallel: true,
  forbidOnly: IS_CI,
  // Retry policy: capped at one in CI, zero locally, so a retry-pass stays visible
  // rather than hidden (FR40, formalized by AXI-1268).
  retries: IS_CI ? 1 : 0,
  workers: undefined,
  // Reporters: list for the console, JUnit XML for the CI gate, HTML for humans
  // (baseline here; artifact retention detailed by AXI-1268 / FR26-FR27).
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    // Debug artifacts on failure/first-retry (baseline; AXI-1268 owns FR26).
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
