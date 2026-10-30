import { test, expect, type Browser, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture, compileTemplate, drainGoverned } from './harness/opening-templates';
import { automaticPlan } from './harness/automatic-mode';
import {
  pollRecommendedCandidate,
  render,
  resolveResultDatasetId,
} from '../AXI-2309/harness/chart-style';
import { ruleRunIdsOfWorkspace, setChartStyle } from './harness/chart-style-sidecar';
import { gotoSettled, seedScope } from './harness/new-analysis';
import { INVESTIGATOR_ROLE_ID, REVIEWER_ROLE_ID, addMember, person, signIn, type Person } from './harness/result-page';

/**
 * AXI-2335 (epic AXI-2308 — FR41, FR42, FR43, NFR5, AC32, AC33, AC39; @SI-042).
 *
 * This spec is the automated-E2E half of AC33/FR43. It does NOT re-prove what
 * sibling stories already own end to end for the GUIDED launch path alone:
 *   - AXI-2327 (`AXI-2327-result-page.spec.ts`) — result-page navigation, the
 *     Reviewer read-only view, the one-404 refusal — on a WIZARD (Guided) run.
 *   - AXI-2330 (`AXI-2330-chart-style-sidecar.spec.ts`) — the style-sidecar
 *     contract (no re-run, no new record version, exactly three controls) — on
 *     a directly-submitted `/rule-runs` run.
 *   - AXI-2331 (`AXI-2331-report-exports.spec.ts`) — the report already exists
 *     and downloads with the question verbatim — on a WIZARD (Guided) run.
 *   - AXI-2322 (`AXI-2322-investigator-role.spec.ts`) — the full FR5 403 matrix.
 *   - AXI-2341 (`AXI-2341-automatic-mode.spec.ts`) — the Automatic-mode plan
 *     contract itself (recorded transport, call log, data-flow statement).
 *
 * None of the above exercises an AUTOMATIC-mode run through the RESULT PAGE,
 * the STYLE SIDECAR or the AUTO-GENERATED REPORT, and none opens an Automatic
 * run as the Reviewer — so FR43's "both modes ... and the result page:
 * navigation, the style sidecar ... and report auto-generation ... Reviewer
 * read-only" is not yet closed for the Automatic half. This spec closes that
 * gap: ONE Guided run and ONE Automatic run, each carried through navigation +
 * style sidecar + report + Reviewer read-only, plus a small FR5 403 closure
 * check on this spec's own tenant (never a replacement for AXI-2322's matrix).
 *
 * Automatic mode runs on the RECORDED transport only (standing default) — the
 * question and fixture are byte-identical to AXI-2341.3 so the call hits the
 * already-committed recording; no provider key, no spend.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md
 * § "AXI-2335".
 *
 * NEVER production. Authored against, and intended to run against, an isolated
 * stack serving this epic's merged branches — see the manual-e2e doc for the
 * TESTING.md charter that covers the actual production run (owner-only, AC33).
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2335-* --project=chromium --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers
 * (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const MAG4 = 'microbiote_igg4_mag4_27';
const AUTOMATIC_QUESTION = 'Does microbiote_igg4_mag4_27 differ between F and M of sexe?';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let investigator: Person;
let reviewer: Person;

let guidedRunId: string;
let guidedViewAnalysisId: string;
let automaticRunId: string;
let automaticViewAnalysisId: string;

const pagePath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;
const apiPath = (runId: string) => `/api/v1/projects/${t.projectId}/runs/${runId}/result-page`;
const reportPath = (runId: string) => `/api/v1/projects/${t.projectId}/rule-runs/${runId}/client-report?format=md`;

async function fresh(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

/** Submits a compiled/automatic plan straight to the governed engine, keeping `viewAnalysisId`. */
async function submitGovernedPlan(plan: unknown, datasetId: string): Promise<{ runId: string; viewAnalysisId: string }> {
  const res = await api.post('/api/v1/governed-execution/submit', { projectId: t.projectId, plan, datasetId, workspaceId: t.workspaceId }, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  expect(res.body.runId, JSON.stringify(res.body)).toBeTruthy();
  return { runId: res.body.runId, viewAnalysisId: res.body.viewAnalysisId };
}

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(async () => {
  test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
  api = await adminApi();
  t = await ensureTenant(api);
  const datasetId = await ingestCsvFixture(api, t, FIXTURE);
  const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
  if (!anchored) throw new Error('fixture dataset could not be anchored');
  dataset = anchored;
  await approveCarriersFor(['stats.mann_whitney_u']);
  await silenceTours(await adminToken());
  investigator = await person('investigator', t.workspaceId);
  reviewer = await person('reviewer', t.workspaceId);
  await addMember(api, t, investigator, INVESTIGATOR_ROLE_ID);
  await addMember(api, t, reviewer, REVIEWER_ROLE_ID);
});

test.afterAll(async () => {
  for (const p of [investigator, reviewer]) await p?.api.dispose();
  await api?.ctx.dispose();
});

test.describe('AXI-2335 — Guided mode: run, navigation, style sidecar, auto-generated report @SI-042 @SI-066 @SI-033 @SI-017 @SI-010', () => {
  test('FR43 — AXI-2335.1: a Guided (T1 Mann–Whitney) run settles and opens on the result page', async ({ page }) => {
    const compiled = await compileTemplate(api, t, dataset, 'T1', { outcome: MAG4, groupingColumn: 'sexe', groups: ['F', 'M'] });
    expect(compiled.status, JSON.stringify(compiled.body)).toBeLessThan(300);
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);

    const submitted = await submitGovernedPlan(compiled.body.plan, dataset.datasetId);
    const settled = await drainGoverned(api, t, submitted.runId);
    const nodeStatuses = (settled.nodes as Array<{ status: string }>).map((n) => n.status);
    expect(nodeStatuses, JSON.stringify(settled.nodes)).not.toContain('FAILED');
    expect(nodeStatuses).not.toContain('BLOCKED');
    guidedRunId = (settled as any).ruleRunId;
    guidedViewAnalysisId = submitted.viewAnalysisId;
    expect(guidedRunId, JSON.stringify(settled)).toBeTruthy();

    // Navigation: the team result page opens and renders the answer.
    await seedScope(page, t);
    await gotoSettled(page, pagePath(guidedRunId));
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('rp-chart')).toBeVisible();
  });

  test('AC24, EC16 — AXI-2335.2: the style sidecar applies to a Guided run with no re-run and no new record version', async () => {
    const resultDatasetId = await resolveResultDatasetId(api, t, guidedViewAnalysisId, guidedRunId);
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, guidedViewAnalysisId);
    expect(recommended, 'no recommended-origin spec minted for the Guided run').toBeTruthy();

    const runsBefore = await ruleRunIdsOfWorkspace(api, t);
    const set = await setChartStyle(api, t, recommended.id, { highlightedGroup: 'F' });
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
    const runsAfter = await ruleRunIdsOfWorkspace(api, t);

    expect(new Set(runsAfter)).toEqual(new Set(runsBefore));
    const runAfter = (await api.get(`/api/v1/rule-runs/${guidedRunId}`, t.headers)).body;
    expect(runAfter.status).toBe('SUCCEEDED');
    const rendered = await render(api, t, recommended.id);
    expect(rendered.style?.highlightedGroup).toBe('F');
  });

  test('AC26, AC29 — AXI-2335.3: the Guided run\'s report already exists and carries the question verbatim', async () => {
    const res = await api.get(reportPath(guidedRunId), t.headers);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const markdown = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(markdown).toContain(MAG4);
  });

  test('AC23, FR35 — AXI-2335.4: the Reviewer opens the Guided run read-only', async ({ browser }) => {
    const page = await fresh(browser);
    await signIn(page, reviewer, t, pagePath(guidedRunId));
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('rp-new-analysis')).toHaveCount(0);
    const served = await reviewer.api.get(apiUrl(apiPath(guidedRunId)));
    expect(served.status()).toBe(200);
    expect((await served.json()).canStartAnalysis).toBe(false);
    await page.context().close();
  });
});

test.describe('AXI-2335 — Automatic mode: recorded-transport run, navigation, style sidecar, auto-generated report @SI-042 @SI-066 @SI-033 @SI-017 @SI-010 @SI-045', () => {
  test('FR43, AC19 — AXI-2335.5: an Automatic-mode run (recorded transport) settles and opens on the result page', async ({ page }) => {
    const planned = await automaticPlan(api, t, dataset, AUTOMATIC_QUESTION);
    expect(planned.status, JSON.stringify(planned.body).slice(0, 500)).toBeLessThan(300);
    expect(planned.body.ok, JSON.stringify(planned.body).slice(0, 500)).toBe(true);
    expect(planned.body.compiled?.plan, 'no plan compiled — the recorded transport missed; nothing was spent').toBeTruthy();

    const submitted = await submitGovernedPlan(planned.body.compiled.plan, dataset.datasetId);
    const settled = await drainGoverned(api, t, submitted.runId);
    const nodeStatuses = (settled.nodes as Array<{ status: string }>).map((n) => n.status);
    expect(nodeStatuses, JSON.stringify(settled.nodes)).not.toContain('FAILED');
    expect(nodeStatuses).not.toContain('BLOCKED');
    automaticRunId = (settled as any).ruleRunId;
    automaticViewAnalysisId = submitted.viewAnalysisId;
    expect(automaticRunId, JSON.stringify(settled)).toBeTruthy();

    await seedScope(page, t);
    await gotoSettled(page, pagePath(automaticRunId));
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('rp-chart')).toBeVisible();
  });

  test('AC24, EC16 — AXI-2335.6: the style sidecar applies to an Automatic run with no re-run and no new record version', async () => {
    const resultDatasetId = await resolveResultDatasetId(api, t, automaticViewAnalysisId, automaticRunId);
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, automaticViewAnalysisId);
    expect(recommended, 'no recommended-origin spec minted for the Automatic run').toBeTruthy();

    const runsBefore = await ruleRunIdsOfWorkspace(api, t);
    const set = await setChartStyle(api, t, recommended.id, { highlightedGroup: 'M' });
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
    const runsAfter = await ruleRunIdsOfWorkspace(api, t);

    expect(new Set(runsAfter)).toEqual(new Set(runsBefore));
    const runAfter = (await api.get(`/api/v1/rule-runs/${automaticRunId}`, t.headers)).body;
    expect(runAfter.status).toBe('SUCCEEDED');
    const rendered = await render(api, t, recommended.id);
    expect(rendered.style?.highlightedGroup).toBe('M');
  });

  test('AC26, AC29 — AXI-2335.7: the Automatic run\'s report already exists and carries the question verbatim', async () => {
    const res = await api.get(reportPath(automaticRunId), t.headers);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const markdown = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(markdown).toContain(MAG4);
  });

  test('AC23, FR35, FR3 — AXI-2335.8: the Reviewer opens the Automatic run read-only too', async ({ browser }) => {
    const page = await fresh(browser);
    await signIn(page, reviewer, t, pagePath(automaticRunId));
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('rp-new-analysis')).toHaveCount(0);
    const served = await reviewer.api.get(apiUrl(apiPath(automaticRunId)));
    expect(served.status()).toBe(200);
    expect((await served.json()).canStartAnalysis).toBe(false);
    await page.context().close();
  });
});

test.describe('AXI-2335 — FR5 closure: the Investigator stays denied on this tenant @SI-042 @SI-010', () => {
  test('FR5, AC33 — AXI-2335.9: the Investigator is refused the catalogue/admin routes on THIS tenant, both runs\' mode notwithstanding', async () => {
    const denied = ['/api/v1/rules', '/api/v1/rule-runs/operations', '/api/v1/teams'];
    for (const path of denied) {
      const res = await investigator.api.get(apiUrl(path));
      expect(res.status(), `${path} -> ${res.status()}`).toBe(403);
      expect(await res.text()).toContain('This endpoint is not available to the Investigator role');
    }
    const write = await investigator.api.post(apiUrl('/api/v1/workspaces'), { data: { name: `AXI-2335 ${Date.now()}` } });
    expect(write.status()).toBe(403);
  });
});
