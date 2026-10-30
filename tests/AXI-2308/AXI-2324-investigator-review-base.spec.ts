import { APIRequestContext, APIResponse, expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { createAnalysis, createSnapshot, ensureTenant, frozenRenderPayload, uniq, type Tenant } from '../AXI-1233/harness/seed-axi1234';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2324 (epic AXI-2308 — Platform Opening: Human Guided) — the Investigator
 * surface on the review base: B1 outcome + owner ruling A (feature doc §17 D18).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2324 §.3–§.8.
 *
 * Self-provisioned. The platform admin seeds (or reuses) the AXI-1233 fixture
 * tenant (`de_small.csv`, never a demo project), creates ONE real chart spec
 * on its dataset, an analysis whose evidence cites that chart, an
 * interpretation approved by a SECOND throwaway member (AXI-2258 forbids
 * self-approval) and publishes it. The Investigator and the Reviewer are
 * throwaway self-registered users holding ONLY a membership role. A second,
 * fresh workspace (PrivateProjectsWorld) hosts an outsider Investigator for the
 * framing tenancy probe. Memberships are removed in afterAll.
 *
 * The study is made active through the same localStorage keys the team's top
 * menu writes: choosing the study on arrival is AXI-2323 (FR8/FR9, not built),
 * so this spec stands in for it and says so.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const REVIEWER_ROLE_ID = '00000000-0000-0000-0000-000000000101';
const PASSWORD = 'AXI2324-e2e-pw!';

interface Person {
  email: string;
  userId: string;
  accessToken: string;
  api: APIRequestContext;
}

let admin: Api;
let t: Tenant;
let approver: Person;
let investigator: Person;
let reviewer: Person;
let outsider: Person;
let outsideWorld: PrivateProjectsWorld;
let specId: string;
let analysisId: string;
let publishedVersionId: string;
const reviewQuestion = `AXI-2324 does log2 fold change track base mean? ${uniq()}`;
const analysisName = `AXI-2324 review base ${uniq()}`;
const interpretationLabel = `AXI-2324 interpretation ${uniq()}`;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2324-${label}-${uniq()}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2324', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, userId: me.id, accessToken, api };
}

async function addMember(p: Person, membership: { role: string } | { roleId: string }): Promise<void> {
  const res = await admin.post(
    `/api/v1/workspaces/${t.workspaceId}/members`,
    { userId: p.userId, organizationId: t.orgId, ...membership },
    t.headers,
  );
  expect(res.status, `add member: ${JSON.stringify(res.body)}`).toBeLessThan(300);
}

function ok<T = any>(what: string, res: { status: number; body: T }): T {
  expect(res.status, `${what} -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

/** A real chart spec on the fixture dataset — the one the published figure renders from. */
async function realChartSpec(): Promise<string> {
  const base = `/api/v1/workspaces/${t.workspaceId}/datasets/${t.datasetId}/candidates`;
  let specs: Array<{ id: string }> = ok('list candidates', await admin.get(base, t.headers));
  if (!Array.isArray(specs) || specs.length === 0) {
    ok('regenerate candidates', await admin.post(`${base}/regenerate`, {}, t.headers));
    specs = ok('list candidates', await admin.get(base, t.headers));
  }
  expect(specs.length, 'the fixture dataset has at least one chart spec').toBeGreaterThan(0);
  return specs[0].id;
}

async function seedPublishedQuestion(): Promise<void> {
  specId = await realChartSpec();
  analysisId = await createAnalysis(admin, t, analysisName);
  ok('review question', await admin.patch(`/api/v1/view-analyses/${analysisId}/review-question`, { text: reviewQuestion }, t.headers));
  const snapshotId = await createSnapshot(admin, t, analysisId, []);
  const evidence = ok('create evidence', await admin.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries: [{
      chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId,
      frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId }),
    }],
    title: `AXI-2324 evidence ${uniq()}`,
    createdBy: 'e2e-axi-2324',
  }, t.headers));
  const decision = ok('create interpretation', await admin.post(`/api/v1/workspaces/${t.workspaceId}/decisions`, {
    label: interpretationLabel,
    type: 'biomarker_threshold',
    projectId: t.projectId,
    context: { intendedUse: 'RUO' },
    evidenceLinks: [{ evidenceId: evidence.id, evidenceVersionId: evidence.currentVersionId }],
    evidenceValues: [],
  }, t.headers));
  ok('reviewed', await admin.post(`/api/v1/workspaces/${t.workspaceId}/decisions/${decision.id}/transition`, { targetStatus: 'reviewed' }, t.headers));
  const approved = await approver.api.post(apiUrl(`/api/v1/workspaces/${t.workspaceId}/decisions/${decision.id}/transition`), { data: { targetStatus: 'approved' } });
  expect(approved.status(), `approve: ${await approved.text()}`).toBeLessThan(300);
  const published = ok('publish', await admin.post('/api/v1/view-analyses/publish', {
    viewAnalysisId: analysisId,
    evidenceVersionIds: [evidence.currentVersionId],
    decisionIds: [decision.id],
    publishedBy: 'e2e-axi-2324',
  }, t.headers));
  publishedVersionId = published.id;
  expect(published.status).toBe('published');
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  admin = await adminApi();
  t = await ensureTenant(admin);
  approver = await person('approver', t.workspaceId);
  investigator = await person('investigator', t.workspaceId);
  reviewer = await person('reviewer', t.workspaceId);
  await addMember(approver, { role: 'admin' });
  await addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await addMember(reviewer, { roleId: REVIEWER_ROLE_ID });
  await seedPublishedQuestion();

  outsideWorld = await PrivateProjectsWorld.create();
  outsider = await person('outsider', outsideWorld.workspaceId);
  await outsideWorld.addMember(outsider, { roleId: INVESTIGATOR_ROLE_ID });
  await outsideWorld.leaveWorkspace();

  for (const p of [investigator, reviewer]) await silenceTours(p.accessToken);
});

test.afterAll(async () => {
  for (const p of [approver, investigator, reviewer]) {
    if (p) await admin.ctx.delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/members/${p.userId}`), { headers: t.headers }).catch(() => undefined);
  }
  for (const p of [approver, investigator, reviewer, outsider]) await p?.api.dispose();
  await outsideWorld?.dispose();
  await admin?.ctx.dispose();
});

/**
 * Sign in through the real login page, then open `landing` with the study
 * active (AXI-2323 stand-in, see header). The study keys are written after
 * sign-in and read by ONE full page load: the app's WorkspaceContext removes
 * `axiome-active-workspace` from localStorage whenever it mounts before the
 * session is restored (the login page, and any hard load), so a second full
 * load would come up with no study. Later moves are in-app navigation.
 */
async function signIn(page: Page, p: Person, landing: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(p.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.evaluate(([orgId, workspaceId, projectId]) => {
    localStorage.setItem('axiome-top-org', orgId as string);
    localStorage.setItem('axiome-active-workspace', workspaceId as string);
    localStorage.setItem('axiome-active-project', projectId as string);
  }, [t.orgId, t.workspaceId, t.projectId]);
  await page.goto(landing);
  await expect(page).not.toHaveURL(/\/login/);
}

/** Every gateway call the page makes, as `METHOD path` with its status. */
function recordApi(page: Page): Array<{ key: string; status: number }> {
  const seen: Array<{ key: string; status: number }> = [];
  page.on('response', (r) => {
    const m = r.url().match(/\/api\/v1(\/[^?]*)/);
    if (m) seen.push({ key: `${r.request().method()} ${m[1]}`, status: r.status() });
  });
  return seen;
}

async function inAppLinks(page: Page): Promise<string[]> {
  return page.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
}

test.describe('AXI-2324 — Investigator surface on the review base @SI-066 @SI-036 @SI-034 @SI-010', () => {
  test('AC9 — §.3 his results list opens the published question with its figure and record @SI-066 @SI-036 @SI-034 @SI-010', async ({ page }) => {
    // Arrange
    test.setTimeout(120_000);
    const calls = recordApi(page);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await signIn(page, investigator, '/investigator');
    await expect(page).toHaveURL(/\/investigator$/);

    // Act
    await page.getByTestId('investigator-nav-results').click();
    await expect(page).toHaveURL(/\/investigator\/results$/);
    const row = page.getByRole('link', { name: new RegExp(analysisName) });
    await row.click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`/investigator/results/${publishedVersionId}`));
    await expect(page.getByText(interpretationLabel).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    const ok200 = (re: RegExp) => calls.some((c) => re.test(c.key) && c.status === 200);
    expect(ok200(/^GET \/workspaces\/[^/]+\/datasets\/[^/]+\/candidates/), 'chart spec read').toBe(true);
    expect(ok200(/^POST \/workspaces\/[^/]+\/datasets\/[^/]+\/query$/), 'row query').toBe(true);
    expect(ok200(new RegExp(`^GET /view-analyses/${analysisId}/framing$`)), 'framing read').toBe(true);
    expect(errors).toEqual([]);
  });

  test('AC9 — §.4 team-only actions are absent; the rule catalogue is neither requested nor granted @SI-066 @SI-034', async ({ page }) => {
    // Arrange
    test.setTimeout(120_000);
    const calls = recordApi(page);
    await signIn(page, investigator, `/investigator/results/${publishedVersionId}`);

    // Act
    await expect(page.getByText(interpretationLabel).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 45_000 });
    const operations = await investigator.api.get(apiUrl('/api/v1/rule-runs/operations'));

    // Assert
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
    for (const name of ['Provenance', 'Discussion', 'Workspace analysis']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    expect(calls.filter((c) => /rule-runs\/operations|snapshot-comments/.test(c.key))).toEqual([]);
    expect(operations.status()).toBe(403);
  });

  test('AC9 — §.5 every link on his pages stays under /investigator @SI-066 @SI-036', async ({ page }) => {
    // Arrange
    test.setTimeout(120_000);
    await signIn(page, investigator, '/investigator/results');

    // Act
    const row = page.getByRole('link', { name: new RegExp(analysisName) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    const listLinks = await inAppLinks(page);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/investigator/results/${publishedVersionId}`));
    await expect(page.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 45_000 });
    const detailLinks = await inAppLinks(page);
    await page.getByRole('button', { name: 'Export' }).click();
    const preview = await page.getByRole('link', { name: 'Open full-page preview' }).getAttribute('href');

    // Assert
    expect([...listLinks, ...detailLinks].filter((href) => !href.startsWith('/investigator'))).toEqual([]);
    expect(preview).toBe(`/investigator/results/${publishedVersionId}/export-preview`);
  });

  test('AC9 — §.6 the opened reads stay reads; every write and other read stays denied @SI-010', async () => {
    // Arrange
    const ws = t.workspaceId;
    const candidates = `/api/v1/workspaces/${ws}/datasets/${t.datasetId}/candidates`;
    const refused: Array<[string, () => Promise<APIResponse>]> = [
      ['POST candidates', () => investigator.api.post(apiUrl(candidates), { data: { templateId: 'scatter_v1', templateVersion: '1.0.0', bindings: {} } })],
      ['PATCH candidates/:id/title', () => investigator.api.patch(apiUrl(`${candidates}/${specId}/title`), { data: { title: 'x' } })],
      ['GET candidates/:id/fitting-runs', () => investigator.api.get(apiUrl(`${candidates}/${specId}/fitting-runs`))],
      ['PATCH review-question', () => investigator.api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/review-question`), { data: { text: 'x' } })],
      ['POST assumptions', () => investigator.api.post(apiUrl(`/api/v1/view-analyses/${analysisId}/assumptions`), { data: { type: 'other', text: 'x' } })],
      ['GET snapshot-comments', () => investigator.api.get(apiUrl(`/api/v1/snapshot-comments?anchorType=published_analysis_version&anchorId=${publishedVersionId}`))],
      ['POST snapshot-comments', () => investigator.api.post(apiUrl('/api/v1/snapshot-comments'), { data: { anchorType: 'published_analysis_version', anchorId: publishedVersionId, content: 'x' } })],
      ['POST styling-presets', () => investigator.api.post(apiUrl('/api/v1/styling-presets'), { data: { name: 'x' } })],
      ['GET users/extended/list', () => investigator.api.get(apiUrl('/api/v1/users/extended/list'))],
      ['GET users', () => investigator.api.get(apiUrl('/api/v1/users'))],
    ];

    // Act
    const outcomes: string[] = [];
    for (const [label, call] of refused) outcomes.push(`${label} ${(await call()).status()}`);
    const name = await investigator.api.get(apiUrl(`/api/v1/users/extended/${approver.userId}`));
    const count = await investigator.api.get(apiUrl(`/api/v1/snapshot-comments/count?anchorType=published_analysis_version&anchorId=${publishedVersionId}`));
    const presets = await investigator.api.get(apiUrl('/api/v1/styling-presets'));

    // Assert
    expect(outcomes).toEqual(refused.map(([label]) => `${label} 403`));
    expect(name.status()).toBe(200);
    expect(await name.json()).toEqual({ id: approver.userId, firstName: 'AXI2324', lastName: 'approver' });
    expect(count.status()).toBe(200);
    expect(presets.status()).toBe(200);
  });

  test('AC9 — §.7 the framing read never serves a view of another workspace @SI-010', async () => {
    // Act — the outsider is an Investigator of a DIFFERENT workspace (his header names it)
    const foreign = await outsider.api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/framing`));
    const own = await investigator.api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/framing`));

    // Assert
    expect(foreign.status()).toBe(404);
    expect(await foreign.text()).not.toContain(reviewQuestion);
    expect(own.status()).toBe(200);
    expect((await own.json()).reviewQuestion?.text).toBe(reviewQuestion);
  });

  test('AC9 — §.8 the team review page is unchanged for the membership-only Reviewer @SI-036 @SI-034', async ({ page }) => {
    // Arrange
    test.setTimeout(120_000);
    // Act
    await signIn(page, reviewer, `/sponsor-review/questions/${publishedVersionId}`);

    // Assert
    await expect(page.getByText(interpretationLabel).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: 'Provenance' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Discussion/ })).toBeVisible();
    await expect(page.getByTestId('investigator-surface')).toHaveCount(0);
  });
});
