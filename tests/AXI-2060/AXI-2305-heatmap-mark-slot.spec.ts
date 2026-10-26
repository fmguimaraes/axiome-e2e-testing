import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2305 (epic AXI-2060): the Annotated Heatmap editor never offered the
 * Mark slot on a database that had already seeded `heatmap_annotated_v1`
 * before AXI-2245 added it. Root cause: AXI-2245 declared `mark` inside
 * `SeedTemplate.bindings` at the SAME template version, and `seedTemplates()`
 * is create-if-absent, so any already-seeded row (incl. the demo DB) kept
 * `bindings={x,y,z}` forever. Fix: `mark` moved to `SeedTemplate
 * .authoringBindings` (the AXI-2292 / strip_v1 `facet` precedent) — served
 * beside the row by `withAuthoringBindings`, never written to the DB, reaches
 * every database without a version bump.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2305. The doc's S1 and S2 map to three tests here;
 * the doc's own S3 (candidate generation never auto-fills Mark) is
 * `automation: manual` and is NOT this spec's third test — see its comment.
 *
 * S1 — the Editor offers Mark (doc S1).
 * S2 — binding Mark and saving persists `bindings.mark` (doc S2, first half).
 * AC2 rendering — a cell mapped by `mark_values` shows its symbol (doc S2,
 * second half — split into its own test for isolation, not a fourth doc
 * scenario) once the Editor-bound Mark slot's spec has that display param
 * set (ChartControls), reusing the AXI-2245/AXI-2294 established fact that
 * `mark_values` is a post-save display param, never an Editor binding.
 *
 * Isolation: a brand-new THROWAWAY project, created via the API in
 * `beforeAll` and deleted in `afterAll` — never `4ff39166` ("Demo 2610")
 * or `b7b274bc` (the real demo project). Reuses the real, read-only
 * `heatmap_synthetic_v4.csv` dataset (`6779b1df…`, established by AXI-2245/
 * AXI-2294) for its columns; the analysis + every chart this spec creates
 * are deleted in `afterAll`.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROTECTED_PROJECT_IDS = ['4ff39166', 'b7b274bc-48a3-494a-a66f-76390bb433a8'];
const DATASET_ID = '6779b1df-8591-4510-bc31-a9afe364fc90'; // heatmap_synthetic_v4.csv
const THROWAWAY = '[e2e AXI-2305 throwaway]';

type Bindings = Record<string, unknown>;
interface Spec { id: string; templateId: string; bindings: Bindings; title?: string | null }
interface Template { templateId: string; templateVersion: string; bindings: Bindings; authoringBindings?: Bindings }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let userId = '';
let projectId = '';
let analysisId = '';
let markBoundSpecId = '';
const savedSpecIds: string[] = [];

async function ok<T>(label: string, call: Promise<APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

function candidatesUrl(suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/candidates${suffix}`);
}

/** A binding is stored as a bare column id (Editor) or `{ column_id }` (API) — read either. */
function columnOf(binding: unknown): string | undefined {
  if (typeof binding === 'string') return binding;
  return (binding as { column_id?: string } | undefined)?.column_id;
}

async function listSpecs(query = ''): Promise<Spec[]> {
  const body = await ok<Spec[] | { data: Spec[] }>('candidates', api.get(candidatesUrl(query)));
  return Array.isArray(body) ? body : body.data;
}

async function createThrowawayProject(): Promise<void> {
  const project = await ok<{ id: string }>('project', api.post(apiUrl('/api/v1/projects'), {
    data: {
      name: `${THROWAWAY} ${Date.now()}`,
      workspaceId: WORKSPACE_ID,
      visibility: 'private',
      createdBy: userId,
    },
  }));
  projectId = project.id;
  expect(PROTECTED_PROJECT_IDS.some((p) => projectId.startsWith(p))).toBe(false);
}

async function createThrowawayAnalysis(): Promise<void> {
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId, datasetId: DATASET_ID, name: `${THROWAWAY} ${Date.now()}`, createdBy: userId },
  }));
  analysisId = va.id;
}

async function createMarkBoundSpec(): Promise<string> {
  const spec = await ok<{ id: string }>('mark-bound spec', api.post(candidatesUrl(), {
    data: {
      templateId: 'heatmap_annotated_v1',
      templateVersion: '1.0.0',
      viewAnalysisId: analysisId,
      bindings: { x: 'reference', y: 'variable', z: 'rho', mark: 'significance' },
      params: {},
      title: `${THROWAWAY} mark-bound`,
    },
  }));
  return spec.id;
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

/** Selects the option whose visible text starts with `columnName` — the Editor
 * renders each option as `"<name> (<logicalType>)"`, so a regex label match
 * is not supported by `selectOption`; resolve the exact `value` first. */
async function selectColumn(select: ReturnType<typeof slotSelect>, columnName: string): Promise<void> {
  const value = await select.locator('option', { hasText: new RegExp(`^${columnName}\\s*\\(`, 'i') }).first().getAttribute('value');
  expect(value, `no option for column "${columnName}"`).toBeTruthy();
  await select.selectOption(value!);
}

async function openEditorWithHeatmap(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${projectId}/view-analyses/${analysisId}`);
  await page.getByRole('tab', { name: 'Editor' }).click();
  const template = page.locator('xpath=//label[normalize-space()="Template"]/following-sibling::div[1]//select');
  await expect(template).toBeVisible({ timeout: 60_000 });
  await template.selectOption({ label: 'Annotated Heatmap' });
  await expect(slotSelect(page, 'X')).toBeVisible();
}

/** Save through the Editor's own button, then return the spec the server stored under that title. */
async function saveAndRead(page: Page, title: string): Promise<Spec> {
  await page.getByPlaceholder('Chart title (optional)').fill(title);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Visualization created successfully')).toBeVisible({ timeout: 20_000 });
  let saved: Spec | undefined;
  await expect.poll(async () => {
    saved = (await listSpecs(`?viewAnalysisId=${analysisId}`)).find((s) => s.title === title);
    return !!saved;
  }, { timeout: 20_000 }).toBe(true);
  savedSpecIds.push(saved!.id);
  return saved!;
}

function chartUrl(specId: string) {
  return `/datasets/${DATASET_ID}/chart/${specId}`;
}

async function openChart(page: Page, specId: string) {
  await page.goto(chartUrl(specId));
  await expect(page.locator('.js-plotly-plot .annotation-text').first()).toBeVisible({ timeout: 60_000 });
}

async function annotationTexts(page: Page): Promise<string[]> {
  const nodes = page.locator('.annotation-text');
  await expect(nodes.first()).toBeVisible();
  return nodes.allTextContents();
}

test.describe('AXI-2305 - the chart Editor offers the Mark slot for Annotated Heatmap', { tag: ['@SI-018', '@SI-033', '@SI-010'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
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
    const me = await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')));
    userId = me.id;
    await createThrowawayProject();
    await createThrowawayAnalysis();
    markBoundSpecId = await createMarkBoundSpec();
  });

  test.afterAll(async () => {
    for (const id of savedSpecIds) {
      await api.delete(candidatesUrl(`/${id}`)).catch(() => undefined);
    }
    if (markBoundSpecId) await api.delete(candidatesUrl(`/${markBoundSpecId}`)).catch(() => undefined);
    if (analysisId) await api.delete(apiUrl(`/api/v1/view-analyses/${analysisId}`)).catch(() => undefined);
    if (projectId) await api.delete(apiUrl(`/api/v1/projects/${projectId}`)).catch(() => undefined);
    await api?.dispose();
  });

  test('S1 - the Editor offers an optional Mark slot for Annotated Heatmap', async ({ page }) => {
    await openEditorWithHeatmap(page);
    await expect(slotSelect(page, 'Mark')).toBeVisible();
    await expect(slotSelect(page, 'Y')).toBeVisible();
    await expect(slotSelect(page, 'Z')).toBeVisible();
  });

  test('S2 - binding Mark=significance and saving persists bindings.mark', async ({ page }) => {
    await openEditorWithHeatmap(page);

    const template = await ok<Template>('template', api.get(apiUrl('/api/v1/templates/heatmap_annotated_v1/1.0.0')));
    expect(Object.keys(template.bindings).sort()).toEqual(['x', 'y', 'z']);
    expect(template.authoringBindings).toEqual({ mark: { role: 'group', required: false } });

    await selectColumn(slotSelect(page, 'X'), 'reference');
    await selectColumn(slotSelect(page, 'Y'), 'variable');
    await selectColumn(slotSelect(page, 'Z'), 'rho');
    await selectColumn(slotSelect(page, 'Mark'), 'significance');

    const title = `${THROWAWAY} mark binding`;
    const saved = await saveAndRead(page, title);
    expect(columnOf(saved.bindings.mark)).toBeTruthy();
    expect(columnOf(saved.bindings.x)).toBeTruthy();
  });

  test('AC2 rendering - a cell mapped by mark_values shows its significance symbol', async ({ page }) => {
    await signIn(page);
    await openChart(page, markBoundSpecId);
    let texts = await annotationTexts(page);
    expect(texts.some((t) => t.includes('*'))).toBe(false);

    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/candidates/${markBoundSpecId}/params`), { timeout: 15_000 });
    await page.getByLabel('Significance Marks (e.g. after_correction: *)').fill('after_correction: *');
    const response = await saved;
    expect(response.ok()).toBe(true);

    await page.reload();
    await expect.poll(async () => {
      texts = await annotationTexts(page);
      return texts.some((t) => t.endsWith('*'));
    }, { timeout: 60_000 }).toBe(true);
  });
});
