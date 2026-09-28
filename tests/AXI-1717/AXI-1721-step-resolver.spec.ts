import { test, expect } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
// AXI-1800: the ONE drive to the Screen node lives in the shared harness. This spec used to keep a
// private copy, which never learned AXI-1750's governed decline (reason + confirm) nor AXI-1793's
// restore fast path and so stalled on the open modal in LIVE mode. Never fork it again.
import { driveToScreen } from './harness/live-workbench';
import {
  ensureTenant, ensureProject, ingestFixture, datasetVersionHash, ensureDefaultAnalysis, createViewAnalysis, bindEnvelope, ensureApprovedDiscoveryConfig,
} from '../AXI-1507/harness/seed';

/**
 * AXI-1721 — Step resolver and next-step table: one-click fully bound steps (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 11.
 * Tags: @SI-045 (guided-analysis: the resolver), @SI-046 (front: the Screen/Cutoff steps live),
 *       @SI-002 @SI-010 (the contract and the gateway edge).
 *
 * REAL BACKEND, LLM-FREE. Everything here is seeded through the AXI-1507 harness (the nine-step
 * plan is a TEMPLATE instantiation, `POST /discovery/plans`, no planner call) on the Riaz 2017
 * immune fixture: 27 patients, `response` R/NR, `patient_id`, pre-treatment gene measurements.
 * Needs the stack on the AXI-1721 branches (`…/steps/:nodeRef/resolve|submit` routes); the
 * specs FAIL, never skip, when the routes are absent — a stack off the branch is an infra fault.
 *
 * Two describes:
 *  - API: FR7/FR8/FR9/FR11/FR12/FR13, NFR5, NFR8, EC3-ish refusals, tenancy (SI-045/002/010).
 *  - UI: the AXI-1719 mock's Screen and Cutoff steps made DYNAMIC (`?analysisId=`), SI-046.
 */

const FIXTURE = 'riaz2017_immune_wide.csv';
const PROJECT_NAME = 'AXI-1721 Step Resolver';
/** One container per run: a view analysis holds at most ONE plan instance (D.8), so a re-run needs its own. */
const LABEL = `axi-1721-${Date.now().toString(36)}`;
const MEASUREMENTS = ['CD27_pre', 'CD274_pre', 'CD8A_pre', 'CXCL9_pre', 'GZMB_pre', 'IFNG_pre', 'PDCD1_pre', 'STAT1_pre'];
const SCREEN_OP = 'stats.screen_shortlist';
const CUTOFF_OP = 'stats.cutoff_roc_youden';
const SPLIT_OP = 'split.exploration_holdout';
const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED']);

interface Seeded {
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
const RIAZ_ROLES = {
  outcome: { state: 'declared', column: 'response', outcomeKind: 'binary' },
  subject: { state: 'declared', column: 'patient_id' },
  timepoint: { state: 'declared_uncaptured', reason: 'AXI-1721 e2e: pre-treatment only' },
  representation: { state: 'declared_uncaptured', reason: 'AXI-1721 e2e: bulk expression' },
  batch: { state: 'declared_uncaptured', reason: 'AXI-1721 e2e: none recorded' },
  site: { state: 'declared_uncaptured', reason: 'AXI-1721 e2e: single site' },
};

/**
 * The mock's Stratify step is the EXISTING statistical run-config modal, whose referent gate
 * needs a semantic profile whose field mappings match the subject key (`patient_id`). The
 * seeded `immuno_oncology` profile's aliases match the fixture's raw column name, so assigning
 * it to the project is enough — the same move the AXI-1435 harness makes. Idempotent.
 */
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
  const t = await ensureTenant(api);
  const projectId = await ensureProject(api, t, PROJECT_NAME);
  const datasetId = await ingestFixture(api, t, FIXTURE);
  const hash = await datasetVersionHash(api, t, datasetId);
  await ensureApprovedDiscoveryConfig(api, t);
  await ensureDefaultAnalysis(api, t, projectId, datasetId); // links the dataset to the project (idempotent)
  await ensureSubjectKeyMapped(api, t, projectId);

  // Two containers on the same dataset, each with its own plan instance (D.8: one per analysis).
  // Screen R→NR over the measurements, no split taken. LLM-free (`POST /discovery/plans`, a
  // TEMPLATE instantiation). The OPEN one declares no positive outcome class — the template then
  // records the cutoff analyses as declined and the workbench's cutoff step waits for the author to
  // NAME the class (FR12/FR13, the AXI-1723 pick). The DECLARED one names `R`, so its cutoff node
  // already carries `positiveGroup` and the step binds it from upstream (FR8).
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
  const viewAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `${LABEL} — step resolver (open)`);
  const instanceRunId = await instantiate(viewAnalysisId, LABEL);
  const declaredAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `${LABEL} — step resolver (declared R)`);
  const declaredInstanceRunId = await instantiate(declaredAnalysisId, `${LABEL}-declared`, 'R');

  // AXI-1720 roles, confirmed — the carrier the resolver reads through `DatasetRolesService.findConfirmed`,
  // keyed by (workspace, dataset), so one confirmation serves both containers. (The roles route answers
  // only for an analysis holding a discovery plan instance, hence after the plan.)
  const rolesUrl = `/api/v1/discovery/analyses/${viewAnalysisId}/datasets/${datasetId}/roles`;
  const current = await api.get(rolesUrl, t.headers);
  expect(current.status, `GET roles: ${JSON.stringify(current.body)}`).toBe(200);
  if (!current.body.confirmed) {
    const put = await api.ctx.put(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${rolesUrl}`, { data: { roles: RIAZ_ROLES, confirm: true }, headers: t.headers });
    expect(put.status(), await put.text()).toBeLessThan(300);
  }
  return { api, t, projectId, datasetId, viewAnalysisId, hash, instanceRunId, declaredAnalysisId, declaredInstanceRunId };
}

const stepUrl = (va: string, nodeRef: string, action: 'resolve' | 'submit') => `/api/v1/discovery/analyses/${va}/steps/${nodeRef}/${action}`;

async function waitForNode(s: Seeded, runId: string, nodeId: string, attempts = 90): Promise<any> {
  let node: any = null;
  for (let i = 0; i < attempts; i++) {
    const st = (await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${runId}`, s.t.headers)).body;
    node = (st?.nodes ?? []).find((n: any) => n.nodeId.endsWith(`__${nodeId}`)) ?? null;
    if (node && SETTLED.has(node.status)) return { node, status: st };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`node ${nodeId} of run ${runId} did not settle: ${JSON.stringify(node)}`);
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('AXI-1721 - step resolver API (real backend)', { tag: ['@SI-045', '@SI-002', '@SI-010'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let screenRunId: string;

  test.beforeAll(async () => { s = await seed(); });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR7 FR8 FR9 AC3 - the screen step resolves fully bound: every value carries its source, nothing is asked of the user', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), { operationId: SCREEN_OP, datasetId: s.datasetId }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ nodeId: 'd6', stepId: 'screen', operationId: SCREEN_OP, fullyBound: true, disabledReason: null, unresolved: [] });
    const byName = Object.fromEntries(res.body.bindings.map((b: any) => [b.name, b]));
    expect(byName.comparisons).toMatchObject({ slot: 'param', value: [{ from: 'R', to: 'NR' }], source: 'upstream:d6', sourceKind: 'upstream' });
    expect(byName.rankBy).toMatchObject({ value: 'qValue', source: 'upstream:d6' });
    expect(byName.groupColumn).toMatchObject({ slot: 'role', value: 'response', source: 'upstream:d6' });
    expect(byName.valueColumns).toMatchObject({ slot: 'pivot', value: MEASUREMENTS, source: 'upstream:d6' });
    for (const b of res.body.bindings) expect(b.source, `${b.name} carries a full FR9 tag`).toMatch(/^(user|upstream:[^:]+|role:[^:]+|policy:.+)$/);
    expect(res.body.producesOutputTypes).toContain('shortlist_row');
  });

  test('FR8 FR9 FR13 - the split step with no upstream node binds from the plan, the dataset ROLES and the approved POLICY - three sources, one step; since R12 the seed is server-resolved so the step is fully bound', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'resolve'), { operationId: SPLIT_OP, datasetId: s.datasetId }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byName = Object.fromEntries(res.body.bindings.map((b: any) => [b.name, b]));
    expect(byName.questionKey).toMatchObject({ value: LABEL, source: 'upstream:plan' });
    expect(byName.patientKey).toMatchObject({ slot: 'role', value: 'patient_id', source: 'role:subject', sourceKind: 'role' });
    expect(byName.outcomeColumn).toMatchObject({ slot: 'role', value: 'response', source: 'role:outcome', sourceKind: 'role' });
    expect(byName.holdoutRatio).toMatchObject({ value: 0.3, source: `policy:${SPLIT_OP}.holdoutRatio`, sourceKind: 'policy' });
    expect(byName.minPatientsPerArm).toMatchObject({ value: 20, source: `policy:${SPLIT_OP}.minPatientsPerArm` });
    expect(byName.minPatientsPerClass).toMatchObject({ value: 5, source: `policy:${SPLIT_OP}.minPatientsPerClass` });
    // R12 (AXI-1750) changed this contract. The kernel REQUIRES the seed; before R12 no
    // one could declare it, so the resolver left it OPEN and the step was not fully bound.
    // Since R12 `SplitDecisionService.resolveSeed` resolves it server-side, idempotently
    // per question, so the step resolves fully bound with nothing left to ask.
    expect(res.body.fullyBound).toBe(true);
    expect(res.body.disabledReason).toBeNull();
    expect(res.body.unresolved).toEqual([]);
    // The seed must be a real, stated value — never absent, never a placeholder constant
    // (the fabrication AXI-1761 removed from the front end's display path).
    expect(byName.splitSeed).toMatchObject({ name: 'splitSeed', slot: 'param' });
    expect(typeof byName.splitSeed.value, 'the seed is a stated number').toBe('number');
    // `randomInt(0, MAX_SEED)` is half-open, so 0 is a legal seed — asserting > 0 would
    // flake once in MAX_SEED runs. What matters is that it is a stated integer in range,
    // not that it is non-zero.
    expect(Number.isInteger(byName.splitSeed.value), 'the seed is an integer').toBe(true);
    expect(byName.splitSeed.value).toBeGreaterThanOrEqual(0);
    // ⚠ The tag below is pinned as CURRENT BEHAVIOUR, not as endorsed behaviour: the seed is
    // minted per question with `randomInt`, yet binds as `policy:` because FR9's source
    // vocabulary has no kind for a server-generated value. Filed as AXI-1781 (D1), together
    // with the fact that this preview call PERSISTS the seed (D2). When AXI-1781 lands, this
    // expectation changes to the new source kind — it is here so that change is deliberate
    // and visible, rather than silently absorbed.
    expect(byName.splitSeed.source).toBe(`policy:${SPLIT_OP}.splitSeed`);
    expect(byName.splitSeed.sourceKind).toBe('policy');
  });

  test('NFR5 - the same inputs resolve to the same answer, twice', async () => {
    const body = { operationId: SCREEN_OP, datasetId: s.datasetId };
    const a = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), body, s.t.headers);
    const b = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), body, s.t.headers);
    expect(a.body).toEqual(b.body);
  });

  test('FR10 - a selection of a kind the operation does not accept is refused as a disabled step, never coerced', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), {
      operationId: SCREEN_OP, datasetId: s.datasetId, selection: { kind: 'candidate', nodeId: 'd6', runId: s.instanceRunId, values: {} },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fullyBound).toBe(false);
    expect(res.body.disabledReason).toContain('does not accept a candidate selection');
  });

  test('FR11 FR9 AC4 - a fully bound screen submits in one click; the governed run records the source tags beside the node', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'submit'), { operationId: SCREEN_OP, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ submitted: true, viewAnalysisId: s.viewAnalysisId, nodeId: 'd6' });
    expect(res.body.bindingSources).toMatchObject({ comparisons: 'upstream:d6', groupColumn: 'upstream:d6', valueColumns: 'upstream:d6', rankBy: 'upstream:d6' });
    screenRunId = res.body.runId;
    const { node, status } = await waitForNode(s, screenRunId, 'd6');
    expect(node.status, `screen node: ${JSON.stringify(node)} / run ${status.status} ${status.failReason ?? ''}`).toMatch(/SUCCEEDED|REUSED/);
    expect(node.bindingSources, 'FR9 on the status projection').toEqual(res.body.bindingSources);
    expect(status.ruleRunId, 'the screen produced a rule run (its table)').toBeTruthy();
    const table = await s.api.get(`/api/v1/rule-runs/${status.ruleRunId}/table?page=1&limit=50`, s.t.headers);
    expect(table.status, JSON.stringify(table.body)).toBe(200);
    expect(table.body.rows.length, 'one row per measurement').toBe(MEASUREMENTS.length);
  });

  test('FR12 FR13 EC4-shape - a shortlist row binds the cutoff\'s marker from upstream; positiveGroup is the one unresolved slot, with its allowed levels', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ nodeId: 'd7', stepId: 'cutoff', operationId: CUTOFF_OP, fullyBound: false, disabledReason: null });
    const byName = Object.fromEntries(res.body.bindings.map((b: any) => [b.name, b]));
    expect(byName.valueColumns).toMatchObject({ slot: 'pivot', value: ['CD8A_pre'], source: 'upstream:d6' });
    expect(byName.groupColumn).toMatchObject({ value: 'response' });
    expect(res.body.unresolved.map((u: any) => u.name)).toEqual(['positiveGroup']);
    expect(res.body.unresolved[0].domain).toEqual({ kind: 'levels', column: 'response', values: ['NR', 'R'] });
    expect(res.body.acceptsInputTypes).toContain('shortlist_row');
  });

  test('FR12 - a shortlist row naming a marker the screen never ranked disables the step - a typed value cannot wear an upstream tag', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'NOT_A_MARKER' } },
    }, s.t.headers);
    expect(res.status).toBe(200);
    expect(res.body.fullyBound).toBe(false);
    expect(res.body.disabledReason).toContain('never ranked');
  });

  test('FR8 FR13 - a pick inside the allowed domain binds as `user` and completes the cutoff; a pick outside it stays unresolved', async () => {
    const selection = { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } };
    const ok = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), { operationId: CUTOFF_OP, datasetId: s.datasetId, selection, picks: { positiveGroup: 'R' } }, s.t.headers);
    expect(ok.body.fullyBound, JSON.stringify(ok.body.unresolved)).toBe(true);
    expect(ok.body.bindings.find((b: any) => b.name === 'positiveGroup')).toMatchObject({ value: 'R', source: 'user', sourceKind: 'user' });
    const bad = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), { operationId: CUTOFF_OP, datasetId: s.datasetId, selection, picks: { positiveGroup: 'Responder' } }, s.t.headers);
    expect(bad.body.fullyBound).toBe(false);
    expect(bad.body.unresolved[0]).toMatchObject({ name: 'positiveGroup' });
    expect(bad.body.unresolved[0].reason).toContain('outside its allowed domain');
    expect(bad.body.unresolved[0].domain).toEqual({ kind: 'levels', column: 'response', values: ['NR', 'R'] });
  });

  test('FR8 FR9 - a plan that DECLARED the positive class binds positiveGroup from its own cutoff node (upstream:d7), fully bound with no pick; a pick still outranks it', async () => {
    // The declared container has no screen run yet: its instance's d6 node is the recorded upstream, and it
    // declares the measurement family, so a shortlist row naming one of them is a row the screen WILL rank.
    const selection = { kind: 'shortlist_row', nodeId: 'd6', runId: s.declaredInstanceRunId, values: { marker: 'CD8A_pre' } };
    const res = await s.api.post(stepUrl(s.declaredAnalysisId, 'cutoff', 'resolve'), { operationId: CUTOFF_OP, datasetId: s.datasetId, selection }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ nodeId: 'd7', fullyBound: true, disabledReason: null, unresolved: [] });
    const byName = Object.fromEntries(res.body.bindings.map((b: any) => [b.name, b]));
    expect(byName.valueColumns).toMatchObject({ value: ['CD8A_pre'], source: 'upstream:d6' });
    expect(byName.positiveGroup).toMatchObject({ value: 'R', source: 'upstream:d7', sourceKind: 'upstream' });
    expect(byName.groupColumn).toMatchObject({ value: 'response', source: 'upstream:d7' });
    const picked = await s.api.post(stepUrl(s.declaredAnalysisId, 'cutoff', 'resolve'), { operationId: CUTOFF_OP, datasetId: s.datasetId, selection, picks: { positiveGroup: 'NR' } }, s.t.headers);
    expect(picked.body.fullyBound).toBe(true);
    expect(picked.body.bindings.find((b: any) => b.name === 'positiveGroup')).toMatchObject({ value: 'NR', source: 'user' });
  });

  test('FR11 NFR8 - submitting an unresolved step is REFUSED as an output (200-family, reasons + the resolution), no run created', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'submit'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, projectId: s.projectId, selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted).toBe(false);
    expect(res.body.reasons.some((r: string) => r.includes('positiveGroup'))).toBe(true);
    expect(res.body.resolution).toMatchObject({ nodeId: 'd7', fullyBound: false });
  });

  test('NFR8 tenancy - workspaceId in the body is refused by the pipe (400); another workspace sees no instance (404)', async () => {
    const forged = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), { operationId: SCREEN_OP, datasetId: s.datasetId, workspaceId: s.t.workspaceId }, s.t.headers);
    expect(forged.status).toBe(400);
    const other = await s.api.post('/api/v1/workspaces', { name: 'AXI-1721 Other Tenant', type: 'internal', ownerOrganizationId: s.t.orgId });
    const otherId = other.body?.id ?? (await s.api.get('/api/v1/workspaces?limit=100')).body.find?.((w: any) => w.name === 'AXI-1721 Other Tenant')?.id;
    expect(otherId, `other workspace: ${JSON.stringify(other.body)}`).toBeTruthy();
    const cross = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), { operationId: SCREEN_OP, datasetId: s.datasetId }, workspaceHeader(otherId));
    expect([403, 404], JSON.stringify(cross.body)).toContain(cross.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('AXI-1721 - Screen and Cutoff steps live in the workbench (UI, real backend)', { tag: ['@SI-046', '@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  let s: Seeded;
  let screenRuleCode: string;

  test.beforeAll(async () => {
    s = await seed();
    const rules = await s.api.get('/api/v1/rules?limit=500', s.t.headers);
    const list: any[] = Array.isArray(rules.body) ? rules.body : rules.body?.rules ?? rules.body?.data ?? [];
    const rule = list.find((r) => (r.tags ?? []).includes(`op:${SCREEN_OP}`) && r.status === 'published');
    expect(rule, `a published rule tagged op:${SCREEN_OP}`).toBeTruthy();
    screenRuleCode = rule.code;
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    }, [s.t.workspaceId, s.t.orgId] as const);
  });

  test('AC3 AC4 FR7 FR9 FR11 - the plan-step rule shows its bindings and sources, runs in ONE click, and the result node fills from the real table', async ({ page }) => {
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    await expect(page.getByTestId('screen-face-live')).toBeVisible();
    await page.getByTestId('screen-choose-rule').click();
    const card = page.getByTestId(`screen-rule-${screenRuleCode}`);
    await expect(card.getByTestId(`screen-rule-live-${screenRuleCode}`)).toBeVisible();
    const bindings = card.getByTestId(`screen-rule-bindings-${screenRuleCode}`);
    await expect(bindings).toContainText('comparisons = R → NR (upstream d6)', { timeout: 30_000 });
    await expect(bindings).toContainText('groupColumn = response');
    await expect(card.getByTestId(`screen-rule-bound-${screenRuleCode}`)).toBeVisible();
    await expect(card.getByTestId(`screen-rule-unresolved-${screenRuleCode}`)).toHaveCount(0);
    // One click: no config modal, no typing.
    await card.getByTestId(`screen-rule-run-${screenRuleCode}`).click();
    await expect(page.getByTestId('workbench-screen-modal')).toHaveCount(0, { timeout: 30_000 });
    const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.getByTestId('screen-result-badge')).toContainText('live');
    // The pipeline's own rows land on the node once the step's node succeeds.
    await expect(result.getByTestId('screen-result-count')).toContainText(`${MEASUREMENTS.length} screened`, { timeout: 240_000 });
    await expect(result.getByTestId('screen-result-badge')).toHaveText('live');
  });

  test('FR10 FR12 FR13 - choosing a marker from the live run resolves the cutoff proposals against that shortlist row; positiveGroup waits for a pick with its levels', async ({ page }) => {
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    await page.getByTestId('screen-choose-rule').click();
    await page.getByTestId(`screen-rule-run-${screenRuleCode}`).click();
    const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
    await expect(result.getByTestId('screen-result-count')).toBeVisible({ timeout: 240_000 });
    await result.getByTestId('screen-result-expand').click();
    const table = page.getByTestId('screen-shortlist-table');
    await expect(table).toBeVisible();
    // Any ranked row: the shortlist filter defaults to passing rows; show all so a row exists regardless of the data.
    const allChip = page.getByTestId('screen-filter').getByRole('button', { name: /all/i });
    if (await allChip.count()) await allChip.click();
    await table.locator('tbody tr').first().click();
    await page.getByTestId('screen-choice-rationale').fill('AXI-1721 e2e: strongest separation in the live screen');
    await page.getByTestId('screen-choose-marker').click();
    await expect(page.getByTestId('marker-chosen')).toBeVisible({ timeout: 30_000 });
    const proposals = page.getByTestId('cutoff-proposals');
    await expect(proposals).toBeVisible();
    const row = proposals.getByTestId(`cutoff-op-${CUTOFF_OP}`);
    await expect(row.getByTestId(`cutoff-op-bindings-${CUTOFF_OP}`)).toContainText('(upstream d6)', { timeout: 30_000 });
    const open = row.getByTestId(`cutoff-op-unresolved-${CUTOFF_OP}`);
    await expect(open).toContainText('positiveGroup');
    await expect(open).toContainText('NR, R');
    await expect(row.getByTestId(`cutoff-op-run-${CUTOFF_OP}`)).toBeDisabled();
    await expect(row.getByTestId(`cutoff-op-blocked-${CUTOFF_OP}`)).toHaveCount(0);
  });

  test('FR8 FR11 - on a plan that DECLARED the positive class the cutoff proposal is fully bound from upstream and runs in ONE click through governed execution', async ({ page }) => {
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    await page.getByTestId('screen-choose-rule').click();
    await page.getByTestId(`screen-rule-run-${screenRuleCode}`).click();
    const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
    await expect(result.getByTestId('screen-result-count')).toBeVisible({ timeout: 240_000 });
    await result.getByTestId('screen-result-expand').click();
    const table = page.getByTestId('screen-shortlist-table');
    await expect(table).toBeVisible();
    const allChip = page.getByTestId('screen-filter').getByRole('button', { name: /all/i });
    if (await allChip.count()) await allChip.click();
    await table.locator('tbody tr').first().click();
    await page.getByTestId('screen-choice-rationale').fill('AXI-1721 e2e: declared container');
    await page.getByTestId('screen-choose-marker').click();
    await expect(page.getByTestId('marker-chosen')).toBeVisible({ timeout: 30_000 });
    const row = page.getByTestId('cutoff-proposals').getByTestId(`cutoff-op-${CUTOFF_OP}`);
    const bindings = row.getByTestId(`cutoff-op-bindings-${CUTOFF_OP}`);
    await expect(bindings).toContainText('(upstream d6)', { timeout: 30_000 });
    await expect(bindings).toContainText('positiveGroup = R (upstream d7)');
    await expect(row.getByTestId(`cutoff-op-unresolved-${CUTOFF_OP}`)).toHaveCount(0);
    const run = row.getByTestId(`cutoff-op-run-${CUTOFF_OP}`);
    await expect(run).toBeEnabled();
    await run.click();
    // The accepted submit is the output here; the cutoff's result surface is AXI-1724's.
    await expect(row.getByTestId(`cutoff-op-submitted-${CUTOFF_OP}`)).toContainText('submitted', { timeout: 60_000 });
    await expect(row.getByTestId(`cutoff-op-refused-${CUTOFF_OP}`)).toHaveCount(0);
  });
});
