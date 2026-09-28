import { test, expect, type Page } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import {
  ensureTenant, ensureProject, ingestFixture, datasetVersionHash, ensureDefaultAnalysis, createViewAnalysis, bindEnvelope, ensureApprovedDiscoveryConfig,
} from '../AXI-1507/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { serveWorkbenchRules, driveToScreen, runLiveScreen } from './harness/live-workbench';

/**
 * AXI-1723 — Constrained pickers, no free-text parameters (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 12.
 * Tags: @SI-046 (front: the pickers), @SI-045 (guided-analysis: the resolver's `pickInDomain`).
 *
 * REAL BACKEND, LLM-FREE. Same AXI-1507 harness/fixture as AXI-1721's spec (Riaz 2017 immune,
 * 27 patients, `response` R/NR, `patient_id`).
 *
 * What is live here (§12.1, §12.2):
 *  - UI: the OPEN container's cutoff proposal now shows the plan's DECLINE (lead ruling,
 *    AXI-1728), never a picker — superseding AXI-1721's own §11.3 assertion.
 *  - API: `pickInDomain`'s A5 refusals (open domain, governed policy domain) through the live
 *    resolver, which is exactly the back fix this story carried (a policy-governed pick used to
 *    surface a wrong `open` domain instead of `policy`; see the back commit history).
 *
 * What is NOT live here, and why (§12.3 of the doc): FR14's picker sequence and EC2's two-level
 * picker have no naturally-occurring live trigger in this template/fixture — the only operations
 * with two simultaneously-required-and-unresolved parameters are `positiveGroup`/`referenceGroup`,
 * which the SAME decline signature already claims, and the fixture declares no dual-representation
 * measure. Both are pinned deterministically at the component level instead
 * (`ParameterPicker.test.tsx`, `parameterPicker.test.ts` in axiome-front). This file does not
 * fabricate a live scenario for them.
 */

const FIXTURE = 'riaz2017_immune_wide.csv';
const PROJECT_NAME = 'AXI-1723 Constrained Pickers';
const LABEL = `axi-1723-${Date.now().toString(36)}`;
const MEASUREMENTS = ['CD27_pre', 'CD274_pre', 'CD8A_pre', 'CXCL9_pre', 'GZMB_pre', 'IFNG_pre', 'PDCD1_pre', 'STAT1_pre'];
const SCREEN_OP = 'stats.screen_shortlist';
const CUTOFF_OP = 'stats.cutoff_roc_youden';
const SPLIT_OP = 'split.exploration_holdout';

interface Seeded {
  api: Api;
  t: Awaited<ReturnType<typeof ensureTenant>>;
  projectId: string;
  datasetId: string;
  /** The OPEN container: its plan declares no positive outcome class, so the cutoff step is DECLINED (lead ruling). */
  viewAnalysisId: string;
  hash: string;
  instanceRunId: string;
}

const RIAZ_ROLES = {
  outcome: { state: 'declared', column: 'response', outcomeKind: 'binary' },
  subject: { state: 'declared', column: 'patient_id' },
  timepoint: { state: 'declared_uncaptured', reason: 'AXI-1723 e2e: pre-treatment only' },
  representation: { state: 'declared_uncaptured', reason: 'AXI-1723 e2e: bulk expression' },
  batch: { state: 'declared_uncaptured', reason: 'AXI-1723 e2e: none recorded' },
  site: { state: 'declared_uncaptured', reason: 'AXI-1723 e2e: single site' },
};

/** Same move as AXI-1721's harness: the mock's Stratify step needs the subject key matched. */
async function ensureSubjectKeyMapped(api: Api, t: Awaited<ReturnType<typeof ensureTenant>>, projectId: string): Promise<void> {
  const matched = async (): Promise<boolean> => {
    const res = await api.get(`/api/v1/projects/${projectId}/field-mappings`, t.headers);
    const list: any[] = Array.isArray(res.body) ? res.body : res.body?.data ?? [];
    return list.some((m) => m.canonicalField === 'patient_id' && m.status === 'matched');
  };
  if (await matched()) return;
  const assigned = await api.patch(`/api/v1/projects/${projectId}/profile`, { profileId: 'immuno_oncology' }, t.headers);
  expect(assigned.status, `assign profile: ${JSON.stringify(assigned.body)}`).toBeLessThan(300);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await matched()) return;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error('the subject key (patient_id) never matched after assigning the immuno_oncology profile');
}

async function seed(): Promise<Seeded> {
  const api = await adminApi();
  // AXI-1809: nothing is served without an approval record (AXI-1768) — serve what the workbench runs.
  await serveWorkbenchRules();
  const t = await ensureTenant(api);
  const projectId = await ensureProject(api, t, PROJECT_NAME);
  const datasetId = await ingestFixture(api, t, FIXTURE);
  const hash = await datasetVersionHash(api, t, datasetId);
  await ensureApprovedDiscoveryConfig(api, t);
  await ensureDefaultAnalysis(api, t, projectId, datasetId);
  await ensureSubjectKeyMapped(api, t, projectId);

  const viewAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `${LABEL} — constrained pickers (open)`);
  const bound = await bindEnvelope(api, t, viewAnalysisId);
  expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);
  const planned = await api.post('/api/v1/discovery/plans', {
    viewAnalysisId, projectId, datasetId, datasetVersionHash: hash,
    questionKey: LABEL, question: 'Which pre-treatment immune marker separates responders?',
    takeSplit: false, measurementColumns: MEASUREMENTS, comparisons: [{ from: 'R', to: 'NR' }], rankBy: 'qValue',
    outcomeColumn: 'response', patientKeyColumn: 'patient_id', // no outcomePositiveLevel: the OPEN container
  }, t.headers);
  expect(planned.status, `instantiate: ${JSON.stringify(planned.body)}`).toBe(201);
  expect(planned.body.instantiated, `refused: ${JSON.stringify(planned.body.reasons)}`).toBe(true);
  const instanceRunId = planned.body.instance.runId as string;

  const rolesUrl = `/api/v1/discovery/analyses/${viewAnalysisId}/datasets/${datasetId}/roles`;
  const current = await api.get(rolesUrl, t.headers);
  expect(current.status, `GET roles: ${JSON.stringify(current.body)}`).toBe(200);
  if (!current.body.confirmed) {
    const put = await api.ctx.put(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${rolesUrl}`, { data: { roles: RIAZ_ROLES, confirm: true }, headers: t.headers });
    expect(put.status(), await put.text()).toBeLessThan(300);
  }
  return { api, t, projectId, datasetId, viewAnalysisId, hash, instanceRunId };
}

const stepUrl = (va: string, nodeRef: string, action: 'resolve' | 'submit') => `/api/v1/discovery/analyses/${va}/steps/${nodeRef}/${action}`;

// ─────────────────────────────────────────────────────────────────────────────

test.describe('AXI-1723 - pickInDomain refusals through the live resolver (real backend)', { tag: ['@SI-045', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let s: Seeded;

  test.beforeAll(async () => { s = await seed(); });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR13 NFR4 - a pick for an OPEN domain (splitSeed) is refused: stays unresolved with domain open, never bound as user', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'resolve'), {
      operationId: SPLIT_OP, datasetId: s.datasetId, picks: { splitSeed: 4242 },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fullyBound).toBe(false);
    const byName = Object.fromEntries(res.body.bindings.map((b: any) => [b.name, b]));
    expect(byName.splitSeed, 'never bound as user').toBeUndefined();
    const splitSeed = res.body.unresolved.find((u: any) => u.name === 'splitSeed');
    expect(splitSeed).toMatchObject({ domain: { kind: 'open' } });
  });

  test('FR13 EC4 - a pick for a GOVERNED policy domain (holdoutRatio) is refused with domain policy attached, never open (the back A5 follow-up fix)', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'resolve'), {
      operationId: SPLIT_OP, datasetId: s.datasetId, picks: { holdoutRatio: 0.5 },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byName = Object.fromEntries(res.body.bindings.map((b: any) => [b.name, b]));
    expect(byName.holdoutRatio, 'a user pick never overrides a governed policy value').toBeUndefined();
    const holdoutRatio = res.body.unresolved.find((u: any) => u.name === 'holdoutRatio');
    expect(holdoutRatio.reason).toContain('outside its allowed domain');
    // This is the exact gap the back fix closed: before it, a pick-check on a governed slot fell
    // through to `open` because the policy branch only ran on the NO-pick path.
    expect(holdoutRatio.domain).toEqual({ kind: 'policy', key: `${SPLIT_OP}.holdoutRatio` });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

async function driveToChosenMarker(page: Page, projectId: string, viewAnalysisId: string, screenRuleCode: string): Promise<void> {
  await driveToScreen(page, projectId, viewAnalysisId);
  await runLiveScreen(page, screenRuleCode);
  const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
  await result.getByTestId('screen-result-expand').click();
  const table = page.getByTestId('screen-shortlist-table');
  await expect(table).toBeVisible();
  const allChip = page.getByTestId('screen-filter').getByRole('button', { name: /all/i });
  if (await allChip.count()) await allChip.click();
  await table.locator('tbody tr').first().click();
  await page.getByTestId('screen-choice-rationale').fill('AXI-1723 e2e: constrained pickers');
  await page.getByTestId('screen-choose-marker').click();
  await expect(page.getByTestId('marker-chosen')).toBeVisible({ timeout: 30_000 });
}

test.describe('AXI-1723 - the OPEN container shows the plan\'s decline, never a picker (UI, real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let screenRuleCode: string;

  test.beforeAll(async () => {
    s = await seed();
    // AXI-1809: the screen carrier is SERVED only once approved (AXI-1768) — walk it through review;
    // a carrier that cannot be approved fails here naming its failing check, not "no published rule".
    screenRuleCode = (await approveCarriersFor([SCREEN_OP]))[SCREEN_OP].code;
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    }, [s.t.workspaceId, s.t.orgId] as const);
  });

  test('FR13 (lead ruling, AXI-1728) - the Youden proposal shows the decline sentence, no picker, no Run control; AC5: no free-text control anywhere on the surface', async ({ page }) => {
    await driveToChosenMarker(page, s.projectId, s.viewAnalysisId, screenRuleCode);
    const row = page.getByTestId('cutoff-proposals').getByTestId(`cutoff-op-${CUTOFF_OP}`);
    const declined = row.getByTestId(`cutoff-op-declined-${CUTOFF_OP}`);
    await expect(declined).toContainText('Declined by the plan', { timeout: 30_000 });
    await expect(declined).toContainText('no positive outcome class was declared');
    await expect(declined).toContainText('a pick cannot un-decline it');
    await expect(row.getByTestId(`cutoff-op-unresolved-${CUTOFF_OP}`)).toHaveCount(0);
    await expect(row.getByTestId(`cutoff-op-run-${CUTOFF_OP}`)).toHaveCount(0);
    await expect(row.locator('input, textarea, select')).toHaveCount(0);
  });
});
