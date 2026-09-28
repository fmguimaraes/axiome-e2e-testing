import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { adminApi, asList, sleep, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureAnalysis, ingestFixture, type Analysis, type Tenant } from '../AXI-1400/harness/seed';
import { ReviewWorld, send } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1810 (epic AXI-1762 — EC8, FR23, FR27, FR33; SI-017, SI-045): a value the
 * workspace's AnalysisPolicy LOCKS is enforced on `POST /rule-runs` and
 * `POST /rule-runs/preflight` — not just shown locked by the resolver. A
 * submission WITHOUT `valueOrigins` that overrides a lock is refused naming the
 * parameter; an omitted locked value is filled from the policy and recorded as
 * a `locked_policy` origin; a run whose values did not change keeps its
 * fingerprint (it DEDUPs onto the pre-policy run).
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §19.
 *
 * API-level, LLM-free, against a REAL gateway → organization-service →
 * bio-compute: the fill and the fingerprint scenarios need a COMPLETED run over a
 * profiled referent. The operation is `stats.unpaired_ttest` over the AXI-1400
 * `grouped_comparisons.csv` fixture (a two-level `arm` column, a numeric
 * `score`), cited through its system carrier `STAT-UNPAIRED-TTEST` (approved
 * here when it is not already — AXI-1768 seeding never publishes).
 *
 * Each scenario group runs in its OWN freshly created workspace: a policy is
 * per-workspace, append-only and its latest version applies, so sharing a
 * workspace would let one scenario's policy leak into another's.
 */

const CARRIER = 'STAT-UNPAIRED-TTEST';
const OPERATION = 'stats.unpaired_ttest';
const FIXTURE = 'grouped_comparisons.csv';
const CODE = 'LOCKED_POLICY_VALUE_REFUSED';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'DEDUPED']);

interface Scope extends Tenant {
  datasetId: string;
  analysis: Analysis;
}

interface RunRow {
  id: string;
  status: string;
  valueOrigins: { params: Record<string, { value: unknown; origin: string }> } | null;
  runFingerprint?: string | null;
  statusMessage?: string | null;
}

test.describe.configure({ mode: 'serial' });

let api: Api;
let orgId: string;
let ruleId: string;

const unique = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function ok<T = any>(res: Promise<{ status: number; body: T }>, label: string): Promise<T> {
  const r = await res;
  expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

/**
 * AXI-1768: an unapproved carrier is not offered. Walk it through review
 * (idempotent). Its content is Claude-authored, so the submitter may not approve
 * it (AXI-1765): a SECOND platform admin holding `rule:publish` — a throwaway
 * user promoted for this call and demoted again in `finally`, the AXI-1771
 * recipe — approves it.
 */
async function ensureApproved(code: string): Promise<string> {
  const library = (await ok(api.get('/api/v1/rules?scope=system&limit=200'), 'library')).data as Array<{ id: string; code: string }>;
  const rule = library.find((r) => r.code === code);
  expect(rule, `${code} is boot-seeded`).toBeDefined();
  const id = rule!.id;
  let detail = await ok(api.get(`/api/v1/rules/${id}`), 'rule');
  if (detail.status === 'published') return id;
  expect(detail.status, `${code} carries registry guidance, so it is at least checked`).not.toBe('draft');
  if (detail.status === 'checked') {
    await ok(api.post(`/api/v1/rules/${id}/submit-for-review`, {}), 'submit-for-review');
    detail = await ok(api.get(`/api/v1/rules/${id}`), 'rule');
  }
  const world = await ReviewWorld.create();
  let approverApi: APIRequestContext | undefined;
  let approverId: string | undefined;
  try {
    const publisherRole = await world.role('locked-policy-1810-approver', ['rule:read', 'rule:publish']);
    const actor = await world.actor('locked-policy-1810-approver', publisherRole);
    approverId = actor.userId;
    await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
    const login = await apiRequest.newContext();
    const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: 'AXI1765-e2e-pw!' });
    await login.dispose();
    approverApi = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
    const approved = await send(approverApi, 'post', `/api/v1/rules/${id}/approve`, {
      note: 'AXI-1810 e2e — the locked-policy runs need an offered carrier.',
      expectedContentHash: detail.review.contentHash,
    });
    expect(approved.status).toBe('published');
  } finally {
    await approverApi?.dispose();
    if (approverId) await send(world.admin, 'patch', `/api/v1/users/${approverId}`, { role: 'USER' }).catch(() => undefined);
    await world.dispose();
  }
  return id;
}

async function makeScope(label: string): Promise<Scope> {
  const ws = await ok(api.post('/api/v1/workspaces', { name: unique(label), type: 'internal', ownerOrganizationId: orgId }), 'workspace');
  const workspaceId = ws.id as string;
  const headers = workspaceHeader(workspaceId);
  const project = await ok(api.post('/api/v1/projects', { name: unique(`${label} project`), workspaceId }, headers), 'project');
  const tenant: Tenant = { orgId, workspaceId, projectId: project.id, ruleId, headers };
  const datasetId = await ingestFixture(api, tenant, FIXTURE);
  const analysis = await ensureAnalysis(api, tenant, unique(`${label} analysis`), datasetId);
  return { ...tenant, datasetId, analysis };
}

async function lockPolicy(scope: Scope, entries: Record<string, { value: unknown; locked: boolean }>): Promise<void> {
  await ok(api.post(`/api/v1/workspaces/${scope.workspaceId}/analysis-policy`, { entries: { [OPERATION]: entries } }, scope.headers), 'author policy');
}

const runBody = (scope: Scope, operationParams: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ruleId,
  runKind: 'STATISTICAL',
  operationId: OPERATION,
  operationParams,
  roleBindings: { groupColumn: 'arm' },
  pivot: { valueColumns: ['score'] },
  projectId: scope.projectId,
  workspaceId: scope.workspaceId,
  datasetId: scope.datasetId,
  snapshotId: scope.analysis.snapshotId,
  viewAnalysisId: scope.analysis.analysisId,
  scope: 'FILTERED',
  ...extra,
});

/** Submit, retrying only while the fresh referent's profile is still being computed. */
async function submit(scope: Scope, operationParams: Record<string, unknown>) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await api.post('/api/v1/rule-runs', runBody(scope, operationParams), scope.headers);
    if (!(res.status === 400 && /profil/i.test(JSON.stringify(res.body)))) return res;
    await sleep(2000);
  }
  throw new Error('the referent never finished profiling');
}

async function terminal(scope: Scope, ruleRunId: string): Promise<RunRow> {
  for (let i = 0; i < 90; i++) {
    const rr = await api.get(`/api/v1/rule-runs/${ruleRunId}`, scope.headers);
    if (TERMINAL.has(rr.body?.status)) return rr.body as RunRow;
    await sleep(2000);
  }
  throw new Error(`run ${ruleRunId} did not reach a terminal status`);
}

/**
 * The one result row. `GET /rule-runs/:id` does not project `operationParams`,
 * so the value a run was EXECUTED with is read off its result: for a t-test,
 * `alternative: greater` yields a one-sided interval (`ciHigh` null), while
 * `two_sided` yields both bounds.
 */
async function resultRow(scope: Scope, ruleRunId: string): Promise<{ ciLow: number | null; ciHigh: number | null; pValue: number }> {
  const table = await ok(api.get(`/api/v1/rule-runs/${ruleRunId}/table`, scope.headers), 'result table');
  expect(table.rows, 'one result row').toHaveLength(1);
  return table.rows[0];
}

async function runCount(scope: Scope): Promise<number> {
  return asList((await api.get(`/api/v1/rule-runs?workspaceId=${scope.workspaceId}&limit=100`, scope.headers)).body).length;
}

const GROUPS = { groupFrom: 'A', groupTo: 'B' };

let lockScope: Scope;
let pinScope: Scope;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  api = await adminApi();
  const orgs = asList((await api.get('/api/v1/organizations?limit=100')).body);
  orgId =
    orgs.find((o: any) => o.name === 'AXI-1810 Locked Policy Org')?.id ??
    (await ok(api.post('/api/v1/organizations', { name: 'AXI-1810 Locked Policy Org', type: 'biotech' }), 'org')).id;
  ruleId = await ensureApproved(CARRIER);
  lockScope = await makeScope('AXI-1810 lock');
  pinScope = await makeScope('AXI-1810 pin');
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1810 locked AnalysisPolicy values on POST /rule-runs (API)', () => {
  test.describe.configure({ timeout: 300_000 });

  test('19.3.1 AC EC8 — a submission WITHOUT valueOrigins that overrides a locked parameter is refused naming it, and writes no run @SI-017 @SI-045', async () => {
    await lockPolicy(lockScope, { alternative: { value: 'greater', locked: true } });
    const before = await runCount(lockScope);

    const res = await submit(lockScope, { ...GROUPS, alternative: 'less' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    const message = String(res.body?.message ?? JSON.stringify(res.body));
    expect(message).toMatch(new RegExp(`^${CODE}: operationParams\\.alternative is locked by the workspace analysis policy \\(version \\d+\\) to "greater"; the submission carries "less"`));
    expect(res.body?.ruleRunId ?? null).toBeFalsy();
    expect(await runCount(lockScope)).toBe(before);
  });

  test('19.3.2 AC FR20 — preflight refuses exactly what execute refuses @SI-017 @SI-045', async () => {
    const res = await api.post('/api/v1/rule-runs/preflight', runBody(lockScope, { ...GROUPS, alternative: 'less' }), lockScope.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(String(res.body?.message ?? '')).toContain(`${CODE}: operationParams.alternative is locked`);

    // The same submission without the override dry-runs clean of any lock refusal.
    const clean = await api.post('/api/v1/rule-runs/preflight', runBody(lockScope, GROUPS), lockScope.headers);
    expect(clean.status, JSON.stringify(clean.body)).toBeLessThan(300);
    expect(JSON.stringify(clean.body)).not.toContain(CODE);
  });

  test('19.3.3 FR23 FR27 — an omitted locked parameter is filled from the policy, runs with it, and is recorded as a locked_policy origin @SI-017 @SI-045', async () => {
    const res = await submit(lockScope, GROUPS);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const row = await terminal(lockScope, res.body.ruleRunId);
    expect(row.status, row.statusMessage ?? '').toBe('SUCCEEDED');
    expect(row.valueOrigins?.params.alternative).toEqual({ value: 'greater', origin: 'locked_policy' });
    // It RAN with the filled value: a one-sided (greater) interval has no upper bound.
    const result = await resultRow(lockScope, row.id);
    expect(typeof result.ciLow).toBe('number');
    expect(result.ciHigh).toBeNull();

    // Submitting the locked value itself is not an override: accepted, and it is the same run.
    const equal = await submit(lockScope, { ...GROUPS, alternative: 'greater' });
    expect(equal.status, JSON.stringify(equal.body)).toBeLessThan(300);
    expect(equal.body.status, JSON.stringify(equal.body)).toBe('DEDUPED');
    expect(equal.body.dedupedFromRunId).toBe(row.id);
  });

  test('19.3.4 FR33 EC15 — a run whose values do not change keeps its fingerprint under a policy that locks them @SI-017 @SI-045', async () => {
    // Before any policy: the baseline run.
    const baseline = await submit(pinScope, GROUPS);
    expect(baseline.status, JSON.stringify(baseline.body)).toBeLessThan(300);
    const base = await terminal(pinScope, baseline.body.ruleRunId);
    expect(base.status, base.statusMessage ?? '').toBe('SUCCEEDED');
    expect(base.valueOrigins).toBeNull();
    expect(base.runFingerprint, 'a SUCCEEDED run carries its fingerprint').toBeTruthy();
    const baseResult = await resultRow(pinScope, base.id);
    expect(typeof baseResult.ciHigh, 'two_sided (the registry default) has both bounds').toBe('number');

    // Lock the value the run already carries (groupFrom) and a parameter AT its
    // registry default the run omits (alternative = two_sided): same values, so
    // the identical submission must dedup onto the baseline — same fingerprint.
    await lockPolicy(pinScope, { groupFrom: { value: 'A', locked: true }, alternative: { value: 'two_sided', locked: true } });
    const locked = await submit(pinScope, GROUPS);
    expect(locked.status, JSON.stringify(locked.body)).toBeLessThan(300);
    expect(locked.body.status, JSON.stringify(locked.body)).toBe('DEDUPED');
    expect(locked.body.dedupedFromRunId).toBe(base.id);
    const dedupedRow = (await ok(api.get(`/api/v1/rule-runs/${locked.body.ruleRunId}`, pinScope.headers), 'deduped row')) as RunRow;
    // The lock is still RECORDED even though nothing was written into the params.
    expect(dedupedRow.valueOrigins?.params).toMatchObject({
      groupFrom: { value: 'A', origin: 'locked_policy' },
      alternative: { value: 'two_sided', origin: 'locked_policy' },
    });

    // Contrast: a lock that CHANGES a value is a different run — never deduped onto the baseline.
    await lockPolicy(pinScope, { alternative: { value: 'greater', locked: true } });
    const changed = await submit(pinScope, GROUPS);
    expect(changed.status, JSON.stringify(changed.body)).toBeLessThan(300);
    expect(changed.body.dedupedFromRunId ?? null).not.toBe(base.id);
    const changedRow = await terminal(pinScope, changed.body.ruleRunId);
    expect(changedRow.status, changedRow.statusMessage ?? '').toBe('SUCCEEDED');
    expect(changedRow.runFingerprint).toBeTruthy();
    expect(changedRow.runFingerprint).not.toBe(base.runFingerprint);
    expect((await resultRow(pinScope, changedRow.id)).ciHigh).toBeNull();
  });
});
