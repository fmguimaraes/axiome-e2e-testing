import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, sleep, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ReviewWorld, send } from './AXI-1765-rule-review-fixtures';
import { bindEnvelope, ensureApprovedDiscoveryConfig, type Tenant } from '../AXI-1507/harness/seed';
import { systemRuleCatalogue } from './seeded-rule-approval';

/**
 * AXI-1772 (epic AXI-1762 — FR18, FR19, FR28, FR29; EC16; NFR7, NFR9): the Run
 * rule picker's DETAIL PANE and its one-click **Run**, driven in a real browser
 * against a real gateway → organization-service → bio-compute, LLM-free.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §14.
 *
 * The referent is a PROFILED dataset (upload → ingestion → profiling), so the
 * resolver can bind from real facts:
 *   - `arm` (A/B) is the CONFIRMED `outcome` dataset role → `groupColumn` from
 *     the dataset role;
 *   - `score` is the only numeric column → `valueColumns` suggested;
 *   - a workspace AnalysisPolicy states Mann-Whitney's `groupFrom`/`groupTo` →
 *     policy defaults. Mann-Whitney is therefore FULLY BOUND (one-click Run);
 *     the unpaired t-test, with no policy, leaves its two levels open (Adjust
 *     parameters).
 *
 * Since AXI-1768 nothing is offered without an approval record and seeding never
 * publishes; since AXI-1769 a statistical carrier is Claude-authored at `checked`,
 * which its submitter may not approve. So `beforeAll` submits each carrier as the
 * bootstrap admin and approves it as a SECOND platform approver (promoted for
 * the file, demoted in `afterAll`) — exactly §11.3.4's walk.
 *
 * Every scenario runs in a DEDICATED workspace created here, so the policy and
 * roles it authors never move another spec's data.
 */

const MWU_OP = 'stats.mann_whitney_u';
const TTEST_OP = 'stats.unpaired_ttest';
const APPROVER_PASSWORD = 'AXI1765-e2e-pw!';
const CSV = [
  'patient_id,arm,score',
  ...Array.from({ length: 16 }, (_, i) => {
    const arm = i % 2 === 0 ? 'A' : 'B';
    const score = (arm === 'A' ? 10 : 14) + ((i * 7) % 5) + i / 10;
    return `P${String(i + 1).padStart(3, '0')},${arm},${score.toFixed(1)}`;
  }),
].join('\n');

interface Scope {
  orgId: string;
  workspaceId: string;
  projectId: string;
  datasetId: string;
  analysisId: string;
  /** A second plain analysis on the same dataset, never run on — 14.3.2's run moves `analysisId` onto its result snapshot. */
  pristineAnalysisId: string;
  headers: Record<string, string>;
}

interface Carrier {
  id: string;
  code: string;
  title: string;
}

interface Guidance {
  whatItDoes?: string;
  whenToUse?: string;
  whenNotToUse?: string;
  example?: string;
  youWillGet?: string;
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let api: Api;
let world: ReviewWorld;
let approver: { userId: string; api: APIRequestContext } | undefined;
let scope: Scope;
let mwu: Carrier;
let ttest: Carrier;

const unique = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function ok<T = any>(res: Promise<{ status: number; body: T }>, label: string): Promise<T> {
  const r = await res;
  expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

async function put(path: string, data: unknown, headers: Record<string, string>): Promise<any> {
  const res = await api.ctx.put(apiUrl(path), { data: data as any, headers });
  expect(res.status(), `PUT ${path}: ${await res.text()}`).toBeLessThan(300);
  return res.json();
}

async function until<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await sleep(2_000);
  }
  throw new Error(`${label}: timed out after ${timeoutMs} ms`);
}

/** A second platform approver holding rule:publish (a Claude-authored carrier is never approved by its submitter). */
async function secondApprover(): Promise<{ userId: string; api: APIRequestContext }> {
  const role = await world.role('picker-approver', ['rule:read', 'rule:publish']);
  const actor = await world.actor('picker-approver', role);
  await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
  const login = await apiRequest.newContext();
  const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: APPROVER_PASSWORD });
  await login.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
  return { userId: actor.userId, api: ctx };
}

/** The system carrier of `operationId`, walked to `published` through review (idempotent). */
async function ensurePublishedCarrier(operationId: string): Promise<Carrier> {
  // AXI-1809 (AXI-1822): the whole SYSTEM catalogue, every page.
  const library = (await systemRuleCatalogue((path) => ok(api.get(path), 'library'))) as unknown as Array<Carrier & { tags?: string[] | null }>;
  const carrier = library.find((r) => (r.tags ?? []).includes(`op:${operationId}`));
  expect(carrier, `${operationId} has a boot-seeded carrier`).toBeDefined();
  let detail = await ok(api.get(`/api/v1/rules/${carrier!.id}`), 'rule');
  if (detail.status !== 'published') {
    expect(['checked', 'in_review'], `${carrier!.code} is reviewable (status ${detail.status})`).toContain(detail.status);
    if (detail.status === 'checked') {
      await send(world.admin, 'post', `/api/v1/rules/${carrier!.id}/submit-for-review`);
      detail = await ok(api.get(`/api/v1/rules/${carrier!.id}`), 'rule');
    }
    approver ??= await secondApprover();
    const approved = await send(approver.api, 'post', `/api/v1/rules/${carrier!.id}/approve`, {
      note: 'AXI-1772 e2e — read the guidance against the executor.',
      expectedContentHash: detail.review.contentHash,
    });
    expect(approved.status).toBe('published');
  }
  return { id: carrier!.id, code: carrier!.code, title: carrier!.title };
}

/** The SERVED version's guidance, read off the version history (never the offered-rules read under test). */
async function servedGuidance(ruleId: string): Promise<Guidance> {
  const detail = await ok(api.get(`/api/v1/rules/${ruleId}`), 'rule');
  const versions = asList((await ok(api.get(`/api/v1/rules/${ruleId}/versions`), 'versions')) as any);
  const served = versions.find((v: any) => v.id === detail.servedVersion?.id);
  expect(served, 'the served version is listed').toBeDefined();
  return served.guidance as Guidance;
}

async function seedScope(): Promise<Scope> {
  const orgs = asList((await api.get('/api/v1/organizations?limit=100')).body);
  const orgId =
    orgs.find((o: any) => o.name === 'AXI-1772 Picker Org')?.id ??
    (await ok(api.post('/api/v1/organizations', { name: 'AXI-1772 Picker Org', type: 'biotech' }), 'org')).id;
  const ws = await ok(api.post('/api/v1/workspaces', { name: unique('AXI-1772 picker'), type: 'internal', ownerOrganizationId: orgId }), 'workspace');
  const workspaceId = ws.id as string;
  const headers = workspaceHeader(workspaceId);
  const project = await ok(api.post('/api/v1/projects', { name: unique('AXI-1772 picker project'), workspaceId }, headers), 'project');

  // Upload → finalize → ingestion ready (bio-compute) — the profiled referent.
  const init = await ok(
    api.post(`/api/v1/workspaces/${workspaceId}/datasets`, { organizationId: orgId, originalFilename: 'axi1772-arms.csv', contentType: 'text/csv' }, headers),
    'dataset',
  );
  const datasetId = init.dataset.id as string;
  const upload = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: CSV });
  expect(upload.ok, `presigned PUT ${upload.status}`).toBe(true);
  await ok(api.patch(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/finalize`, undefined, headers), 'finalize');
  await until('ingestion ready', async () => {
    const d = await api.get(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`, headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'failed') throw new Error(`ingestion failed: ${JSON.stringify(d.body.latestIngestion)}`);
    return status === 'ready' ? true : undefined;
  });

  await ok(api.post(`/api/v1/projects/${project.id}/datasets`, { datasetId }, headers), 'link dataset');
  const analysis = await ok(api.post('/api/v1/view-analyses', { projectId: project.id, datasetId, name: unique('AXI-1772 picker analysis') }, headers), 'analysis');

  // FR23: the outcome role binds the group column. Dataset roles are keyed by
  // (workspace, dataset), but the roles ROUTE answers only for an analysis that
  // holds a discovery plan instance — so a second analysis on the same dataset
  // hosts a template plan (LLM-free, `POST /discovery/plans`), and the picker
  // itself is opened on the plain analysis above.
  const tenant = { orgId, workspaceId, projectId: project.id, headers } as unknown as Tenant;
  const host = await ok(api.post('/api/v1/view-analyses', { projectId: project.id, datasetId, name: unique('AXI-1772 roles host') }, headers), 'roles host');
  await ensureApprovedDiscoveryConfig(api, tenant);
  const bound = await bindEnvelope(api, tenant, host.id);
  expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);
  const hash = (await ok(api.get(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`, headers), 'dataset')).fileHash;
  const planned = await api.post(
    '/api/v1/discovery/plans',
    {
      viewAnalysisId: host.id, projectId: project.id, datasetId, datasetVersionHash: hash,
      questionKey: unique('axi1772-roles-host'), question: 'Does the score differ between arms?',
      takeSplit: false, measurementColumns: ['score'], comparisons: [{ from: 'A', to: 'B' }], rankBy: 'qValue',
      outcomeColumn: 'arm', patientKeyColumn: 'patient_id',
    },
    headers,
  );
  expect(planned.status, `instantiate roles host: ${JSON.stringify(planned.body)}`).toBe(201);
  expect(planned.body.instantiated, `refused: ${JSON.stringify(planned.body.reasons)}`).toBe(true);

  const uncaptured = (reason: string) => ({ state: 'declared_uncaptured', reason });
  const declared = await put(
    `/api/v1/discovery/analyses/${host.id}/datasets/${datasetId}/roles`,
    {
      roles: {
        outcome: { state: 'declared', column: 'arm', outcomeKind: 'binary' },
        subject: { state: 'declared', column: 'patient_id' },
        timepoint: uncaptured('AXI-1772 e2e: single visit'),
        representation: uncaptured('AXI-1772 e2e: not a representation study'),
        batch: uncaptured('AXI-1772 e2e: one batch'),
        site: uncaptured('AXI-1772 e2e: one site'),
      },
      confirm: false,
    },
    headers,
  );
  await ok(
    api.post(`/api/v1/discovery/analyses/${host.id}/datasets/${datasetId}/roles/confirm`, { revision: declared.record.revision }, headers),
    'confirm roles',
  );

  // The comparison order for Mann-Whitney only — the t-test is left without one.
  await ok(
    api.post(
      `/api/v1/workspaces/${workspaceId}/analysis-policy`,
      { entries: { [MWU_OP]: { groupFrom: { value: 'A', locked: false }, groupTo: { value: 'B', locked: false } } } },
      headers,
    ),
    'analysis policy',
  );
  const pristine = await ok(api.post('/api/v1/view-analyses', { projectId: project.id, datasetId, name: unique('AXI-1772 picker pristine') }, headers), 'pristine analysis');
  return { orgId, workspaceId, projectId: project.id, datasetId, analysisId: analysis.id, pristineAnalysisId: pristine.id, headers };
}

/**
 * First-visit onboarding tours auto-start and NAVIGATE (the orientation tour
 * walks to Subjects), which pulls the page out from under the picker. Mark
 * every registered tour skipped for the admin the browser signs in as.
 */
const TOUR_IDS = ['orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration'];
async function silenceTours(): Promise<void> {
  for (const tourId of TOUR_IDS) {
    await put('/api/v1/onboarding-state', { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 }, {});
  }
}

async function openPicker(page: Page, analysisId: string = scope.analysisId): Promise<void> {
  // The app reads the active workspace/org from localStorage, not the URL (as in the AXI-1435 spec).
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [scope.workspaceId, scope.orgId] as const,
  );
  await page.goto(`/projects/${scope.projectId}/view-analyses/${analysisId}`);
  await page.getByRole('button', { name: 'Run rule' }).click();
  await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 30_000 });
}

function ruleRow(page: Page, carrier: Carrier) {
  return page.getByRole('radiogroup', { name: 'Rules you can run' }).getByRole('radio').filter({ hasText: carrier.code });
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  api = await adminApi();
  world = await ReviewWorld.create();
  mwu = await ensurePublishedCarrier(MWU_OP);
  ttest = await ensurePublishedCarrier(TTEST_OP);
  scope = await seedScope();
  await silenceTours();

  // Profiling runs after ingestion; wait until the resolver no longer reports EC4.
  await until('profile ready', async () => {
    const res = await api.post(
      '/api/v1/rule-runs/resolve',
      { ruleId: mwu.id, operationId: MWU_OP, workspaceId: scope.workspaceId, projectId: scope.projectId, datasetId: scope.datasetId },
      scope.headers,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.disabledReason ? undefined : res.body;
  });
});

test.afterAll(async () => {
  await approver?.api.dispose();
  if (approver) await send(world.admin, 'patch', `/api/v1/users/${approver.userId}`, { role: 'USER' }).catch(() => undefined);
  await world?.dispose();
  await api?.ctx.dispose();
});

test.describe('AXI-1772 rule picker detail pane and one-click run (browser)', () => {
  test('14.3.1 AC1 FR29 NFR7 — a click opens the pane: the SERVED guidance, readiness, default chart and review provenance; rows read what-it-does @SI-030 @SI-035', async ({ page }) => {
    const guidance = await servedGuidance(mwu.id);
    expect(guidance?.whatItDoes, 'the served carrier states what it does').toBeTruthy();

    await openPicker(page);
    const row = ruleRow(page, mwu);
    await expect(row).toBeVisible({ timeout: 30_000 });
    // FR29: the row's one line is the served what-it-does, not the templated question.
    await expect(row.getByTestId('rule-row-summary')).toHaveText(guidance.whatItDoes!);

    await row.click();
    await expect(row).toHaveAttribute('aria-checked', 'true');
    // The click opens the PANE — never the editor.
    const pane = page.getByTestId('rule-detail-pane');
    await expect(pane).toHaveAttribute('data-rule-code', mwu.code);
    await expect(page.getByRole('heading', { name: /^Configure / })).toHaveCount(0);

    for (const [key, text] of Object.entries(guidance)) {
      if (!text) continue;
      await expect(pane.locator(`[data-guidance-key="${key}"] dd`), key).toHaveText(text);
    }
    await expect(pane.getByTestId('rule-detail-chart')).toContainText('Default chart:');
    await expect(pane.getByTestId('rule-detail-provenance')).toContainText('AI-drafted.');
    await expect(pane.getByTestId('rule-detail-provenance')).toContainText(/Approved by .+ on /);
    await expect(pane.getByRole('status')).toHaveText('Ready to run', { timeout: 30_000 });
  });

  test('14.3.2 AC3 FR28 EC16 — fully bound and no BLOCK: one click on Run submits exactly the resolved values, and the run records their origins @SI-030 @SI-035', async ({ page }) => {
    await openPicker(page);
    await ruleRow(page, mwu).click();
    const pane = page.getByTestId('rule-detail-pane');
    await expect(pane.getByRole('status')).toHaveText('Ready to run', { timeout: 30_000 });

    // What the pane says it will use, each with its origin chip.
    const values = pane.getByTestId('rule-detail-values');
    await expect(values.locator('[data-value-key="role:groupColumn"]')).toContainText('arm');
    await expect(values.locator('[data-value-key="role:groupColumn"] [data-testid="origin-chip"]')).toHaveAttribute('data-origin', 'from_dataset_role');
    await expect(values.locator('[data-value-key="role:valueColumns"]')).toContainText('score');
    await expect(values.locator('[data-value-key="role:valueColumns"] [data-testid="origin-chip"]')).toHaveAttribute('data-origin', 'suggested');
    await expect(values.locator('[data-value-key="param:groupFrom"] [data-testid="origin-chip"]')).toHaveAttribute('data-origin', 'from_project');

    // Nothing was submitted by opening the pane.
    const submitted = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/v1\/rule-runs$/.test(r.url()));
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/rule-runs$/.test(r.url()));
    await pane.getByRole('button', { name: 'Run' }).click();
    const body = (await submitted).postDataJSON();
    const response = await answered;
    expect(response.status(), await response.text()).toBeLessThan(300);
    const { ruleRunId } = await response.json();

    expect(body).toMatchObject({
      ruleId: mwu.id,
      runKind: 'STATISTICAL',
      operationId: MWU_OP,
      roleBindings: { groupColumn: 'arm' },
      pivot: { valueColumns: ['score'] },
      operationParams: { groupFrom: 'A', groupTo: 'B' },
      viewAnalysisId: scope.analysisId,
    });
    expect(body.valueOrigins).toMatchObject({
      params: { groupFrom: 'policy_default', groupTo: 'policy_default' },
      roles: { groupColumn: 'dataset_role', valueColumns: 'suggested' },
    });
    // The picker closes on success.
    await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toHaveCount(0);

    // The platform re-derived and RECORDED exactly those origins on the run.
    const run = await ok(api.get(`/api/v1/rule-runs/${ruleRunId}`, scope.headers), 'rule run');
    // The record stores {origin, value} per field; the submission carries the origin alone.
    const originsOf = (group: Record<string, { origin: string }> = {}) =>
      Object.fromEntries(Object.entries(group).map(([key, entry]) => [key, entry.origin]));
    expect({ params: originsOf(run.valueOrigins?.params), roles: originsOf(run.valueOrigins?.roles) }).toEqual({
      params: body.valueOrigins.params ?? {},
      roles: body.valueOrigins.roles ?? {},
    });
    expect(run.valueOrigins).toMatchObject({
      params: { groupFrom: { value: 'A' }, groupTo: { value: 'B' } },
      roles: { groupColumn: { value: 'arm' }, valueColumns: { value: ['score'] } },
    });
    console.log(`AXI-1772 live one-click run ${ruleRunId} valueOrigins=${JSON.stringify(run.valueOrigins)}`);
  });

  test('14.3.3 AC3 FR28 — not fully bound: no Run; the readiness says what is open and Adjust parameters opens the editor pre-filled @SI-030 @SI-035', async ({ page }) => {
    let runPosts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/v1\/rule-runs$/.test(r.url())) runPosts++;
    });
    // The picker resolves against the analysis's CURRENT snapshot, and 14.3.2's run moved
    // `analysisId` onto its result dataset — so this case opens an analysis never run on.
    await openPicker(page, scope.pristineAnalysisId);
    await ruleRow(page, ttest).click();
    const pane = page.getByTestId('rule-detail-pane');
    await expect(pane).toHaveAttribute('data-rule-code', ttest.code);
    await expect(pane.getByRole('status')).toContainText('2 fields still to choose', { timeout: 30_000 });
    await expect(pane.getByRole('button', { name: 'Run' })).toHaveCount(0);

    await pane.getByRole('button', { name: 'Adjust parameters' }).click();
    const editor = page.getByRole('heading', { name: /^Configure / });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    // Pre-filled by the same resolver: the group column arrives from the confirmed dataset role.
    await expect(page.locator('[data-testid="origin-chip"][data-origin="from_dataset_role"]').first()).toBeVisible({ timeout: 30_000 });
    expect(runPosts, 'nothing is ever submitted without a click on Run').toBe(0);
  });
});
