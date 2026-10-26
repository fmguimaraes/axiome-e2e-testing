import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2292 (epic AXI-2060): the chart Editor can set the Facet of a strip chart.
 * strip_v1 declares an authoring-only `facet` slot (AXI-2252,
 * `SeedTemplate.authoringBindings`). The templates API now serves it beside the
 * seeded `bindings`; the VisualizationEditor renders it as an optional "Facet"
 * dropdown; Save persists `bindings.facet`. Candidate generation (which reads
 * the same templates) must still never bind an authoring slot.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2292 (S1–S5). Tags: @SI-018, @SI-033, @SI-015, @SI-010.
 *
 * S5 is RED on main as of 2026-10-26 (a real defect, reported to the lead): the
 * Editor's Save stores its PREVIEW chart-compute run as `spec.computeRunId`, so
 * the chart page renders the frozen, pre-computed (unfaceted) preview payload
 * as ONE panel and reads the id as an AXI-2243 comparison-run link
 * ("⚠ Linked run not found"). The same bindings saved WITHOUT that run id
 * render one panel per reference.
 *
 * Isolation: the Editor scenarios run in a THROWAWAY analysis
 * (`[e2e AXI-2292 throwaway] …`) in the synthetic reproduction project 22585add
 * on its read-only dataset 4c1bd11e — never the demo project b7b274bc, never
 * "Demo 2610" (4ff39166). The candidate-generation scenario uploads its own
 * synthetic CSV, so generation runs fresh on the live code without touching
 * (or regenerating) any shared dataset. `afterAll` deletes every chart the
 * Editor saved, deletes the analysis (archives it if delete is refused) and
 * soft-deletes the uploaded dataset.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const PROTECTED_PROJECT_IDS = ['b7b274bc-48a3-494a-a66f-76390bb433a8', '4ff39166'];
const DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const THROWAWAY = '[e2e AXI-2292 throwaway]';
const FACET_SLOT = { role: 'group', required: false };

type Bindings = Record<string, unknown>;
interface Spec { id: string; templateId: string; origin: string; title?: string | null; bindings: Bindings }
interface Template { templateId: string; templateVersion: string; bindings: Bindings; authoringBindings?: Bindings }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let analysisId = '';
let uploadedDatasetId = '';
let facetedSpecId = '';
const savedSpecIds: string[] = [];

async function ok<T>(label: string, call: Promise<APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

/** A binding is stored as a bare column id (Editor) or `{ column_id }` (API) — read either. */
function columnOf(binding: unknown): string | undefined {
  if (typeof binding === 'string') return binding;
  return (binding as { column_id?: string } | undefined)?.column_id;
}

async function listSpecs(datasetId: string, query = ''): Promise<Spec[]> {
  const body = await ok<Spec[] | { data: Spec[] }>('candidates', api.get(candidatesUrl(datasetId, query)));
  return Array.isArray(body) ? body : body.data;
}

async function createThrowawayAnalysis(): Promise<void> {
  const me = await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')));
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: DATASET_ID, name: `${THROWAWAY} ${Date.now()}`, createdBy: me.id },
  }));
  analysisId = va.id;
}

async function signIn(page: Page) {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, ORGANIZATION_ID, WORKSPACE_ID] as const,
  );
}

/** The Editor's column dropdown for one binding slot (label text = the slot key, title-cased). */
function slotSelect(page: Page, label: string) {
  return page.locator(`xpath=//label[normalize-space()="${label}"]/following-sibling::div[1]//select`);
}

async function openEditorWithStrip(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}`);
  await page.getByRole('tab', { name: 'Editor' }).click();
  const template = page.locator('xpath=//label[normalize-space()="Template"]/following-sibling::div[1]//select');
  await expect(template).toBeVisible({ timeout: 60_000 });
  await template.selectOption({ label: 'Strip / Jitter Plot' });
  await expect(slotSelect(page, 'Y')).toBeVisible();
}

/** Save through the Editor's own button, then return the spec the server stored under that title. */
async function saveAndRead(page: Page, title: string): Promise<Spec> {
  await page.getByPlaceholder('Chart title (optional)').fill(title);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Visualization created successfully')).toBeVisible({ timeout: 20_000 });
  let saved: Spec | undefined;
  await expect.poll(async () => {
    saved = (await listSpecs(DATASET_ID, `?viewAnalysisId=${analysisId}`)).find((s) => s.title === title);
    return !!saved;
  }, { timeout: 20_000 }).toBe(true);
  savedSpecIds.push(saved!.id);
  return saved!;
}

/** The axis keys of the live Plotly figure on the chart page. */
async function axisKeys(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const gd = document.querySelector('.js-plotly-plot') as unknown as { layout?: Record<string, unknown> } | null;
    if (!gd?.layout) return null;
    return Object.keys(gd.layout).filter((k) => /^xaxis\d*$/.test(k)).sort();
  });
}

/** A small synthetic long table: a measure, a 3-level group and a 3-level reference. */
function syntheticCsv(): string {
  const rows = ['serum,group,reference,pct'];
  const groups = ['HD', 'IgG4-RD', 'SD'];
  const refs = ['REF A', 'REF B', 'REF C'];
  for (let i = 0; i < 45; i += 1) {
    rows.push(`synthetic-${i},${groups[i % 3]},${refs[Math.floor(i / 3) % 3]},${((i * 37) % 100) / 50}`);
  }
  return `${rows.join('\n')}\n`;
}

async function uploadSyntheticDataset(): Promise<string> {
  const filename = `e2e-AXI-2292-throwaway-synthetic-${Date.now()}.csv`;
  const init = await ok<{ dataset: { id: string }; presignedUrl: string }>('upload init', api.post(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets`), {
    data: { organizationId: ORGANIZATION_ID, originalFilename: filename, contentType: 'text/csv' },
  }));
  uploadedDatasetId = init.dataset.id;
  const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: syntheticCsv() });
  expect(put.ok, `presigned PUT ${put.status}`).toBeTruthy();
  await ok('finalize', api.patch(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${uploadedDatasetId}/finalize`)));
  return uploadedDatasetId;
}

test.describe('AXI-2292 - the chart Editor sets the Facet of a strip chart', { tag: ['@SI-018', '@SI-033', '@SI-015', '@SI-010'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  // Own login (below), never the fixture-org `setup` project's storageState.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
    expect(PROTECTED_PROJECT_IDS.some((p) => PROJECT_ID.startsWith(p))).toBe(false);
    await createThrowawayAnalysis();
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of savedSpecIds) await api.delete(candidatesUrl(DATASET_ID, `/${id}`));
    if (analysisId) {
      const del = await api.delete(apiUrl(`/api/v1/view-analyses/${analysisId}`));
      if (!del.ok()) await api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} });
    }
    if (uploadedDatasetId) await api.delete(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${uploadedDatasetId}`));
    await api.dispose();
  });

  test('S1 AC1 - GET /templates (all, one; authorable consistent) serves strip_v1 authoringBindings.facet beside its seeded bindings', async () => {
    const all = await ok<Template[]>('templates', api.get(apiUrl('/api/v1/templates')));
    const one = await ok<Template>('one', api.get(apiUrl('/api/v1/templates/strip_v1/1.0.0')));
    for (const strip of [all.find((t) => t.templateId === 'strip_v1'), one]) {
      expect(strip?.authoringBindings).toEqual({ facet: FACET_SLOT });
      // The seeded slots stay what candidate generation reads: no facet among them.
      expect(Object.keys(strip!.bindings).sort()).toEqual(['color', 'group', 'y']);
    }
    // Only templates that declare authoring slots carry the key.
    const box = all.find((t) => t.templateId === 'boxplot_v1');
    expect(box).toBeTruthy();
    expect(box!.authoringBindings).toBeUndefined();
    // `authorable` is EMPTY on the demo DB (no row is flagged authorable), so it
    // can only be held consistent with `all` here; its mapping is unit-tested.
    const authorable = await ok<Template[]>('authorable', api.get(apiUrl('/api/v1/templates/authorable')));
    for (const t of authorable) {
      const twin = all.find((a) => a.templateId === t.templateId && a.templateVersion === t.templateVersion);
      expect(t.authoringBindings, t.templateId).toEqual(twin?.authoringBindings);
    }
  });

  test('S2 AC2 - the Editor offers an optional Facet dropdown for Strip / Jitter Plot; Save persists bindings.facet', async ({ page }) => {
    await openEditorWithStrip(page);
    const facet = slotSelect(page, 'Facet');
    await expect(facet).toBeVisible();
    await expect(facet).toHaveValue('');
    await expect(facet.locator('option[value="col_reference"]')).toHaveCount(1);

    await slotSelect(page, 'Y').selectOption('col_pct');
    await slotSelect(page, 'Group').selectOption('col_group');
    await facet.selectOption('col_reference');
    const saved = await saveAndRead(page, `${THROWAWAY} faceted ${Date.now()}`);

    expect(saved.templateId).toBe('strip_v1');
    expect(saved.origin).toBe('user');
    expect(columnOf(saved.bindings.facet)).toBe('col_reference');
    expect(columnOf(saved.bindings.y)).toBe('col_pct');
    expect(columnOf(saved.bindings.group)).toBe('col_group');
    facetedSpecId = saved.id;
  });

  test('S3 AC2 - Facet is optional: a strip saved with Facet left empty stores no facet binding', async ({ page }) => {
    await openEditorWithStrip(page);
    await slotSelect(page, 'Y').selectOption('col_pct');
    await slotSelect(page, 'Group').selectOption('col_group');
    await expect(slotSelect(page, 'Facet')).toHaveValue('');
    const saved = await saveAndRead(page, `${THROWAWAY} unfaceted ${Date.now()}`);
    expect(Object.keys(saved.bindings)).not.toContain('facet');
    expect(columnOf(saved.bindings.group)).toBe('col_group');
  });

  test('S4 AC3 - fresh candidate generation never binds an authoring slot (no auto strip_v1 binds facet)', async () => {
    const all = await ok<Template[]>('templates', api.get(apiUrl('/api/v1/templates')));
    const seeded = new Map(all.map((t) => [t.templateId, new Set(Object.keys(t.bindings))]));
    const datasetId = await uploadSyntheticDataset();

    let autos: Spec[] = [];
    await expect.poll(async () => {
      autos = (await listSpecs(datasetId)).filter((s) => s.origin === 'auto');
      return autos.some((s) => s.templateId === 'strip_v1');
    }, { timeout: 180_000, intervals: [3_000] }).toBe(true);

    for (const spec of autos.filter((s) => s.templateId === 'strip_v1')) {
      expect(Object.keys(spec.bindings), `auto strip ${spec.id}`).not.toContain('facet');
    }
    // Every auto candidate binds only its template's SEEDED slots, never an authoring one.
    for (const spec of autos) {
      const allowed = seeded.get(spec.templateId)!;
      const stray = Object.keys(spec.bindings).filter((k) => !allowed.has(k));
      expect(stray, `${spec.templateId} ${spec.id}`).toEqual([]);
    }
  });

  test('S5 AC2 - the chart the Editor saved with a Facet opens faceted: one panel per reference, no stray run warning', async ({ page }) => {
    expect(facetedSpecId, 'S2 saved the faceted chart').not.toBe('');
    await signIn(page);
    await page.goto(`/datasets/${DATASET_ID}/chart/${facetedSpecId}`);
    // Dataset 4c1bd11e carries 7 reference microbiota → 7 panels (xaxis … xaxis7).
    await expect.poll(() => axisKeys(page), { timeout: 60_000 }).toEqual(expect.arrayContaining(['xaxis', 'xaxis2', 'xaxis7']));
    await expect(page.getByText('Linked run not found')).toHaveCount(0);
  });
});
