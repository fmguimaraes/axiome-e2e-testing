import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { apiUrl } from '../../config/env';
import {
  ensureTenant, ensureProject, ingestFixture, datasetVersionHash, ensureDefaultAnalysis,
  createViewAnalysis, bindEnvelope, ensureApprovedDiscoveryConfig, instantiatePlan, NAMES,
} from '../AXI-1507/harness/seed';

/**
 * First-visit onboarding tours auto-start and NAVIGATE (e.g. the "workspace-data"
 * tour's autostart route is `/workspaces/:id`), which pulls the workbench page out
 * from under the badge assertions mid-test (same trap documented in
 * AXI-1772-picker-one-click.spec.ts). Mark every registered tour skipped for the
 * admin the browser signs in as before driving the UI describe.
 */
const TOUR_IDS = ['orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration'];
async function silenceTours(api: Api): Promise<void> {
  for (const tourId of TOUR_IDS) {
    const res = await api.ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 } });
    expect(res.status(), `silence tour ${tourId}: ${await res.text()}`).toBeLessThan(300);
  }
}

/**
 * AXI-1806 (epic AXI-1717) — the `declared` run status: a discovery plan's
 * instantiation run stays DRAFT forever until a step is submitted (AXI-1779), so
 * `deriveViewRunStatus` (back) now reports `declared` for it, distinct from
 * `running`. Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md`
 * §30 ("an instantiated-but-never-started discovery plan reports `declared`").
 * Tags: @SI-045 (back: `deriveViewRunStatus`), @SI-046 (front: `RunStatusBadge`).
 *
 * Two describes:
 *  - API (real backend, LLM-free): instantiate a plan through the SAME contract
 *    the canvas trigger calls (`POST /v1/discovery/plans`) and read its own
 *    instantiation run's status back — no step is ever submitted.
 *  - UI (mocked routes, like AXI-1718): the badge must render a real, non-empty,
 *    honest label for `declared` — never "Running", never blank.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: Api;
let t: Awaited<ReturnType<typeof ensureTenant>>;
let projectId: string;
let datasetId: string;
let hash: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  projectId = await ensureProject(api, t, NAMES.project);
  datasetId = await ingestFixture(api, t, NAMES.smallFixture);
  hash = await datasetVersionHash(api, t, datasetId);
  await ensureApprovedDiscoveryConfig(api, t);
  await silenceTours(api);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1806 - a declared-but-never-started discovery plan run reports `declared` (API, real backend)', { tag: ['@SI-045'] }, () => {
  test('the instantiation run has never been started — no step was submitted, so `status` GET reports `declared`, never `running`', async () => {
    // Links the dataset into the project (idempotent); its returned auto_default
    // analysis is NOT reused below — a container holds at most one plan
    // instance ever (D.8), so a fresh container is created per run.
    await ensureDefaultAnalysis(api, t, projectId, datasetId);
    const viewAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `AXI-1806 — declared run status ${Date.now()}`);
    const bound = await bindEnvelope(api, t, viewAnalysisId);
    expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);

    const instantiated = await instantiatePlan(api, t, {
      viewAnalysisId, projectId, datasetId, datasetVersionHash: hash,
      questionKey: `axi-1806-${Date.now().toString(36)}`,
    });
    expect(instantiated.status, `instantiate: ${JSON.stringify(instantiated.body)}`).toBe(201);
    expect(instantiated.body.instantiated, `refused: ${JSON.stringify(instantiated.body.reasons)}`).toBe(true);
    const runId: string = instantiated.body.instance.runId;
    expect(runId, 'instantiation records its own runId').toBeTruthy();

    // No step has been submitted at all — the run is exactly as `declarePlan` left it.
    const status = await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, t.headers);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.runStatus).toBe('declared');
    expect(status.body.status).toBe('DRAFT');
    expect(status.body.startedAt).toBeNull();
    expect(status.body.completedAt).toBeNull();
  });
});

test.describe('AXI-1806 - the badge renders `declared` honestly (UI, routes mocked)', { tag: ['@SI-046'] }, () => {
  async function seedWorkspaceScope(page: Page): Promise<void> {
    await page.addInitScript(
      ([ws, org]) => {
        localStorage.setItem('axiome-active-workspace', ws);
        localStorage.setItem('axiome-top-org', org);
      },
      [t.workspaceId, t.orgId] as const,
    );
  }

  function openingPlan(question: string, planId: string) {
    const node = (id: string, nodeType: string) => ({
      id, nodeType, stepLabel: `${id}`, clinicalQuestion: question, why: 'opening step', dependsOn: [], params: {},
      expectedEvidence: 'n/a', visualisation: null, proposedClaimCeiling: 'descriptive_only', familyId: null,
    });
    return {
      planId, revision: 1, question, sendData: false,
      reasoning: { restatedQuestion: question, whyThisApproach: 'mocked (AXI-1806 E2E)', whatThisWillNotEstablish: 'n/a', alternativesConsidered: [] },
      datasetsUsed: [], datasetsAvailableNotUsed: [], declaredFamily: null,
      nodes: [node('d1', 'profile'), node('d2', 'qc_check')],
    };
  }

  test('the workbench badge reads "Not started" for a declared run — never "Running", never blank', async ({ page }) => {
    const planId = 'PL-1806-mock';
    const runId = 'GR-1806-declared';
    const analysisId = 'VA-1806-mock';

    await seedWorkspaceScope(page);
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId, question: 'AXI-1806 — declared run status', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(), plan: openingPlan('AXI-1806 — declared run status', planId),
          strategy: 'guided_discovery', analysisId,
        }]),
      });
    });
    await page.route('**/api/v1/governed-execution/status*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          runId, status: 'DRAFT', nodes: [], runStatus: 'declared',
          counts: { plannedTests: 0, evaluableTests: 0, subjectsInScope: 0, completePairs: 0 },
          degraded: false, degradeReasons: [], failReason: null,
          startedAt: null, completedAt: null,
        }),
      });
    });

    await page.goto(`/projects/${projectId}/guided-workbench/${planId}?runId=${runId}&analysisId=${analysisId}`);
    await expect(page.getByTestId('workbench-shell')).toBeVisible();

    const badge = page.getByTestId('run-status-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute('data-status', 'declared');
    // The class this story exists to fix: a `declared` value must never render
    // undefined text, and must never be read as "Running" (AXI-1806 B1).
    await expect(badge).not.toHaveText('');
    await expect(badge).not.toContainText('Running');
    await expect(badge).toHaveText('Not started');
  });
});
