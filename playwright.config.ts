import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, IS_CI } from './config/env';
import { storageStateFor } from './config/roles';

// A spec file both the 'shadow-run-api' and 'chromium' projects must never
// both pick up (AXI-1831) — declared once and reused by both projects'
// testMatch/testIgnore so they can never silently drift apart.
const SHADOW_RUN_SPEC = /AXI-1462\/AXI-1614-compiled-planner-shadow-run\.spec\.ts$/;

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
  // Baseline timeout (AXI-1782). This governs TESTS that do not set their own, and —
  // the reason it is here — every `beforeAll`/`afterAll` HOOK in the suite:
  // `test.describe.configure({ timeout })` applies to tests only, never to hooks, so
  // before this line every AXI-1717 seeding hook ran on the Playwright default of 30s
  // while the tests it seeded were given 300s–420s. A hook that instantiates a plan and
  // waits on real backend runs cannot finish in 30s under load, which surfaced as hook
  // timeouts that moved between describe blocks from run to run. Per-describe overrides
  // still govern individual test budgets; this only raises the floor (NFR11: extend this
  // file in place, never fork it).
  timeout: 120_000,
  // Retry policy: capped at one in CI, zero locally, so a retry-pass stays visible
  // rather than hidden (FR40, formalized by AXI-1268).
  retries: IS_CI ? 1 : 0,
  workers: undefined,
  // Reporters (FR27): list for the console, JUnit XML for the CI gate, HTML for
  // humans. Both JUnit and HTML are emitted on every run and published as CI
  // artifacts (AXI-1267 upload step); retained 90 days as qualification evidence
  // for the release line (NFR9). JSON carries the per-test step detail (incl.
  // `page.goto` navigations) that `epic-acceptance.ts` reads to build the
  // Feature/Description/Deeplink table in the acceptance report.
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
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
      testIgnore: [/.*\.setup\.ts/, SHADOW_RUN_SPEC],
    },
    // AXI-1831 — the shadow-run spec is API-only (admin token via
    // `apiRequest.newContext()`, never a `page`/browser `context`): it has no
    // UI interaction and therefore no business depending on the `setup`
    // project's persisted `storageState`. Left under the `chromium` project,
    // `apiRequest.newContext()` (the bare `request` import from
    // `@playwright/test`, not a fixture) still inherits the ACTIVE project's
    // `use` config as its defaults, including `storageState` — so running
    // `--no-deps` (needed so `setup` doesn't hit the front-end/API the
    // shadow-run spec doesn't use) skipped the login that would have written
    // `.auth/admin.json`, and the inherited `storageState` path pointed at a
    // file that was never created: `ENOENT .auth/admin.json`, before any API
    // call. A dedicated project with no `storageState` and no `dependencies`
    // removes the inheritance entirely; the spec already does its own admin
    // login over the API (`createAdminShadowRunAuth`), so it needs nothing
    // from the `setup` project. `npx playwright test <shadow-run-spec>
    // --no-deps` now runs cleanly.
    {
      name: 'shadow-run-api',
      testMatch: SHADOW_RUN_SPEC,
    },
  ],
});
