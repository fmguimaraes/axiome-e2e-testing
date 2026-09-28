import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
import { apiUrl } from '../../config/env';
import {
  ensureTenant, ensureProject, ingestFreshFixture, runLabel, datasetVersionHash, ensureDefaultAnalysis,
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
  let hash: string;
  const rolesUrl = () => `/api/v1/discovery/analyses/${viewAnalysisId}/datasets/${datasetId}/roles`;
  const stepUrl = (nodeRef: string, action: 'resolve' | 'submit') => `/api/v1/discovery/analyses/${viewAnalysisId}/steps/${nodeRef}/${action}`;
  /** AXI-1807 — the guided run's own SCREEN node (`d6`), the LLM-free template step. */
  const SCREEN_OP = 'stats.screen_shortlist';
  const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED']);

  /**
   * AXI-1807 — the scientist's own one-click step submit (AXI-1721 FR11), the SAME re-authoring
   * `ebf89c7` already applied to AXI-1507: instantiation starts nothing (AXI-1779), so the only way
   * to make this container's question carry a REAL exploration run is to submit a step through it,
   * exactly as the workbench does. Drains the step's own governed run (resolving any
   * AWAITING_APPROVAL interpretation node) and returns once every node has settled.
   */
  async function runScreenStep(): Promise<{ runId: string; nodes: any[] }> {
    const submitted = await api.post(stepUrl('screen', 'submit'), {
      operationId: SCREEN_OP, datasetId, projectId, datasetVersionHash: hash,
    }, t.headers);
    expect(submitted.status, `submit screen: ${JSON.stringify(submitted.body)}`).toBe(201);
    expect(submitted.body.submitted, `screen step refused: ${JSON.stringify(submitted.body.reasons)}`).toBe(true);
    const stepRunId = submitted.body.runId as string;
    let nodes: any[] = [];
    for (let i = 0; i < 120; i++) {
      const st = (await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${stepRunId}`, t.headers)).body;
      nodes = st?.nodes ?? [];
      for (const n of nodes.filter((n: any) => n.status === 'AWAITING_APPROVAL')) {
        await api.post('/api/v1/governed-execution/resolve', { projectId, runId: stepRunId, nodeId: n.nodeId, approved: true, note: 'AXI-1720 e2e' }, t.headers);
      }
      if (nodes.length > 0 && nodes.every((n: any) => SETTLED.has(n.status))) break;
      await new Promise((r) => setTimeout(r, 2_500));
    }
    expect(nodes.length, 'the screen step run has nodes').toBeGreaterThan(0);
    expect(nodes.every((n: any) => SETTLED.has(n.status)), `screen step never settled: ${JSON.stringify(nodes)}`).toBe(true);
    return { runId: stepRunId, nodes };
  }
  const declaration = (site = 'center') => ({
    outcome: { state: 'declared', column: 'response', outcomeKind: 'binary' },
    subject: { state: 'declared', column: 'patient_id' },
    timepoint: { state: 'declared_uncaptured', reason: 'AXI-1720 e2e: single baseline' },
    representation: { state: 'declared', column: 'group', primaryLevel: 'A' },
    batch: { state: 'declared_uncaptured', reason: 'AXI-1720 e2e: none recorded' },
    site: { state: 'declared', column: site },
  });

  /**
   * AXI-1801 — one label per run, carried by BOTH the dataset and the question, so this
   * describe never meets anything a previous run left behind. The three pieces of state
   * this spec writes are all permanent through the API:
   *   - the roles declaration, keyed `(workspace, dataset)` — a run confirms it and (B3)
   *     locks it, so a second run on the same dataset could not start "nothing declared";
   *   - the plan instance, keyed by container — a container holds at most ONE by design
   *     (AXI-1516), so the shared `auto_default` container refuses every re-instantiation
   *     (correct product behaviour, and the reason this spec used to die in `beforeAll`);
   *   - the question's exploration runs, which decide the FR3 lock.
   * A fresh dataset resets all three at once: its own `auto_default` container is created
   * with it, so the seed stays the plain `ensureDefaultAnalysis` path the product uses.
   */
  const RUN = runLabel('axi1720');

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureTenant(api);
    projectId = await ensureProject(api, t, NAMES.project);
    datasetId = await ingestFreshFixture(api, t, NAMES.smallFixture, RUN);
    hash = await datasetVersionHash(api, t, datasetId);
    await ensureApprovedDiscoveryConfig(api, t);
    viewAnalysisId = await ensureDefaultAnalysis(api, t, projectId, datasetId);
    const bound = await bindEnvelope(api, t, viewAnalysisId);
    expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);
    // A discovery plan instance on the container (LLM-free): the roles API derives the question from it.
    const planned = await instantiatePlan(api, t, { viewAnalysisId, projectId, datasetId, datasetVersionHash: hash, questionKey: `axi-1720-roles-${RUN}` });
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
    // AXI-1801 — the dataset belongs to THIS run, so "nothing declared" is a fact, not a hedge
    // (it used to be guarded by `if (current === null)`, which on the shared dataset silently
    // skipped itself as soon as a previous run had declared anything).
    expect(res.body.current, 'a run-private dataset carries no earlier declaration').toBeNull();
    // AXI-1807: the race this used to hedge is gone. Before AXI-1779, instantiating the plan
    // STARTED the template's governed run, so the first non-split rule run it recorded on this
    // container could flip the lock within seconds of `beforeAll` returning — a race no seed
    // could settle. AXI-1779 made instantiation DECLARE the plan and start nothing, so nothing
    // touches this container's runs until a test in this describe submits a step itself (see the
    // two FR3 tests below). A freshly-instantiated, freshly-declared-nothing container is
    // deterministically unlocked; asserted outright, not merely typed.
    expect(res.body.locked, 'a freshly instantiated container starts nothing, so it is unlocked').toBe(false);
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
    // AXI-1807: under AXI-1779 instantiation DECLARES the plan and starts nothing, and no test
    // before this one has submitted a step, so this container is deterministically UNLOCKED here
    // (asserted outright by the previous test in this describe). The edit therefore always
    // replaces the declaration in place; the "already locked" outcome only exists for the NEXT
    // test, which submits a real step first.
    expect(before.body.locked, 'nothing has submitted a step on this container yet').toBe(false);
    const put = await api.ctx.put(apiUrl(rolesUrl()), {
      data: { roles: declaration('hospital'), confirm: true }, headers: t.headers,
    });
    const body = await put.json();
    expect(put.status(), JSON.stringify(body)).toBeLessThan(300);
    expect(body.mintedNewRevision).toBe(false);
    expect(body.record.revision).toBe(before.body.current.revision);
  });

  // AXI-1807 (B3) — re-authored against the one-click step path, the SAME defect class fixed in
  // AXI-1507 (`ebf89c7`): under AXI-1779 the INSTANTIATION run (`runId` from `beforeAll`) stays
  // DRAFT for ever and starts nothing, so polling ITS status can never see a node settle - the old
  // version of this test could only ever time out. The lock is driven by the scientist's OWN step
  // submit instead (`POST .../steps/screen/submit`, AXI-1721 FR11), exactly as the workbench does;
  // `runScreenStep` drives THAT run's nodes to settlement (any settled status counts - `isLocked`
  // in `dataset-roles.service.ts` counts every non-split `RuleRun` row on the question regardless
  // of outcome, so even a FAILED screen still flips the lock).
  test('FR3 - after the REAL guided run produces exploration runs the roles lock and an edit mints revision N+1, original unchanged', async () => {
    await runScreenStep();
    const before = await api.get(rolesUrl(), t.headers);
    expect(before.body.locked, 'a real step submit produced a rule run on this question, so the roles must be locked').toBe(true);
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

  test('NFR8 - the existing envelope route still carries its context fields and no role of any kind', async () => {
    const env = await api.get(`/api/v1/discovery/analyses/${viewAnalysisId}/envelope`, t.headers);
    expect(env.status).toBe(200);
    const keys = Object.keys(env.body.fields);
    // AXI-1516's seven context fields are all still there. Asserted as a SUPERSET, not an
    // equality: this story owns "roles stay out of the envelope", not the envelope's own
    // field set, which AXI-1699 (FR92) has since extended with the dataset comparability
    // axes (modality, species, assayFamily). The old equality was green only against a
    // container bound before that story shipped (AXI-1801).
    for (const field of ['cohort', 'denominator', 'disease', 'gateDefinition', 'panel', 'tissue', 'timepoint']) {
      expect(keys, `envelope context field ${field}`).toContain(field);
    }
    expect(env.body).not.toHaveProperty('roles');
    // What NFR8 actually forbids: a dataset ROLE riding in on the envelope.
    expect(keys.filter((k) => (ROLES as readonly string[]).includes(k) && k !== 'timepoint')).toEqual([]);
  });
});
