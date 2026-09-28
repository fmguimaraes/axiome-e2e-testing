import { expect, type Page } from '@playwright/test';
import { adminApi, type Api } from '../../AXI-1435/harness/api';
import {
  ensureTenant, ensureProject, ingestFixture, datasetVersionHash, ensureDefaultAnalysis, createViewAnalysis, bindEnvelope, ensureApprovedDiscoveryConfig,
} from '../../AXI-1507/harness/seed';

/**
 * AXI-1722 (epic AXI-1717) — the LIVE workbench seed, lifted out of
 * `AXI-1721-step-resolver.spec.ts` so the row-binding, picker, cutoff-result and
 * association stories share ONE pre-Screen drive instead of re-deriving it.
 *
 * REAL BACKEND, LLM-FREE: the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call. Fixture: Riaz 2017 immune, 27
 * patients, `response` R/NR, `patient_id`, pre-treatment gene measurements.
 */

export const FIXTURE = 'riaz2017_immune_wide.csv';
export const MEASUREMENTS = ['CD27_pre', 'CD274_pre', 'CD8A_pre', 'CXCL9_pre', 'GZMB_pre', 'IFNG_pre', 'PDCD1_pre', 'STAT1_pre'];
export const SCREEN_OP = 'stats.screen_shortlist';
export const CUTOFF_OP = 'stats.cutoff_roc_youden';
export const SPLIT_OP = 'split.exploration_holdout';
export const FISHER_OP = 'stats.fisher_exact';
export const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED']);

export interface Seeded {
  api: Api;
  t: Awaited<ReturnType<typeof ensureTenant>>;
  projectId: string;
  datasetId: string;
  /** The OPEN container: its plan declares no positive outcome class, so the cutoff's `positiveGroup` stays open (FR13). */
  viewAnalysisId: string;
  hash: string;
  instanceRunId: string;
  /** The DECLARED container: its plan declares `outcomePositiveLevel: 'R'`, so its own cutoff node binds `positiveGroup` (FR8). */
  declaredAnalysisId: string;
  declaredInstanceRunId: string;
}

/** Roles of the Riaz fixture: outcome = response (binary), subject = patient_id — the resolver's `role:` source. */
export const RIAZ_ROLES = {
  outcome: { state: 'declared', column: 'response', outcomeKind: 'binary' },
  subject: { state: 'declared', column: 'patient_id' },
  timepoint: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: pre-treatment only' },
  representation: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: bulk expression' },
  batch: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: none recorded' },
  site: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: single site' },
};

/**
 * The mock's Stratify step is the EXISTING statistical run-config modal, whose referent gate
 * needs a semantic profile whose field mappings match the subject key (`patient_id`). The
 * seeded `immuno_oncology` profile's aliases match the fixture's raw column name, so assigning
 * it to the project is enough — the same move the AXI-1435 harness makes. Idempotent.
 */
export async function ensureSubjectKeyMapped(api: Api, t: Awaited<ReturnType<typeof ensureTenant>>, projectId: string): Promise<void> {
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

/**
 * Two containers on the same dataset, each with its own plan instance (D.8: one per analysis).
 * Screen R→NR over the measurements, no split taken. The OPEN one declares no positive outcome
 * class — the template records the cutoff analyses as declined and the cutoff step waits for the
 * author to NAME the class (FR12/FR13). The DECLARED one names `R`, so its cutoff node already
 * carries `positiveGroup` and the step binds it from upstream (FR8).
 *
 * `label` must be unique per run (a container holds at most ONE plan instance).
 */
export async function seedLiveWorkbench(label: string, projectName: string): Promise<Seeded> {
  const api = await adminApi();
  const t = await ensureTenant(api);
  const projectId = await ensureProject(api, t, projectName);
  const datasetId = await ingestFixture(api, t, FIXTURE);
  const hash = await datasetVersionHash(api, t, datasetId);
  await ensureApprovedDiscoveryConfig(api, t);
  await ensureDefaultAnalysis(api, t, projectId, datasetId); // links the dataset to the project (idempotent)
  await ensureSubjectKeyMapped(api, t, projectId);

  const instantiate = async (viewAnalysisId: string, questionKey: string, outcomePositiveLevel?: string): Promise<string> => {
    const bound = await bindEnvelope(api, t, viewAnalysisId);
    expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);
    const planned = await api.post('/api/v1/discovery/plans', {
      viewAnalysisId, projectId, datasetId, datasetVersionHash: hash,
      questionKey, question: 'Which pre-treatment immune marker separates responders?',
      takeSplit: false, measurementColumns: MEASUREMENTS, comparisons: [{ from: 'R', to: 'NR' }], rankBy: 'qValue',
      outcomeColumn: 'response', patientKeyColumn: 'patient_id', ...(outcomePositiveLevel ? { outcomePositiveLevel } : {}),
    }, t.headers);
    expect(planned.status, `instantiate: ${JSON.stringify(planned.body)}`).toBe(201);
    expect(planned.body.instantiated, `refused: ${JSON.stringify(planned.body.reasons)}`).toBe(true);
    return planned.body.instance.runId as string;
  };
  const viewAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `${label} — (open)`);
  const instanceRunId = await instantiate(viewAnalysisId, label);
  const declaredAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `${label} — (declared R)`);
  const declaredInstanceRunId = await instantiate(declaredAnalysisId, `${label}-declared`, 'R');

  // AXI-1720 roles, confirmed — keyed by (workspace, dataset), so one confirmation serves both containers.
  // The roles route answers only for an analysis holding a discovery plan instance, hence after the plan.
  const rolesUrl = `/api/v1/discovery/analyses/${viewAnalysisId}/datasets/${datasetId}/roles`;
  const current = await api.get(rolesUrl, t.headers);
  expect(current.status, `GET roles: ${JSON.stringify(current.body)}`).toBe(200);
  if (!current.body.confirmed) {
    const put = await api.ctx.put(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${rolesUrl}`, { data: { roles: RIAZ_ROLES, confirm: true }, headers: t.headers });
    expect(put.status(), await put.text()).toBeLessThan(300);
  }
  return { api, t, projectId, datasetId, viewAnalysisId, hash, instanceRunId, declaredAnalysisId, declaredInstanceRunId };
}

export const stepUrl = (va: string, nodeRef: string, action: 'resolve' | 'submit') => `/api/v1/discovery/analyses/${va}/steps/${nodeRef}/${action}`;

/** AXI-1725 — the branch endpoints: `POST/GET …/branches`, `POST …/branches/:id/discard`. */
export const branchUrl = (va: string, branchId?: string) => `/api/v1/discovery/analyses/${va}/branches${branchId ? `/${branchId}/discard` : ''}`;

/** AXI-1750 (R12) — the governed holdout-decline record: `POST …/steps/:nodeRef/decline-holdout`. */
export const declineHoldoutUrl = (va: string, nodeRef: string) => `/api/v1/discovery/analyses/${va}/steps/${nodeRef}/decline-holdout`;

/** Poll the governed status until the step's OWN node (`<runId>__<nodeId>`) settles. */
export async function waitForNode(s: Seeded, runId: string, nodeId: string, attempts = 90): Promise<any> {
  let node: any = null;
  for (let i = 0; i < attempts; i++) {
    const st = (await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${runId}`, s.t.headers)).body;
    node = (st?.nodes ?? []).find((n: any) => n.nodeId.endsWith(`__${nodeId}`)) ?? null;
    if (node && SETTLED.has(node.status)) return { node, status: st };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`node ${nodeId} of run ${runId} did not settle: ${JSON.stringify(node)}`);
}

/** Submit a step through the resolver and wait for its node to SUCCEED; returns the governed run id. */
export async function submitStepAndWait(s: Seeded, viewAnalysisId: string, nodeRef: string, operationId: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await s.api.post(stepUrl(viewAnalysisId, nodeRef, 'submit'), { operationId, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash, ...body }, s.t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.submitted, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
  const { node } = await waitForNode(s, res.body.runId, res.body.nodeId);
  expect(node.status, JSON.stringify(node)).toMatch(/SUCCEEDED|REUSED/);
  return res.body.runId as string;
}

/** The published library rule tagged `op:<operationId>` — the card the Screen step offers. */
export async function publishedRuleCode(s: Seeded, operationId: string): Promise<string> {
  const rules = await s.api.get('/api/v1/rules?limit=500', s.t.headers);
  const list: any[] = Array.isArray(rules.body) ? rules.body : rules.body?.rules ?? rules.body?.data ?? [];
  const rule = list.find((r) => (r.tags ?? []).includes(`op:${operationId}`) && r.status === 'published');
  expect(rule, `a published rule tagged op:${operationId}`).toBeTruthy();
  return rule.code as string;
}

/** The workspace/org the workbench reads from localStorage. */
export async function primeWorkspace(page: Page, s: Seeded): Promise<void> {
  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [s.t.workspaceId, s.t.orgId] as const);
}

/**
 * Population → confirm → Continue → Stratify on `response` (every level) → the
 * Split node becomes visible, whatever its holdout state already is (decided
 * from a PRIOR session, or undecided). `analysisId` null = the AXI-1719
 * preview path.
 *
 * AXI-1760 (FR4) — lifted out of `driveToScreen` so a rehydration spec can
 * mount fresh, reach the Split node, and assert what renders WITHOUT ever
 * clicking take/decline in this session (that click is exactly what a
 * rehydration test must not need).
 */
export async function driveToSplit(page: Page, projectId: string, analysisId: string | null): Promise<void> {
  await page.goto(`/projects/${projectId}/discovery-workbench${analysisId ? `?analysisId=${analysisId}` : ''}`);
  await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
  const confirm = page.getByTestId('population-confirm');
  await expect(confirm).toBeEnabled({ timeout: 60_000 });
  await confirm.click();
  await page.getByTestId('population-continue').click();
  const field = page.getByTestId('stratify-partition-field');
  await expect(field).toBeVisible({ timeout: 30_000 });
  await field.getByRole('radio', { name: /response/i }).click();
  await page.getByTestId('stratify-select-all-levels').click();
  await page.getByRole('button', { name: 'Run rule' }).click();
  await expect(page.getByTestId('workbench-split-node')).toBeVisible({ timeout: 30_000 });
}

/**
 * Population → confirm → Continue → Stratify on `response` (every level) → decline the
 * holdout → the Screen node. `analysisId` null = the AXI-1719 preview path.
 */
export async function driveToScreen(page: Page, projectId: string, analysisId: string | null): Promise<void> {
  await driveToSplit(page, projectId, analysisId);
  await page.getByTestId('split-decline-holdout').click();
  if (analysisId) {
    // AXI-1750 (R12): in LIVE mode the decline is a governed record with a
    // reason — the button opens a modal instead of declining immediately
    // (the PREVIEW path below still declines on the one click, unchanged).
    await page.getByTestId('split-decline-reason-input').fill('e2e: exploratory arm, holdout not needed');
    await page.getByTestId('split-decline-confirm').click();
  }
  await expect(page.getByTestId('workbench-screen-node')).toBeVisible({ timeout: 30_000 });
}

/** Run the plan-step screen rule in one click and wait for the LIVE rows to land on the result node. */
export async function runLiveScreen(page: Page, screenRuleCode: string): Promise<void> {
  await page.getByTestId('screen-choose-rule').click();
  await page.getByTestId(`screen-rule-run-${screenRuleCode}`).click();
  const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
  await expect(result.getByTestId('screen-result-count')).toContainText(`${MEASUREMENTS.length} screened`, { timeout: 240_000 });
  await expect(result.getByTestId('screen-result-badge')).toHaveText('live');
}
