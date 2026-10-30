import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, chooseRadio, gotoSettled, press, seedScope, stubWizardRoutes, type WizardStubs } from './harness/new-analysis';
import { stubSapRead, type SapReadMode, type SapReadStub } from './harness/sap-read';

/**
 * AXI-2356 (epic AXI-2308 — FR17, FR19, FR21, FR22, FR48; owner rulings D20 Q11, Q12, Q13): the
 * New analysis wizard's follow-ups, driven in the browser on a real dataset against the real
 * opening-template routes (AXI-2339 `catalog` + `match`) and dataset/profile routes.
 *  - Q11: a failed project-SAP read (server error or network failure) is NOT "no SAP". Ready
 *    says "Could not read the statistical plan" with Retry, and Run stays disabled until the read
 *    answers. A SAP found by the Retry asks the plan question before Run; "no SAP" still labels
 *    the run exploratory.
 *  - Q12: the two-group template lists at most 20 pairs, with a type-to-filter box over ALL pairs,
 *    and above 12 group values it also offers the many-groups template (Kruskal–Wallis + Dunn).
 *  - Q13: the Investigator route `/investigator/new-analysis` behaves the same.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2356.2–.7.
 *
 * Stubbed in the browser, on purpose: AXI-2328's set (`harness/new-analysis.ts` — the suggestion,
 * the intent catalog, the idempotent semantic-declaration fill) and the SAP list read
 * (`harness/sap-read.ts`), which is switched mid-test between a 500, an aborted request, a held
 * (pending) read, "no SAP" and one SAP. Nothing here runs an analysis: Run is asserted enabled or disabled
 * and, while disabled, that no `POST /guided-analysis/wizard-runs` leaves the page.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv`. Its profile offers
 * `microbiote_igg4_cer_228` as a 24-level grouping column (276 pairs; the profiler types it a
 * timepoint, AXI-2339's noted defect) and `cluster_selon_acr_eular_2019` with 4 levels (6 pairs).
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2356 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2356-*`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const SEX_QUESTION = 'Does IgG4 differ by sex?';
const SEX_READ = answered(SEX_QUESTION, 'compare_groups', [
  ['outcome', 'igg4_g_l', 'IgG4'],
  ['groupingColumn', 'sexe', 'by sex'],
]);
const GROUPS_QUESTION = 'Does IgG4 differ between groups?';
const GROUPS_READ = answered(GROUPS_QUESTION, 'compare_groups');
const MANY = 'microbiote_igg4_cer_228';
const FEW = 'cluster_selon_acr_eular_2019';
const CAP = 20;
const SAP_ROW = { id: 'sap1', sapVersionId: 'sap-v1', version: 1, title: 'IgG4 SAP', supersededBy: null };
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2356-e2e-pw!';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

let api: Api;
let t: Tenant;
let datasetId: string;

interface Investigator {
  email: string;
  userId: string;
  accessToken: string;
  api: APIRequestContext;
}
let inv: Investigator;
let invScope: Tenant;
let invDatasetId: string;

interface Opened {
  sap: SapReadStub;
  /** The grouping candidates `match` served for this dataset (T1's row). */
  grouping: () => Promise<Array<{ column: string; levels: string[] }>>;
  launches: () => number;
}

/** Open the wizard on `path` with AXI-2328's stubs + the switchable SAP read. */
async function open(page: Page, path: string, sapMode: SapReadMode, stubs: WizardStubs = {}): Promise<Opened> {
  await stubWizardRoutes(page, stubs);
  const sap = await stubSapRead(page, sapMode);
  let launches = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(WIZARD_RUNS)) launches += 1;
  });
  const match = page.waitForResponse((r) => r.url().includes('/guided-analysis/opening-templates/match') && r.request().method() === 'POST', { timeout: 60_000 });
  await gotoSettled(page, path);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 30_000 });
  const grouping = async () => {
    const rows = (await (await match).json()) as Array<{ templateId: string; candidates: { grouping: Array<{ column: string; levels: string[] }> } }>;
    return rows.find((m) => m.templateId === 'T1')!.candidates.grouping;
  };
  return { sap, grouping, launches: () => launches };
}

const openTeam = (page: Page, sapMode: SapReadMode, stubs: WizardStubs = {}) =>
  seedScope(page, t).then(() => open(page, `/new-analysis?datasetId=${datasetId}`, sapMode, stubs));

/** Question → suggested intent → suggested T1 → Read → Ready, by the SEX_READ suggestion. */
async function reachReadyBySex(page: Page) {
  await askQuestion(page, SEX_QUESTION);
  await expect(page.getByTestId('na-choice-compare_groups')).toHaveAttribute('aria-checked', 'true');
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, 'na-choice-T1');
  await expect(page.getByTestId('na-step-read')).toBeVisible();
  await choose(page, 'na-read-confirm');
  await expect(page.getByTestId('na-step-ready')).toBeVisible();
}

/** Question → compare groups → T1 → "Which column…" = `column` → the pairs question. */
async function reachPairs(page: Page, column: string) {
  await askQuestion(page, GROUPS_QUESTION);
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, 'na-choice-T1');
  await expect(page.getByTestId('na-step-decide-groupingColumn')).toBeVisible();
  await chooseRadio(page, new RegExp(`^${column}\\b`));
  await expect(page.getByTestId('na-step-decide-groups')).toBeVisible();
}

const pairs = (page: Page) => page.getByRole('radiogroup', { name: 'Which two groups do you compare?' }).getByRole('radio');
const pairLabels = (page: Page) => pairs(page).evaluateAll((els) => els.map((e) => (e.querySelector('span.min-w-0 > span')?.textContent ?? '').trim()));

/** Every pair of a column's levels, as the wizard words them (no control level on these columns). */
function allPairs(levels: string[]): string[] {
  return levels.flatMap((a, i) => levels.slice(i + 1).map((b) => `${a} vs ${b}`));
}

/** The wizard's filter rule, restated for the expectation: every typed word, case-insensitive. */
function matching(labels: string[], query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return labels.filter((l) => terms.every((term) => l.toLowerCase().includes(term)));
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

async function expectRunBlocked(page: Page, block: 'sap-error' | 'sap-loading' | 'sap-unanswered') {
  await expect(page.getByTestId(`na-run-block-${block}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('na-run')).toBeDisabled();
}

async function expectRunOpen(page: Page) {
  await expect(page.locator('[data-testid^="na-run-block-"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('na-run')).toBeEnabled();
}

test.describe.serial('AXI-2356 wizard follow-ups — a failed SAP read blocks Run; pairs capped with a filter @SI-066 @SI-030', () => {
  test.beforeAll(async () => {
    test.setTimeout(420_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    await silenceTours(await adminToken());

    // Q13: an Investigator alone in a fresh workspace with one project (AXI-2323 auto-scopes him).
    const ws = await api.post('/api/v1/workspaces', { name: `AXI-2356 study ${RUN}`, description: 'AXI-2356 E2E fixture', type: 'internal', ownerOrganizationId: t.orgId });
    expect(ws.status, JSON.stringify(ws.body)).toBeLessThan(300);
    const headers = { 'X-Workspace-Id': ws.body.id };
    const project = await api.post('/api/v1/projects', { name: `AXI-2356 study ${RUN}`, workspaceId: ws.body.id }, headers);
    expect(project.status, JSON.stringify(project.body)).toBeLessThan(300);
    invScope = { orgId: t.orgId, workspaceId: ws.body.id, projectId: project.body.id, headers };
    invDatasetId = await ingestCsvFixture(api, invScope, FIXTURE);
    inv = await investigator(ws.body.id);
    await silenceTours(inv.accessToken);
  });

  test.afterAll(async () => {
    if (invScope) await api.ctx.delete(apiUrl(`/api/v1/workspaces/${invScope.workspaceId}`), { headers: invScope.headers }).catch(() => undefined);
    await inv?.api.dispose();
    await api?.ctx.dispose();
  });

  test('AC12 Q11 — AXI-2356.2 a SAP read failing with a server error blocks Run with "Could not read the statistical plan"; Retry → "no SAP" → exploratory @SI-066 @SI-030', async ({ page }) => {
    const o = await openTeam(page, { kind: 'server-error' }, { suggestion: { kind: 'answer', body: SEX_READ } });
    await reachReadyBySex(page);
    await expectRunBlocked(page, 'sap-error');
    const alert = page.getByTestId('na-run-block-sap-error');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('Could not read the statistical plan');
    await expect(page.getByTestId('na-run-block-retry')).toHaveText('Retry');
    await expect(page.getByTestId('na-run-block-retry')).toBeFocused();
    await expect(page.getByTestId('na-ready-row-plan')).toContainText('Not known yet');
    await expect(page.getByTestId('na-ready-analysis')).not.toContainText('Exploratory');
    await expect(page.getByTestId('na-step-ready').getByRole('heading', { level: 1 })).toHaveText('Here is the analysis you have set up.');
    await expect(page.getByTestId('na-rail-plan')).toContainText('The analysis plan could not be read');
    await shot(page, 'AXI-2356.2-sap-read-error');

    const before = o.sap.reads;
    await choose(page, 'na-run-block-retry'); // still failing
    await expect.poll(() => o.sap.reads).toBe(before + 1);
    await expectRunBlocked(page, 'sap-error');

    o.sap.set({ kind: 'none' });
    await choose(page, 'na-run-block-retry');
    await expectRunOpen(page);
    await expect(page.getByTestId('na-ready-analysis')).toContainText('Exploratory — this project has no analysis plan');
    await expect(page.getByTestId('na-step-ready').getByRole('heading', { level: 1 })).toHaveText('Here is the exploratory analysis you have set up.');
    await expect(page.getByTestId('na-rail-plan')).toContainText('Exploratory — no analysis plan');
    await expect(page.getByTestId('na-run')).toBeFocused();
    expect(o.launches(), 'nothing was launched while the plan was unread').toBe(0);
    await shot(page, 'AXI-2356.2-after-retry-no-sap');
  });

  test('AC12 Q11 — AXI-2356.3 a network failure, then a Retry that finds a SAP: the plan question is asked before Run @SI-066 @SI-030', async ({ page }) => {
    const o = await openTeam(page, { kind: 'network-error' }, { suggestion: { kind: 'answer', body: SEX_READ } });
    await expect(page.getByTestId('na-bar-plan')).toHaveCount(0);
    await reachReadyBySex(page);
    await expectRunBlocked(page, 'sap-error');

    o.sap.set({ kind: 'sap', row: SAP_ROW });
    await choose(page, 'na-run-block-retry');
    await expectRunBlocked(page, 'sap-unanswered');
    await expect(page.getByTestId('na-run-block-sap-unanswered')).toContainText('This project has an analysis plan. Choose whether this run uses it.');
    await expect(page.getByTestId('na-bar-plan')).toBeVisible();
    await expect(page.getByTestId('na-ready-row-plan')).toContainText('Not chosen yet');
    await shot(page, 'AXI-2356.3-sap-found-plan-unanswered');

    await choose(page, 'na-run-block-answerPlan');
    await expect(page.getByTestId('na-step-plan')).toBeVisible();
    await expect(page.getByTestId('na-step-plan')).toContainText('“IgG4 SAP” (version 1)');
    await expect(page.getByTestId('na-choice-no')).toHaveAttribute('aria-checked', 'true');
    await press(page, 'n');
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expectRunOpen(page);
    await expect(page.getByTestId('na-ready-analysis')).toContainText('Exploratory — you chose not to use the project’s analysis plan');
    expect(o.launches()).toBe(0);
  });

  test('AC12 Q11 — AXI-2356.4 while the SAP read is still pending Ready waits, then opens Run when "no SAP" arrives @SI-066', async ({ page }) => {
    const o = await openTeam(page, { kind: 'pending' }, { suggestion: { kind: 'answer', body: SEX_READ } });
    await reachReadyBySex(page);
    expect(o.sap.held).toBeGreaterThan(0);
    await expectRunBlocked(page, 'sap-loading');
    await expect(page.getByTestId('na-run-block-sap-loading')).toContainText('Reading the statistical plan…');
    await expect(page.getByTestId('na-run-block-sap-loading')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('na-ready-analysis')).not.toContainText('Exploratory');
    await shot(page, 'AXI-2356.4-sap-read-pending');
    const reads = o.sap.reads;
    o.sap.set({ kind: 'none' });
    await expectRunOpen(page);
    await expect(page.getByTestId('na-ready-analysis')).toContainText('Exploratory — this project has no analysis plan');
    // the pending read was answered, not retried: no new read was needed to open Run
    expect(o.sap.reads).toBe(reads);
  });

  test('AC45 Q12 — AXI-2356.5 the pairs question lists at most 20 pairs with a filter over all of them; a few levels list all @SI-066', async ({ page }) => {
    const o = await openTeam(page, { kind: 'none' }, { suggestion: { kind: 'answer', body: GROUPS_READ } });
    await reachPairs(page, MANY);
    const levels = (await o.grouping()).find((g) => g.column === MANY)!.levels;
    expect(levels.length, `${MANY} levels`).toBeGreaterThan(CAP);
    const every = allPairs(levels);
    await expect(pairs(page)).toHaveCount(CAP);
    expect(await pairLabels(page)).toEqual(every.slice(0, CAP));
    await expect(page.getByLabel('Find a pair')).toBeVisible();
    await expect(page.getByTestId('na-option-filter-summary')).toHaveText(`Showing ${CAP} of ${every.length} pairs. Type to find the others.`);
    await shot(page, 'AXI-2356.5-pairs-capped');

    const target = every[every.length - 1]; // never among the first 20
    const query = `${levels[levels.length - 2]} ${levels[levels.length - 1]}`;
    const expected = matching(every, query);
    await page.getByLabel('Find a pair').fill(query);
    await expect(pairs(page)).toHaveCount(Math.min(CAP, expected.length));
    expect(await pairLabels(page)).toContain(target);
    await expect(page.getByTestId('na-option-filter-summary')).toContainText(`“${query}”`);
    await shot(page, 'AXI-2356.5-pairs-filtered');

    await page.getByLabel('Find a pair').fill('zzz-no-such-group');
    await expect(pairs(page)).toHaveCount(0);
    await expect(page.getByTestId('na-option-filter-summary')).toHaveText('No pair matches “zzz-no-such-group”.');
    await page.getByLabel('Find a pair').fill('');
    await expect(pairs(page)).toHaveCount(CAP);

    await page.getByLabel('Find a pair').fill(query);
    await choose(page, `na-choice-${every.indexOf(target)}`);
    await expect(page.getByTestId('na-step-decide-outcome')).toBeVisible();
    await chooseRadio(page, /igg4_g_l/);
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(page.getByTestId('na-ready-decided')).toContainText(target);

    await choose(page, 'na-change-groupingColumn');
    await chooseRadio(page, new RegExp(`^${FEW}\\b`));
    await expect(page.getByTestId('na-step-decide-groups')).toBeVisible();
    const few = (await o.grouping()).find((g) => g.column === FEW)!.levels;
    await expect(pairs(page)).toHaveCount(allPairs(few).length);
    await expect(page.getByTestId('na-option-filter')).toHaveCount(0);
    await expect(page.getByTestId('na-many-groups')).toHaveCount(0);
  });

  test('AC15 AC45 Q12 — AXI-2356.6 above 12 group values the pairs question offers the many-groups template, keeping the column @SI-066', async ({ page }) => {
    const o = await openTeam(page, { kind: 'none' }, { suggestion: { kind: 'answer', body: GROUPS_READ } });
    await reachPairs(page, MANY);
    const n = (await o.grouping()).find((g) => g.column === MANY)!.levels.length;
    const offer = page.getByTestId('na-many-groups');
    await expect(offer).toContainText(`“${MANY}” has ${n} groups. To compare all of them at once, use Compare groups (Kruskal-Wallis test, then Dunn's pairwise test (Holm)).`);
    await expect(page.getByTestId('na-many-groups-switch')).toHaveText(`Compare all ${n} groups instead`);
    await shot(page, 'AXI-2356.6-many-groups-offer');
    await choose(page, 'na-many-groups-switch');
    await expect(page.getByTestId('na-step-decide-outcome')).toBeVisible();
    await expect(page.getByTestId('na-decide-blocks')).toContainText('Kruskal-Wallis');
    await chooseRadio(page, /igg4_g_l/);
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(page.getByTestId('na-ready-analysis')).toContainText('Kruskal-Wallis');
    await expect(page.getByTestId('na-ready-decided')).toContainText(MANY);

    await gotoSettled(page, `/new-analysis?datasetId=${datasetId}`);
    await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 30_000 });
    await reachPairs(page, FEW);
    await expect(page.getByTestId('na-many-groups')).toHaveCount(0);
  });

  test('AC12 AC45 Q13 — AXI-2356.7 the Investigator route behaves the same: SAP read error blocks Run; 20 pairs, filter, many-groups @SI-066 @SI-030', async ({ browser }) => {
    // a signed-out context: the project's admin storage state would send /login straight to the app
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await signInInvestigator(page);
    const o = await open(page, `/investigator/new-analysis?datasetId=${invDatasetId}`, { kind: 'server-error' }, { suggestion: { kind: 'answer', body: SEX_READ } });
    await reachReadyBySex(page);
    await expectRunBlocked(page, 'sap-error');
    await expect(page.getByTestId('na-run-block-sap-error')).toContainText('Could not read the statistical plan');
    await shot(page, 'AXI-2356.7-investigator-sap-read-error');
    o.sap.set({ kind: 'none' });
    await choose(page, 'na-run-block-retry');
    await expectRunOpen(page);

    const p = await open(page, `/investigator/new-analysis?datasetId=${invDatasetId}`, { kind: 'none' }, { suggestion: { kind: 'answer', body: GROUPS_READ } });
    await reachPairs(page, MANY);
    const levels = (await p.grouping()).find((g) => g.column === MANY)!.levels;
    await expect(pairs(page)).toHaveCount(CAP);
    await expect(page.getByTestId('na-option-filter-summary')).toHaveText(`Showing ${CAP} of ${allPairs(levels).length} pairs. Type to find the others.`);
    await expect(page.getByTestId('na-many-groups-switch')).toHaveText(`Compare all ${levels.length} groups instead`);
    await shot(page, 'AXI-2356.7-investigator-pairs');
    expect(o.launches() + p.launches()).toBe(0);
    await context.close();
  });
});

async function investigator(workspaceId: string): Promise<Investigator> {
  const email = `axi2356-investigator-${RUN}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2356', lastName: 'investigator' } });
  expect(registered.ok(), `register: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const me = await (await ctx.get(apiUrl('/api/v1/auth/me'))).json();
  const added = await api.post(`/api/v1/workspaces/${workspaceId}/members`, { userId: me.id, organizationId: t.orgId, roleId: INVESTIGATOR_ROLE_ID });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  return { email, userId: me.id, accessToken, api: ctx };
}

/** Sign in through the real login page; AXI-2323 lands him on his one study's surface. */
async function signInInvestigator(page: Page) {
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(inv.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/investigator$/, { timeout: 30_000 });
}
