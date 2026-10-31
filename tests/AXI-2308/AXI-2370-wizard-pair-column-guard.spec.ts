import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes, type WizardStubs } from './harness/new-analysis';

/**
 * AXI-2370 (epic AXI-2308 — AC1, AC2, AC3, AC6): the Template step must offer a
 * (template, dataset) pair only when the dataset carries every column the investigator's own
 * question literally names (AC2) — the generic "shape eligible" check alone let two demo-DB
 * `ViewAnalysis` rows named "Guided: Does igg4_g_l differ by sexe?" land on datasets with
 * neither `igg4_g_l` nor `sexe` (`312905ba-…`, `f5344441-…`); only `f93231f3-…` (tableau2) has
 * both. This reproduces that scenario on a project with THREE candidate datasets, and exercises
 * the backend's independent re-check (AC3) directly against the launch route for a client that
 * skips the UI guard.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2370.
 *
 * Fixtures: `opening-templates-paul-header.csv` (HAS `igg4_g_l`/`sexe` — the matching dataset),
 * `opening-templates-second-dataset.csv` and `opening-templates-third-dataset.csv` (both T1-shape
 * eligible — a 2-level grouping column + a continuous one — but neither carries `igg4_g_l` or
 * `sexe`, exactly like the two demo-DB offenders).
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2370 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2370-*`.
 */

const FIXTURE_MATCHING = 'opening-templates-paul-header.csv'; // has igg4_g_l + sexe
const FIXTURE_BAD_1 = 'opening-templates-second-dataset.csv'; // T1-eligible, neither column
const FIXTURE_BAD_2 = 'opening-templates-third-dataset.csv'; // T1-eligible, neither column
const QUESTION = 'Does igg4_g_l differ by sexe?';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';

let api: Api;
let t: Tenant;
let matchingDataset: string;
let badDataset1: string;
let badDataset2: string;

/** T1's pair key on a given dataset. */
const pk = (datasetId: string) => `T1::${datasetId}`;

async function openWizard(page: Page, path: string, stubs: WizardStubs = {}) {
  await seedScope(page, t);
  await stubWizardRoutes(page, stubs);
  await gotoSettled(page, path);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 });
}

async function reachTemplate(page: Page) {
  await askQuestion(page, QUESTION);
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
}

test.describe.serial('AXI-2370 a (template, dataset) pair is offered only if the dataset carries the question\'s own named columns @SI-045 @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    matchingDataset = await ingestCsvFixture(api, t, FIXTURE_MATCHING);
    badDataset1 = await ingestCsvFixture(api, t, FIXTURE_BAD_1);
    badDataset2 = await ingestCsvFixture(api, t, FIXTURE_BAD_2);
    await silenceTours(await adminToken());
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AC1 AC2 — AXI-2370.1 three candidate datasets, the question names igg4_g_l and sexe: only the matching dataset is offered for T1', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: answered(QUESTION, 'compare_groups') } });
    await reachTemplate(page);
    await expect(page.getByTestId(pk(matchingDataset))).toBeVisible();
    await expect(page.getByTestId(pk(badDataset1))).toHaveCount(0);
    await expect(page.getByTestId(pk(badDataset2))).toHaveCount(0);
  });

  test('AC2 — AXI-2370.2 a question naming no column offers every shape-eligible dataset (regression: the guard is vacuous, never over-broad)', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: answered('Does the outcome differ between the two groups?', 'compare_groups') } });
    await reachTemplate(page);
    await expect(page.getByTestId(pk(matchingDataset))).toBeVisible();
    await expect(page.getByTestId(pk(badDataset1))).toBeVisible();
    await expect(page.getByTestId(pk(badDataset2))).toBeVisible();
  });

  test('AC3 — AXI-2370.3 the backend independently refuses a launch whose dataset lacks a column the question names, even bypassing the UI guard and WITHOUT any client-reported dataset list', async ({ page }) => {
    await seedScope(page, t);
    const badSchema = { datasetId: badDataset1, displayName: FIXTURE_BAD_1, versionHash: 'sha256:' + '0'.repeat(64), columns: [{ name: 'biomarker_x', type: 'numeric' }, { name: 'group_arm', type: 'categorical', categories: ['A', 'B'] }, { name: 'visit_age', type: 'numeric' }] };
    const body = {
      projectId: t.projectId,
      dataset: badSchema,
      // AXI-2370 (AC3, review bounce 1 B1): no `candidateDatasets` field - that field is GONE
      // from the contract. The server resolves the column universe itself from every dataset
      // LINKED to this project (`matchingDataset`, ingested + linked in `beforeAll`, carries
      // `igg4_g_l`/`sexe`), so the question is refused even though this request names no client
      // list at all - exactly the caller this AC exists for (a hand-built request, a stale
      // build, a bug in the UI guard).
      question: QUESTION,
      intent: 'compare_groups',
      intentSource: 'chosen',
      templateId: 'T1',
      slots: [
        { slot: 'groupingColumn', value: 'group_arm', provenance: 'decided', answeredAt: new Date().toISOString() },
        { slot: 'groups', value: ['A', 'B'], provenance: 'decided', answeredAt: new Date().toISOString() },
        { slot: 'outcome', value: 'biomarker_x', provenance: 'decided', answeredAt: new Date().toISOString() },
      ],
    };
    const res = await api.post(WIZARD_RUNS, body, t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(false);
    expect(res.body.ruleIds, JSON.stringify(res.body)).toContain('WIZ_QUESTION_NAMES_MISSING_COLUMN');
  });
});
