import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, submitStepAndWait, SCREEN_OP, MEASUREMENTS, type Seeded } from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1791 - Server-side governance (epic AXI-1775: FR14, FR29-FR32; NFR1, NFR4; AC4, AC9, EC8).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 4.
 * Tags: @SI-014 (population composition, declarations), @SI-017 (table truncation reporting),
 * @SI-002 (contracts), @SI-010 (gateway routes).
 *
 * REAL BACKEND, LLM-FREE. Same Riaz 2017 immune seed as AXI-1717 (`seedLiveWorkbench`): 27 patients,
 * `response` R/NR, `patient_id`, roles CONFIRMED by the seed. Every governed number asserted here is
 * cross-checked against an INDEPENDENT read of the dataset (the query API), never against itself.
 * NOT RUN in the authoring session (no worktree stack serving this branch); see scenario 4.9.
 */
const API = '/api/v1/discovery';
const put = (s: Seeded, path: string, data: unknown) =>
  s.api.ctx.put(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${path}`, { data: data as never, headers: s.t.headers });

test.describe('AXI-1791 - server-measured population governance (API, real backend)', { tag: ['@SI-014', '@SI-017', '@SI-002', '@SI-010'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let priorDeclaration: any = null;
  let rows: Record<string, unknown>[] = [];
  const population = () => s.api.get(`${API}/projects/${s.projectId}/population`, s.t.headers);
  const declare = (declaration: unknown) => put(s, `${API}/datasets/${s.datasetId}/semantic-declaration`, { declaration });

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1791-${tag}`, `AXI-1791 Server governance ${tag}`);
    const cur = await s.api.get(`${API}/datasets/${s.datasetId}/semantic-declaration`, s.t.headers);
    priorDeclaration = cur.body?.declaration ?? null;
    const q = await s.api.post(`/api/v1/workspaces/${s.t.workspaceId}/datasets/${s.datasetId}/query`, { limit: 1000 }, s.t.headers);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    rows = q.body.rows;
  });
  test.afterAll(async () => {
    // The declaration store is append-only: restore what was there (or an empty declaration = nothing stated).
    if (s) await declare(priorDeclaration ?? { scopeRoles: [] });
    await s?.api.ctx.dispose();
  });

  const distinct = (pred: (r: Record<string, unknown>) => boolean) => new Set(rows.filter(pred).map((r) => String(r.patient_id))).size;

  test('AC9 FR30 FR31 - composition is read from the declared (confirmed) roles and counts the dataset\'s distinct subjects', async () => {
    const res = await population();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const member = res.body.members.find((m: any) => m.datasetId === s.datasetId);
    expect(member).toMatchObject({ rolesConfirmed: true, subjectColumn: 'patient_id', read: 'complete' });
    expect(res.body.composition).toMatchObject({ kind: 'single', subjects: distinct(() => true) });
    expect(res.body.complete).toBe(true);
  });

  test('AC9 FR31 NFR2 - nothing declared about validation is stated as null, never false', async () => {
    const res = await population();
    expect(res.body.validationDatasetAssigned).toBeNull();
    expect(res.body.design).toBeNull();
  });

  test('AC9 FR29 - pre-split per-group counts are distinct SUBJECTS measured by the server, equal to an independent count', async () => {
    const res = await s.api.post(`${API}/projects/${s.projectId}/contrast-counts`, {
      column: 'response', groups: [{ id: 'R', levels: ['R'] }, { id: 'NR', levels: ['NR'] }],
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.groups).toEqual([
      { id: 'R', subjects: distinct((r) => r.response === 'R') },
      { id: 'NR', subjects: distinct((r) => r.response === 'NR') },
    ]);
    expect(res.body.subjectsInMultipleGroups).toBe(0);
  });

  test('AC9 FR29 NFR2 - a column that is not in the population is null with a reason, not zero', async () => {
    const res = await s.api.post(`${API}/projects/${s.projectId}/contrast-counts`, { column: 'not_a_column', groups: [{ id: 'A', levels: ['x'] }] }, s.t.headers);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].subjects).toBeNull();
    expect(res.body.reason).toMatch(/carries this column/);
  });

  test('AC4 AC9 FR14 FR31 - marker families and the analysis role are DECLARED and read back; a declared discovery role makes the flag false', async () => {
    const put1 = await declare({ scopeRoles: [], analysisRole: 'discovery', markerFamilies: [{ token: 'checkpoint', label: 'Checkpoint', columns: ['CD274_pre', 'PDCD1_pre'] }] });
    expect(put1.status(), await put1.text()).toBeLessThan(300);
    const res = await population();
    expect(res.body.validationDatasetAssigned).toBe(false);
    expect(res.body.markerFamilies).toEqual([{ token: 'checkpoint', label: 'Checkpoint', columns: ['CD274_pre', 'PDCD1_pre'], datasetId: s.datasetId }]);
  });

  test('FR31 - a dataset declared independent_validation raises the flag and leaves the base population', async () => {
    const put2 = await declare({ scopeRoles: [], analysisRole: 'independent_validation' });
    expect(put2.status(), await put2.text()).toBeLessThan(300);
    const res = await population();
    expect(res.body.validationDatasetAssigned).toBe(true);
    expect(res.body.composition).toMatchObject({ kind: 'none', subjects: null });
  });

  test('FR14 - an inadmissible declaration (a column in two families, an unknown role) is refused at load with a 400', async () => {
    const dup = await declare({ scopeRoles: [], markerFamilies: [{ token: 'a', label: 'A', columns: ['CD8A_pre'] }, { token: 'b', label: 'B', columns: ['CD8A_pre'] }] });
    expect(dup.status()).toBe(400);
    const badRole = await declare({ scopeRoles: [], analysisRole: 'holdout' });
    expect(badRole.status()).toBe(400);
  });

  test('AC9 FR32 EC8 - a result table larger than the requested page states its truncation and the rows left', async () => {
    const runId = await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    const status = (await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${runId}`, s.t.headers)).body;
    expect(status.ruleRunId).toBeTruthy();
    const small = await s.api.get(`/api/v1/rule-runs/${status.ruleRunId}/table?page=1&limit=3`, s.t.headers);
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    expect(small.body).toMatchObject({ totalRows: MEASUREMENTS.length, returnedRows: 3, remainingRows: MEASUREMENTS.length - 3, truncated: true });
    const whole = await s.api.get(`/api/v1/rule-runs/${status.ruleRunId}/table?page=1&limit=500`, s.t.headers);
    expect(whole.body).toMatchObject({ returnedRows: MEASUREMENTS.length, remainingRows: 0, truncated: false });
  });

  test('NFR1 - the existing table fields are unchanged beside the new ones', async () => {
    const runId = await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    const status = (await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${runId}`, s.t.headers)).body;
    const t = await s.api.get(`/api/v1/rule-runs/${status.ruleRunId}/table`, s.t.headers);
    expect(Object.keys(t.body)).toEqual(expect.arrayContaining(['columns', 'rows', 'totalRows', 'page', 'limit', 'columnOrigins']));
    expect(t.body.rows.length).toBe(MEASUREMENTS.length);
  });

  test('NFR4 - an unknown project is a 404, a body cannot assert tenancy or the project, and there is no anonymous read', async () => {
    const ghost = await s.api.get(`${API}/projects/00000000-0000-4000-8000-000000000000/population`, s.t.headers);
    expect(ghost.status).toBe(404);
    const spread = await s.api.post(`${API}/projects/${s.projectId}/contrast-counts`, {
      column: 'response', groups: [{ id: 'R', levels: ['R'] }], workspaceId: s.t.workspaceId,
    }, s.t.headers);
    expect(spread.status).toBe(400);
    const anon = await s.api.ctx.get(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${API}/projects/${s.projectId}/population`, { headers: { Authorization: '' } });
    expect([401, 403]).toContain(anon.status());
  });
});
