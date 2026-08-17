import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, IS_CI } from './config/env';
import { storageStateFor } from './config/roles';

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
  // Reporters (FR27): list for the console, JUnit XML for the CI gate, HTML for
  // humans. Both JUnit and HTML are emitted on every run and published as CI
  // artifacts (AXI-1267 upload step); retained 90 days as qualification evidence
  // for the release line (NFR9).
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    // A trace, screenshot, and video are retained for every FAILING test — kept
    // on failure regardless of retry, so a first-and-only failure still has full
    // artifacts (FR26/AC14). Passing tests keep nothing (cost).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // Auth setup project (AXI-1264): authenticates each role once and persists a
    // storageState the test project consumes (FR12).
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Default to the admin role; a spec needing another role overrides with
        // `test.use({ storageState: storageStateFor('user') })`, and one testing
        // the login flow itself opts out with an empty storageState.
        storageState: storageStateFor('admin'),
      },
      dependencies: ['setup'],
      testIgnore: /.*\.setup\.ts/,
    },
  ],
});
