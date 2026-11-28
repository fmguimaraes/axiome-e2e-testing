import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, IS_CI } from './config/env';
import { storageStateFor } from './config/roles';

// A spec file both the 'shadow-run-api' and 'chromium' projects must never
// both pick up (AXI-1831) — declared once and reused by both projects'
// testMatch/testIgnore so they can never silently drift apart.
const SHADOW_RUN_SPEC = /AXI-1462\/AXI-1614-compiled-planner-shadow-run\.spec\.ts$/;

// AXI-2065 — same AXI-1831 shape: a read-only API-only spec against the
// demo stack's own seeded Microbiote project (its own admin login over the
// API, never the fixture-org `setup` project's storageState). Excluded from
// 'chromium' so the shared `setup` project (which authenticates against the
// FIXTURE org, not the demo stack) is never a dependency for it. AXI-2244's
// heatmap-dataset spec is the SAME shape (same project, same own-login),
// so it joins the same pattern/project rather than forking a third one.
// AXI-2262 joins the same pattern (own admin login over the API, no `page`/
// browser `context`, no business depending on the `setup` project's
// storageState) — same reasoning as AXI-2243/AXI-2244/AXI-2065 above, just a
// different epic folder (AXI-2073). AXI-2248 is the SAME shape again (own
// admin login over the API via `apiRequest.newContext()`, renders through
// `/exports/render-charts` directly, no browser page).
// AXI-2084 joins the same pattern: own admin login over the API, no `page`,
// no dependency on the fixture-org `setup` project's storageState — it races
// two finalizes against the demo stack's own seeded Microbiote workspace.
const EVIDENCE_API_SPEC =
  /AXI-2060\/(AXI-2065-evidence-and-charts|AXI-2244-heatmap-dataset|AXI-2243-pairwise-pvalue-brackets|AXI-2248-pdf-export-display-params|AXI-2084-deferred-auto-ingestion)\.spec\.ts$|AXI-2073\/AXI-2262-chart-export-title-fallback\.spec\.ts$/;

// AXI-2315 — same AXI-1831 shape again: a fresh account is self-registered
// per test (never the fixture-org `setup` project's storageState, and no
// `page`/browser context at all — `request.newContext()` only).
const AUTH_SUITE_SPEC = /AXI-2309\/AXI-2315-auth-suite\.spec\.ts$/;

// AXI-2410 (epic AXI-2414) — same AXI-1831 shape again: own admin login over the
// API via `adminApi()`/`apiRequest.newContext()`, no `page`/browser `context`, so
// it has no business depending on the fixture-org `setup` project's persisted
// storageState. Without its own project it inherited 'chromium's storageState
// path and failed `ENOENT .auth/admin.json` before any API call (the same
// AXI-1831 failure mode) whenever run with `--no-deps` to skip `setup`.
const AXI_2410_SPEC = /AXI-2414\/AXI-2410-column-level-display-labels\.spec\.ts$/;

// AXI-2424 (epic AXI-2422) — same AXI-1831 shape again: the Registry v0 specs (AXI-2423 read
// routes, AXI-2424 recipe-variant endpoint) are API-only, each role logging in over the API
// (`tests/AXI-2422/harness/registry-api.ts`), no `page`/browser `context`, no `setup`
// storageState dependency.
const AXI_2422_REGISTRY_SPEC = /AXI-2422\/AXI-242[34]-[^/]+\.spec\.ts$/;

// AXI-2549 (epic AXI-2540) — same AXI-1831 shape again: own admin login over the
// API (plus `PrivateProjectsWorld`'s own self-registered actors for §5.3), no
// `page`/browser `context`, no `setup` storageState dependency.
const AXI_2549_SPEC = /AXI-2540\/AXI-2549-ingestion-watchdog-retry\.spec\.ts$/;

// AXI-2318 — the prod E2E daily suite and its infra verification spec: API-only
// (the harness's own fetch client, never a `page`), no `setup` storageState
// dependency, and NO trace/video/screenshot — a trace records the test user's
// bearer token (NFR6) and the daily run happens against production. The daily
// workflow runs only the daily spec, via `--project=prod-suite-api`.
// AXI-2319 — its pass-rule stand-in verification spec runs in the same project.
const PROD_SUITE_SPEC = /AXI-2309\/(AXI-2318-prod-(daily-suite|suite-infra)|AXI-2319-prod-pass-rule)\.spec\.ts$/;

// AXI-2601 (epic AXI-2598) — the investigator handover suite: API-only (its own fetch
// client, signs in as the `investigator` role of config/roles.ts), no `setup` storageState
// dependency, and NO trace/video/screenshot (FR7, NFR4 — a trace would record the bearer token).
// Run via `--project=handover-api` (tests/AXI-2598/harness/run-local.sh).
// AXI-2612 widened this from an AXI-2601-only pattern: any spec built on the SAME
// `harness/rehearsal.ts` + `harness/world.ts` harness (own fetch client, investigator sign-in,
// no `setup` storageState, no trace) needs this project too, or it falls into `chromium` with
// `setup` as a dependency and `trace: 'retain-on-failure'` — the exact NFR4 violation this spec
// exists to prevent. NOT every tests/AXI-2598/* spec qualifies: AXI-2595/AXI-2596/AXI-2613-* use
// their own, unrelated harnesses and are correctly left on `chromium`. Keep this pattern in sync
// with which specs actually `import ... from './harness/rehearsal'` (or `./harness/world`), not
// with the epic folder alone.
// AXI-2663: the MAG4 API reproduction is built on the same harness and must never record a trace.
const HANDOVER_SPEC = /(AXI-2598\/AXI-26(01|12)|AXI-2630\/AXI-2663)-[^/]+\.spec\.ts$/;

// AXI-2647 (epic AXI-2630) — same AXI-1831 shape, widened: its own two API logins
// (admin + investigator, via `apiRequest.newContext()`) for every API-only test, PLUS
// one real browser `page` for the AC3 custom-chart flow, signed in via the same
// localStorage-seeding pattern AXI-2060's specs use (`signInBrowser`) — never the
// fixture-org `setup` project's storageState (the spec logs in against w5val, not the
// fixture org `setup` authenticates against). Needs its own project either way, or the
// `page` test would inherit `chromium`'s `setup` dependency and its storageState path
// for nothing this spec uses (the AXI-1831 failure mode once more).
const AXI_2647_SPEC = /AXI-2630\/AXI-2647-adr002-acceptance\.spec\.ts$/;

// AXI-2659 (epic AXI-2630) — plan-to-four-images rehearsal: real browser `page`
// throughout, own investigator/provisioner login via `signInBrowser`/API tokens,
// never the fixture-org `setup` project's storageState (same shape as AXI_2647_SPEC).
const AXI_2659_SPEC = /AXI-2630\/AXI-2659-plan-to-four-images\.spec\.ts$/;

// AXI-2680 (epic AXI-2679) — save as workflow: real browser `page` plus own API logins (the
// admin, and a self-registered workspace Viewer), never the fixture-org `setup` storageState
// (same shape as AXI_2647_SPEC). It WRITES a template, so it runs against an isolated stack.
const AXI_2680_SPEC = /AXI-2679\/AXI-2680-save-as-workflow\.spec\.ts$/;

// AXI-2704 (epic AXI-2679, bug fix) — the result page of a saved-workflow run: real browser
// `page` plus an API login for the API-level assertion, never the fixture-org `setup`
// storageState (same shape as AXI_2680_SPEC). Runs against an isolated stack carrying the
// AXI-2680 reference workflow and its pinned SAP-question run.
const AXI_2704_SPEC = /AXI-2679\/AXI-2704-result-page-workflow\.spec\.ts$/;

// AXI-2705 (epic AXI-2679, bug fix) — a stratified Dunn run's per-reference summary/evidence:
// real browser `page` plus an API login for the API-level assertions, same shape as
// AXI_2704_SPEC. Runs against an isolated stack carrying the AXI-2712-fixed Dunn-only replay run.
const AXI_2705_SPEC = /AXI-2679\/AXI-2705-stratified-result\.spec\.ts$/;

// AXI-1051 (Workflow 5) — poster removal epic spec: API-only, signs itself in, no storageState.
const AXI_1051_EPIC_SPEC = /AXI-1051\/epic-poster-removal\.spec\.ts$/;

// AXI-2734 (epic AXI-2733, area S1) — user-creation / department-user authority: API-only,
// its own logins (a seeded client admin, users it creates, a freshly self-registered stranger),
// never the fixture-org `setup` storageState (the AXI-1831 shape).
const AXI_2734_SPEC = /AXI-2733\/AXI-2734-user-create-authz\.spec\.ts$/;

// AXI-2803 (epic AXI-2802) — API-only A/B over two gateways (own admin login, no `page`, no
// `setup` storageState dependency) — same AXI-1831 shape.
const AXI_2803_SPEC = /AXI-2802\/AXI-2803-profile-identity\.spec\.ts$/;
// AXI-2804 (epic AXI-2802) — API-only A/B: the branch sidecar (profiles from a THROWAWAY database)
// against `main` (profiles from the files); seed CLI + read-only SQL on the throwaway DB only.
const AXI_2804_SPEC = /AXI-2802\/AXI-2804-profile-db-store\.spec\.ts$/;
// AXI-2805 (epic AXI-2802) — API-only A/B: the branch sidecar on a THROWAWAY organization + user
// database against `main`; SQL writes on the throwaway DB only (own admin login, no `setup` state).
const AXI_2805_SPEC = /AXI-2802\/AXI-2805-profile-scope-access\.spec\.ts$/;
// AXI-2806 (epic AXI-2802) — API-only A/B: the branch sidecar on a THROWAWAY organization + user
// database (the migration under test is its cutover) against `main`; SQL on the throwaway DB only.
const AXI_2806_SPEC = /AXI-2802\/AXI-2806-compose-profiles\.spec\.ts$/;
// AXI-2809 (epic AXI-2802, A7) — real browser against a WORKTREE front-end (own Vite,
// 5174+, never the shared :5173 demo), signs itself in as admin@cro-one.com; the demo
// gateway (:3000, already carries AXI-2806 on main) is the API. Run with
// `BASE_URL=http://localhost:5174 npx playwright test --project=axi-2809-profile-pickers`.
const AXI_2809_SPEC = /AXI-2802\/AXI-2809-profile-pickers\.spec\.ts$/;
// AXI-2807 (epic AXI-2802) — API-only A/B: the branch sidecar on a THROWAWAY organization + user
// database, with its own canonical-file directory (E2E_2807_SEED_DIR); SQL on the throwaway DB only.
const AXI_2807_SPEC = /AXI-2802\/AXI-2807-profile-versions\.spec\.ts$/;
// AXI-2813 (epic AXI-2802, A4b) — API-only A/B: the branch sidecar on a THROWAWAY organization +
// user database against `main`; create refuses the legacy `semanticProfileId` field outright.
const AXI_2813_SPEC = /AXI-2802\/AXI-2813-create-profile-list-only\.spec\.ts$/;
// AXI-2810 (epic AXI-2802, A8) — the semantic profile CRUD page in a real browser: a WORKTREE
// front-end (own Vite, 5174+) on the branch's backend sidecar (own RabbitMQ vhost) over a THROWAWAY
// organization + user database; SQL on that database only. Run with
// `BASE_URL=http://localhost:5176 API_BASE_URL=http://localhost:3016 npx playwright test --project=axi-2810-profile-crud-page`.
const AXI_2810_SPEC = /AXI-2802\/AXI-2810-profile-crud-page\.spec\.ts$/;

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
      testIgnore: [/.*\.setup\.ts/, SHADOW_RUN_SPEC, EVIDENCE_API_SPEC, AUTH_SUITE_SPEC, PROD_SUITE_SPEC, AXI_2410_SPEC, AXI_2422_REGISTRY_SPEC, AXI_2549_SPEC, HANDOVER_SPEC, AXI_2647_SPEC, AXI_2659_SPEC, AXI_2680_SPEC, AXI_2704_SPEC, AXI_2705_SPEC, AXI_1051_EPIC_SPEC, AXI_2734_SPEC, AXI_2803_SPEC, AXI_2804_SPEC, AXI_2805_SPEC, AXI_2806_SPEC, AXI_2809_SPEC, AXI_2807_SPEC, AXI_2813_SPEC, AXI_2810_SPEC],
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
    // AXI-2065 (same AXI-1831 reasoning): read-only, demo-stack-only API spec.
    {
      name: 'evidence-api',
      testMatch: EVIDENCE_API_SPEC,
    },
    // AXI-2315 — API-only auth suite, no browser/storageState dependency.
    {
      name: 'auth-api',
      testMatch: AUTH_SUITE_SPEC,
    },
    // AXI-2318 — prod E2E daily suite + its infra verification (see PROD_SUITE_SPEC).
    {
      name: 'prod-suite-api',
      testMatch: PROD_SUITE_SPEC,
      use: { trace: 'off', video: 'off', screenshot: 'off' },
    },
    // AXI-2410 (epic AXI-2414) — API-only, own admin login, no browser/storageState
    // dependency (see AXI_2410_SPEC above).
    {
      name: 'axi-2410-api',
      testMatch: AXI_2410_SPEC,
    },
    // AXI-2424 (epic AXI-2422) — API-only Registry v0 specs (see AXI_2422_REGISTRY_SPEC above).
    {
      name: 'axi-2422-registry-api',
      testMatch: AXI_2422_REGISTRY_SPEC,
    },
    // AXI-2549 (epic AXI-2540) — API-only ingestion watchdog/retry spec (see AXI_2549_SPEC above).
    {
      name: 'axi-2549-api',
      testMatch: AXI_2549_SPEC,
    },
    // AXI-2601 (epic AXI-2598) — handover suite, rehearsal mode (see HANDOVER_SPEC above).
    {
      name: 'handover-api',
      testMatch: HANDOVER_SPEC,
      use: { trace: 'off', video: 'off', screenshot: 'off' },
    },
    // AXI-2647 (epic AXI-2630) — ADR-002 acceptance tests: API-only mostly, plus one
    // real browser `page` for AC3 (see AXI_2647_SPEC above). No `setup` dependency,
    // no inherited storageState — the spec signs itself in, API and browser alike.
    {
      name: 'axi-2647-adr002',
      testMatch: AXI_2647_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    // AXI-2659 (epic AXI-2630) — plan-to-four-images rehearsal (see AXI_2659_SPEC above).
    // No `setup` dependency, no inherited storageState — the spec signs itself in.
    {
      name: 'axi-2659-plan-to-four-images',
      testMatch: AXI_2659_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    // AXI-2680 (epic AXI-2679) — save as workflow (see AXI_2680_SPEC above). Signs itself in.
    {
      name: 'axi-2680-save-as-workflow',
      testMatch: AXI_2680_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    // AXI-2704 (epic AXI-2679, bug fix) — result page names/draws the saved workflow (see
    // AXI_2704_SPEC above). Signs itself in.
    {
      name: 'axi-2704-result-page-workflow',
      testMatch: AXI_2704_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    // AXI-2705 (epic AXI-2679, bug fix) — per-stratum answer/evidence (see AXI_2705_SPEC
    // above). Signs itself in.
    {
      name: 'axi-2705-stratified-result',
      testMatch: AXI_2705_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    // AXI-1051 (Workflow 5) — poster removal epic spec (see AXI_1051_EPIC_SPEC above). API-only.
    {
      name: 'axi-1051-poster-removal',
      testMatch: AXI_1051_EPIC_SPEC,
    },
    // AXI-2734 (epic AXI-2733) — API-only authority spec (see AXI_2734_SPEC above).
    {
      name: 'axi-2734-user-create-authz',
      testMatch: AXI_2734_SPEC,
    },
    // AXI-2803 (epic AXI-2802) — API-only profile identity A/B (see AXI_2803_SPEC above).
    {
      name: 'axi-2803-profile-identity',
      testMatch: AXI_2803_SPEC,
    },
    // AXI-2804 (epic AXI-2802) — database profile store A/B (see AXI_2804_SPEC above).
    {
      name: 'axi-2804-profile-db-store',
      testMatch: AXI_2804_SPEC,
    },
    // AXI-2805 (epic AXI-2802) — profile scope, organization access and permissions A/B (see AXI_2805_SPEC above).
    {
      name: 'axi-2805-profile-scope-access',
      testMatch: AXI_2805_SPEC,
    },
    // AXI-2806 (epic AXI-2802) — compose 1..N profiles per project A/B (see AXI_2806_SPEC above).
    {
      name: 'axi-2806-compose-profiles',
      testMatch: AXI_2806_SPEC,
    },
    // AXI-2813 (epic AXI-2802, A4b) — create refuses the legacy field A/B (see AXI_2813_SPEC above).
    {
      name: 'axi-2813-create-profile-list-only',
      testMatch: AXI_2813_SPEC,
    },
    // AXI-2809 (epic AXI-2802, A7) — multi-select profile pickers, real browser (see AXI_2809_SPEC above).
    {
      name: 'axi-2809-profile-pickers',
      testMatch: AXI_2809_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    // AXI-2807 (epic AXI-2802) — profile versions and re-match A/B (see AXI_2807_SPEC above).
    {
      name: 'axi-2807-profile-versions',
      testMatch: AXI_2807_SPEC,
    },
    // AXI-2810 (epic AXI-2802, A8) — semantic profile CRUD page, real browser (see AXI_2810_SPEC above).
    {
      name: 'axi-2810-profile-crud-page',
      testMatch: AXI_2810_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
