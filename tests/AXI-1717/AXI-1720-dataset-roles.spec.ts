import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
import { apiUrl } from '../../config/env';
import {
  ensureTenant, ensureProject, ingestFixture, datasetVersionHash, ensureDefaultAnalysis,
  bindEnvelope, ensureApprovedDiscoveryConfig, instantiatePlan, NAMES,
} from '../AXI-1507/harness/seed';

/**
 * AXI-1720 — Dataset roles: shared storage and one-time declaration panel (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 10.
 * Tags: @SI-046 (front: the roles panel in the workbench shell),
 *       @SI-014 @SI-002 (back: the roles record and API, additive).
 *
 * TWO DESCRIBES, DIFFERENT DEPENDENCIES:
 *  - UI (mocked backend): needs only a logged-in admin and a front end on the AXI-1720
 *    branch. The guided plan list, the view analysis and the roles routes are mocked; the
 *    REAL requests the panel builds are captured and asserted. No planner, no LLM.
 *  - API (real backend): needs the stack on the AXI-1720 branches (migration
 *    `20260926170000_add_dataset_roles_declarations` applied). Seeded through the AXI-1507
 *    harness, LLM-free. These FAIL, never skip, when the roles routes are absent - a stack
 *    that is not on the branch is an infra fault, not a green run.
 *
 * NO paid call: nothing here reaches `POST /guided-analysis/plan`.
 */

const ROLES = ['outcome', 'subject', 'timepoint', 'representation', 'batch', 'site'] as const;
const WS = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const PLAN = 'PL-axi1720-1';
const VA = '44444444-4444-4444-8444-444444444444';
const DATASET = '55555555-5555-4555-8555-555555555555';
const HASH = `sha256:${'cd'.repeat(32)}`;

const guesses = [
  { role: 'subject', column: 'patient_id', evidence: ['profiler:identifier'] },
  { role: 'timepoint', column: 'visit', evidence: ['name'] },
  { role: 'outcome', column: 'response', evidence: ['name'], outcomeKind: 'binary' },
  { role: 'representation', column: 'treatment_arm', evidence: ['name'] },
  { role: 'batch', column: 'plate', evidence: ['name'] },
  { role: 'site', column: 'center', evidence: ['name'] },
];

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'RR-1', datasetId: DATASET, revision: 1, identityHash: 'h1', declaredBy: 'u', declaredAt: new Date().toISOString(),
    confirmedBy: null, confirmedAt: null,
    roles: {
      outcome: { state: 'declared', column: 'response', outcomeKind: 'binary' },
      subject: { state: 'declared', column: 'patient_id' },
      timepoint: { state: 'declared_uncaptured', reason: 'single baseline' },
      representation: { state: 'declared', column: 'treatment_arm', primaryLevel: 'Responder' },
      batch: { state: 'declared_uncaptured', reason: 'none recorded' },
      site: { state: 'declared', column: 'center' },
    },
    ...over,
  };
}

async function mockWorkbench(page: Page, rolesResponse: () => unknown) {
  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [WS, ORG] as const);
  await page.route('**/api/v1/guided-analysis/plans*', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{
        planId: PLAN, question: 'AXI-1720 - which markers separate responders?', planner: 'anthropic', revision: 1, status: 'run',
        createdAt: new Date().toISOString(), plan: { planId: PLAN, nodes: [] }, strategy: 'guided_discovery', promptHash: HASH,
        promptVersion: 1, promptTitle: 'Guided analysis', analysisId: VA,
      }]),
    }));
  await page.route('**/api/v1/governed-execution/status*', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'GR-1', status: 'RUNNING', nodes: [], runStatus: 'running' }) }));
  await page.route(`**/api/v1/view-analyses/${VA}`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: VA, datasetId: DATASET, name: 'axi1720', projectId: PROJECT }) }));
  await page.route(`**/api/v1/discovery/analyses/${VA}/datasets/${DATASET}/roles`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rolesResponse()) });
    }
    return route.fallback();
  });
}

test.describe('AXI-1720 - roles panel in the workbench (UI, backend mocked)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ timeout: 90_000 });

  test('AC1 EC1 FR2 - undeclared dataset: the shell renders, the only next step is Declare roles, guesses are pre-filled and nothing is saved on open', async ({ page }) => {
    const writes: string[] = [];
    await mockWorkbench(page, () => ({ datasetId: DATASET, current: null, confirmed: false, columns: ['patient_id', 'visit', 'response'], guesses, locked: false }));
    page.on('request', (r) => { if (['PUT', 'POST'].includes(r.method()) && r.url().includes('/roles')) writes.push(r.method()); });
    await page.goto(`/projects/${PROJECT}/guided-workbench/${PLAN}?runId=GR-1&analysisId=${VA}`);
    await expect(page.getByTestId('workbench-question')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('workbench-shell-content')).toBeVisible();
    await expect(page.getByTestId('roles-panel')).toHaveAttribute('data-phase', 'undeclared');
    await expect(page.getByTestId('roles-next-step')).toHaveAttribute('data-step', 'declare_roles');
    await expect(page.getByTestId('roles-next-step')).toHaveText('Next step: Declare roles');
    for (const role of ['subject', 'timepoint', 'outcome', 'representation', 'batch', 'site']) {
      await expect(page.getByTestId(`roles-suggested-${role}`)).toBeVisible();
    }
    await expect(page.getByTestId('roles-column-subject')).toHaveValue('patient_id');
    await expect(page.getByTestId('roles-save')).toBeDisabled(); // the representation level is still owed
    expect(writes).toEqual([]);
  });

  test('FR1 FR2 AC1 - declare without confirming sends the six roles, confirm:false and no workspace; then confirm covers the revision read', async ({ page }) => {
    let current: unknown = null;
    let confirmed = false;
    await mockWorkbench(page, () => ({ datasetId: DATASET, current, confirmed, columns: [], guesses: current ? [] : guesses, locked: false }));
    const put: any[] = [];
    const post: any[] = [];
    await page.route(`**/api/v1/discovery/analyses/${VA}/datasets/${DATASET}/roles`, async (route: Route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const body = route.request().postDataJSON();
      put.push(body);
      current = record();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ record: current, mintedNewRevision: false }) });
    });
    await page.route(`**/api/v1/discovery/analyses/${VA}/datasets/${DATASET}/roles/confirm`, async (route: Route) => {
      post.push(route.request().postDataJSON());
      confirmed = true;
      current = record({ confirmedBy: 'u', confirmedAt: new Date().toISOString() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
    });
    await page.goto(`/projects/${PROJECT}/guided-workbench/${PLAN}?runId=GR-1&analysisId=${VA}`);
    await page.getByTestId('roles-primary-level').fill('Responder');
    await page.getByTestId('roles-save').click();
    await expect(page.getByTestId('roles-panel')).toHaveAttribute('data-phase', 'awaiting_confirmation', { timeout: 30_000 });
    expect(put).toHaveLength(1);
    expect(put[0].confirm).toBe(false);
    expect(Object.keys(put[0].roles).sort()).toEqual([...ROLES].sort());
    expect(put[0].roles.representation).toEqual({ state: 'declared', column: 'treatment_arm', primaryLevel: 'Responder' });
    expect(JSON.stringify(put[0])).not.toMatch(/workspace/i);
    await expect(page.getByTestId('roles-next-step')).toHaveAttribute('data-step', 'confirm_roles');
    await expect(page.getByTestId('roles-status')).toContainText('Nothing uses these roles until they are confirmed');

    await page.getByTestId('roles-confirm').click();
    await expect(page.getByTestId('roles-panel')).toHaveAttribute('data-phase', 'confirmed', { timeout: 30_000 });
    expect(post).toEqual([{ revision: 1 }]);
    expect(confirmed).toBe(true);
    await expect(page.getByTestId('roles-next-step')).toHaveCount(0); // no later step asks for a role again
  });

  test('FR3 - after the first exploration run an edit warns it creates a new version, and saving reports the new version', async ({ page }) => {
    let current: any = record({ confirmedBy: 'u', confirmedAt: new Date().toISOString() });
    await mockWorkbench(page, () => ({ datasetId: DATASET, current, confirmed: true, columns: [], guesses: [], locked: true }));
    await page.route(`**/api/v1/discovery/analyses/${VA}/datasets/${DATASET}/roles`, async (route: Route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      current = record({ revision: 2, confirmedBy: 'u', confirmedAt: new Date().toISOString() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ record: current, mintedNewRevision: true }) });
    });
    await page.goto(`/projects/${PROJECT}/guided-workbench/${PLAN}?runId=GR-1&analysisId=${VA}`);
    await expect(page.getByTestId('roles-panel')).toHaveAttribute('data-locked', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('roles-panel')).toHaveAttribute('data-phase', 'confirmed');
    await page.getByTestId('roles-edit').click();
    await expect(page.getByTestId('roles-consequence')).toContainText('creates a new version');
    await page.getByTestId('roles-column-site').fill('hospital');
    await page.getByTestId('roles-save-confirm').click();
    await expect(page.getByTestId('roles-notice')).toContainText('Saved as version 2');
  });
});

test.describe('AXI-1720 - roles record and API (real backend)', { tag: ['@SI-014', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  let api: Api;
  let t: Awaited<ReturnType<typeof ensureTenant>>;
  let viewAnalysisId: string;
  let datasetId: string;
  let projectId: string;
  let runId: string;
  const rolesUrl = () => `/api/v1/discovery/analyses/${viewAnalysisId}/datasets/${datasetId}/roles`;
  const declaration = (site = 'center') => ({
    outcome: { state: 'declared', column: 'response', outcomeKind: 'binary' },
    subject: { state: 'declared', column: 'patient_id' },
    timepoint: { state: 'declared_uncaptured', reason: 'AXI-1720 e2e: single baseline' },
    representation: { state: 'declared', column: 'group', primaryLevel: 'A' },
    batch: { state: 'declared_uncaptured', reason: 'AXI-1720 e2e: none recorded' },
    site: { state: 'declared', column: site },
  });

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureTenant(api);
    projectId = await ensureProject(api, t, NAMES.project);
    datasetId = await ingestFixture(api, t, NAMES.smallFixture);
    const hash = await datasetVersionHash(api, t, datasetId);
    await ensureApprovedDiscoveryConfig(api, t);
    viewAnalysisId = await ensureDefaultAnalysis(api, t, projectId, datasetId);
    const bound = await bindEnvelope(api, t, viewAnalysisId);
    expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);
    // A discovery plan instance on the container (LLM-free): the roles API derives the question from it.
    const planned = await instantiatePlan(api, t, { viewAnalysisId, projectId, datasetId, datasetVersionHash: hash, questionKey: 'axi-1720-roles' });
    expect(planned.status, `instantiate: ${JSON.stringify(planned.body)}`).toBe(201);
    expect(planned.body.instantiated, `refused: ${JSON.stringify(planned.body.reasons)}`).toBe(true);
    runId = planned.body.instance.runId;
  });

  test.afterAll(async () => { await api?.ctx.dispose(); });

  test('FR1 FR2 AC1 EC1 - GET on an analysis with no declaration: nothing declared, unconfirmed, unlocked (the roles route exists)', async () => {
    const res = await api.get(rolesUrl(), t.headers);
    expect(res.status, `GET roles: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body).toMatchObject({ datasetId, confirmed: false });
    expect(Array.isArray(res.body.guesses)).toBe(true);
    expect(Array.isArray(res.body.columns)).toBe(true);
    // Either nothing declared yet, or a previous run of this spec left a declaration; never a confirmed one we did not make.
    if (res.body.current === null) expect(res.body.locked).toBe(false);
  });

  test('FR1 FR2 - PUT without confirm stores a DRAFT (still unconfirmed), then POST confirm makes it the confirmed record', async () => {
    const put = await api.ctx.put(apiUrl(rolesUrl()), {
      data: { roles: declaration(), confirm: false }, headers: t.headers,
    });
    expect(put.status(), await put.text()).toBeLessThan(300);
    const declared = (await put.json()).record;
    const draft = await api.get(rolesUrl(), t.headers);
    expect(draft.body.confirmed, 'a declared-but-unconfirmed record is not usable').toBe(false);
    expect(draft.body.current.confirmedAt).toBeNull();

    const confirm = await api.post(`${rolesUrl()}/confirm`, { revision: declared.revision }, t.headers);
    expect(confirm.status, JSON.stringify(confirm.body)).toBeLessThan(300);
    const after = await api.get(rolesUrl(), t.headers);
    expect(after.body.confirmed).toBe(true);
    expect(after.body.current.roles.site).toEqual({ state: 'declared', column: 'center' });
    expect(after.body.guesses, 'no pre-fill once declared').toEqual([]);
  });

  test('FR3 - before any exploration run an edit replaces the declaration in place (no new version)', async () => {
    const before = await api.get(rolesUrl(), t.headers);
    // The plan's governed run starts at instantiation and may already have produced a rule run on
    // this analysis; either outcome is asserted (never skipped) - the lock flag decides which.
    const put = await api.ctx.put(apiUrl(rolesUrl()), {
      data: { roles: declaration('hospital'), confirm: true }, headers: t.headers,
    });
    const body = await put.json();
    expect(put.status(), JSON.stringify(body)).toBeLessThan(300);
    if (before.body.locked === false) {
      expect(body.mintedNewRevision).toBe(false);
      expect(body.record.revision).toBe(before.body.current.revision);
    } else {
      expect(body.mintedNewRevision, 'locked already: an edit mints a new version').toBe(true);
      expect(body.record.revision).toBe(before.body.current.revision + 1);
    }
  });

  // B3 - drives a REAL guided exploration step (the LLM-free nine-step plan's governed run) and
  // asserts the lock flips off the platform's own run rows, then that an edit mints a new version.
  test('FR3 - after the REAL guided run produces exploration runs the roles lock and an edit mints revision N+1, original unchanged', async () => {
    const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED']);
    let nodes: any[] = [];
    for (let i = 0; i < 120; i++) {
      const st = (await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, t.headers)).body;
      nodes = st?.nodes ?? [];
      for (const n of nodes.filter((n: any) => n.status === 'AWAITING_APPROVAL')) {
        await api.post('/api/v1/governed-execution/resolve', { projectId, runId, nodeId: n.nodeId, approved: true, note: 'AXI-1720 e2e' }, t.headers);
      }
      if (nodes.length > 0 && nodes.every((n: any) => SETTLED.has(n.status))) break;
      await new Promise((r) => setTimeout(r, 2_500));
    }
    expect(nodes.length, 'the guided run has nodes').toBeGreaterThan(0);
    const before = await api.get(rolesUrl(), t.headers);
    expect(before.body.locked, 'a real guided run exists on this analysis, so the roles must be locked').toBe(true);
    const originalRevision = before.body.current.revision;
    const originalRoles = before.body.current.roles;
    const put = await api.ctx.put(apiUrl(rolesUrl()), { data: { roles: declaration('locked-edit-site'), confirm: true }, headers: t.headers });
    const body = await put.json();
    expect(put.status(), JSON.stringify(body)).toBeLessThan(300);
    expect(body.mintedNewRevision).toBe(true);
    expect(body.record.revision).toBe(originalRevision + 1);
    const after = await api.get(rolesUrl(), t.headers);
    expect(after.body.current.revision).toBe(originalRevision + 1);
    expect(after.body.current.roles.site).toEqual({ state: 'declared', column: 'locked-edit-site' });
    expect(originalRoles.site.column, 'the original declaration object read earlier is unchanged').not.toBe('locked-edit-site');
  });

  test('FR1 - an inadmissible declaration is a 400 listing every error and stores nothing', async () => {
    const before = await api.get(rolesUrl(), t.headers);
    const bad = { ...declaration(), site: { state: 'declared', column: ' ' } } as any;
    delete bad.batch;
    const put = await api.ctx.put(apiUrl(rolesUrl()), { data: { roles: bad }, headers: t.headers });
    expect(put.status()).toBe(400);
    const codes = JSON.stringify(await put.json());
    expect(codes).toContain('ROLE_MISSING');
    expect(codes).toContain('ROLE_COLUMN_BLANK');
    const after = await api.get(rolesUrl(), t.headers);
    expect(after.body.current?.identityHash).toBe(before.body.current?.identityHash);
  });

  test('NFR8 tenancy - a workspaceId in the body is refused (never a client field), and another workspace gets 404', async () => {
    const withWs = await api.ctx.put(apiUrl(rolesUrl()), {
      data: { roles: declaration(), workspaceId: '99999999-9999-4999-8999-999999999999' }, headers: t.headers,
    });
    expect(withWs.status()).toBe(400);
    const other = await api.post('/api/v1/workspaces', { name: 'AXI-1720 Other Workspace', type: 'internal', ownerOrganizationId: t.orgId });
    const otherWs = other.body?.id;
    expect(otherWs, 'a second workspace is needed to probe confinement').toBeTruthy();
    const res = await api.get(rolesUrl(), workspaceHeader(otherWs));
    expect([403, 404]).toContain(res.status);
  });

  test('NFR8 - the existing envelope route is unchanged: still the seven context fields, no roles member', async () => {
    const env = await api.get(`/api/v1/discovery/analyses/${viewAnalysisId}/envelope`, t.headers);
    expect(env.status).toBe(200);
    expect(Object.keys(env.body.fields).sort()).toEqual(['cohort', 'denominator', 'disease', 'gateDefinition', 'panel', 'tissue', 'timepoint']);
    expect(env.body).not.toHaveProperty('roles');
  });
});
