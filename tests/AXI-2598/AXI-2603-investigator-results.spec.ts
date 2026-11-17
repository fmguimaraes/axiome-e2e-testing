import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiUrl } from '../../config/env';
import { adminApi, adminToken, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled, seedScope } from '../AXI-2308/harness/new-analysis';
import { INVESTIGATOR_ROLE_ID, addMember, drawnTraces, launchAndDrain, person, signIn, wizardBody, type Person } from '../AXI-2308/harness/result-page';

/**
 * AXI-2603 (epic AXI-2598 — Investigator Handover — FR19, FR20, FR22, FR24, NFR10; AC10, AC11,
 * AC12; EC5, EC10; owner ruling D8/OQ-1): the investigator's result page opens on a rendered chart
 * whose default for a group comparison is the OFFERED strip variant (the box stays selectable,
 * the team page keeps the server's choice); his palette / highlight / group order show at once and
 * are kept for that result; the client report downloads in Markdown and PDF, a PDF that cannot be
 * produced being said in plain words with the Markdown offered; the page carries the RUO notice.
 *
 * Fixture: a WIZARD T2 run (Kruskal-Wallis + Dunn over `cluster_selon_acr_eular_2019`, 4 × 6) in a
 * NEW project of the e2e tenant (read by a fresh Investigator-role member), on a SALTED copy of
 * `opening-templates-paul-header.csv` (never reused from another project's run). Hand-derived:
 * n = 6 per cluster (>= 5) so the server chooses `box_linear_brackets` from the data; the
 * investigator page shows `strip_linear_brackets`. A plan (SAP) run carries the same preset only
 * once AXI-2617 merges — § 7.6 is owed until then.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md` § 7.
 *
 * Run: BASE_URL=<Vite serving the AXI-2603 front> API_BASE_URL=<gateway> E2E_TEST_EMAIL=<platform
 *   admin> E2E_TEST_PASSWORD=<pw> npx playwright test tests/AXI-2598/AXI-2603-* --project=chromium
 * § 7.3b (style kept across a reload) needs the AXI-2603 BACKEND (`PUT …/result-page/chart-style`);
 * against a gateway without the route it is skipped with that reason, never passed.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const IGG4 = 'igg4_g_l';
const KW = 'stats.kruskal_wallis';
const DUNN = 'stats.dunn_posthoc';
const QUESTION = `Does ${IGG4} differ across the clusters?`;

let api: Api;
let t: Tenant;
let investigator: Person;
let runId: string;
let kw: any;

const investigatorPath = () => `/investigator/projects/${t.projectId}/runs/${runId}`;
const resultPageApi = () => `/api/v1/projects/${t.projectId}/runs/${runId}/result-page`;

/** Ingest a salted copy so this project's run is computed here, never reused from another project. */
async function ingestSalted(): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: `axi2603-${nonce}-${FIXTURE}`, contentType: 'text/csv',
  }, t.headers);
  expect(init.status, JSON.stringify(init.body)).toBeLessThan(300);
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csv });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const id = init.body.dataset.id;
  const fin = await api.patch(`/api/v1/workspaces/${t.workspaceId}/datasets/${id}/finalize`, undefined, t.headers);
  expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
  const deadline = Date.now() + 240_000;
  for (;;) {
    const list = asList((await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${id}/ingestions`, t.headers)).body);
    const newest = [...list].sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest?.status === 'ready') return id;
    if (newest?.status === 'failed' || Date.now() > deadline) throw new Error(`ingestion of ${id}: ${JSON.stringify(newest)}`);
    await sleep(2_000);
  }
}

/** His own browser context (never the chromium project's admin storageState), signed in on his page. */
async function openInvestigatorPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, acceptDownloads: true });
  const page = await context.newPage();
  await signIn(page, investigator, t, investigatorPath());
  await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
  return page;
}

/** The drawn box traces' group names in first-seen order, and their marker colour per group. */
async function drawnGroups(page: Page): Promise<{ order: string[]; colour: Record<string, string | null> }> {
  const boxes = (await drawnTraces(page)).filter((tr) => tr.type === 'box' && tr.name !== null);
  const order = [...new Set(boxes.map((b) => b.name as string))];
  return { order, colour: Object.fromEntries(boxes.map((b) => [b.name as string, b.color])) };
}

/** Whether the gateway serves the restyle route (the AXI-2603 backend), probed with an empty body. */
async function restyleRouteServed(): Promise<boolean> {
  const res = await investigator.api.put(apiUrl(`${resultPageApi()}/chart-style`), { data: {} });
  const text = await res.text();
  return !(res.status() === 404 && /Cannot PUT/.test(text));
}

// The suite never records a trace or a video (they would hold the bearer token, NFR6).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test.describe.serial('AXI-2603 investigator results: strip default, style, downloads @SI-018 @SI-033 @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(900_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    const base = await ensureTenant(api);
    const project = await api.post('/api/v1/projects', { name: `E2E AXI-2603 results ${Date.now()}`, workspaceId: base.workspaceId }, base.headers);
    expect(project.status, JSON.stringify(project.body)).toBeLessThan(300);
    t = { ...base, projectId: project.body.id };
    await approveCarriersFor([KW, DUNN]);
    await silenceTours(await adminToken());
    investigator = await person('investigator2603', t.workspaceId);
    await addMember(api, t, investigator, INVESTIGATOR_ROLE_ID);
    await silenceTours(investigator.accessToken);
    const datasetId = await ingestSalted();
    const link = await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
    expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);
    const dataset = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!dataset) throw new Error('fixture dataset could not be anchored');
    // Launched by the provisioner: the Investigator's own wizard is gated on a finalised plan
    // (SAP_EXPLORATION_DISABLED); the page under test is his read of the result.
    runId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', QUESTION, 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: IGG4 },
    ]));
    const served = await api.get(resultPageApi(), t.headers);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    kw = served.body.results.find((r: any) => r.operationId === KW);
    expect(kw?.preset?.variants, JSON.stringify(kw?.preset)).toBeTruthy();
  });

  test.afterAll(async () => {
    await investigator?.api.dispose();
    await api?.ctx.dispose();
  });

  test('AC10 FR19 FR20 D8 — 7.1 the investigator page opens on a rendered chart whose default is the offered strip; the box stays selectable @SI-066 @SI-033', async ({ browser }) => {
    // Arrange — the server chose the box from the data (n 6 per cluster)
    expect(kw.preset.variants).toMatchObject({ selectedKey: 'box_linear_brackets', provenance: { kind: 'deterministic' } });

    // Act
    const page = await openInvestigatorPage(browser);
    const select = page.getByTestId('rp-variant-select');

    // Assert — rendered without any action, as the strip, saying why
    await expect(page.getByTestId('rp-chart').locator('.js-plotly-plot')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('rp-chart')).toHaveAttribute('data-variant-key', 'strip_linear_brackets');
    await expect(select).toHaveValue('strip_linear_brackets');
    await expect(page.getByTestId('rp-variant-provenance')).toHaveText('Strip plot: the default for group comparisons on this page. The box plot stays in the list.');
    await expect.poll(async () => (await page.getByTestId('rp-chart').locator('.js-plotly-plot').evaluate((el) =>
      ((el as unknown as { data?: Array<{ type?: string; boxpoints?: unknown }> }).data ?? []).some((d) => d.type === 'box' && d.boxpoints === 'all'))), { timeout: 30_000 }).toBe(true);

    // Act — the box is one pick away
    await select.selectOption('box_linear_brackets');

    // Assert — the box IS the server's data choice, so it says so (the same provenance a save records)
    await expect(page.getByTestId('rp-chart')).toHaveAttribute('data-variant-key', 'box_linear_brackets');
    await expect(page.getByTestId('rp-variant-provenance')).toHaveText(/^Chosen from the measured data \(variant \d+ of the template's list\)$/);
  });

  test('R4 D8 — 7.2 the team page of the same run keeps the server\'s box and its session-only highlight @SI-033', async ({ page }) => {
    // Arrange
    await seedScope(page, t);

    // Act
    await gotoSettled(page, `/projects/${t.projectId}/runs/${runId}`);
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });

    // Assert
    await expect(page.getByTestId('rp-chart')).toHaveAttribute('data-variant-key', 'box_linear_brackets');
    await expect(page.getByTestId('rp-highlight-select')).toBeVisible();
    await expect(page.getByTestId('rp-style-controls')).toHaveCount(0);
    await expect(page.getByTestId('rp-ruo-notice')).toHaveCount(0);
  });

  test('AC11 FR22 — 7.3a highlight, group order and palette show at once on the drawn chart @SI-066 @SI-033', async ({ browser }) => {
    // Arrange
    const page = await openInvestigatorPage(browser);
    await expect(page.getByTestId('rp-style-controls')).toHaveAttribute('data-style-kind', 'groups');
    const before = (await page.getByTestId('rp-style-group').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))) as string[];

    // Act — highlight the second cluster, move the first one later
    await page.getByTestId('rp-style-highlight').selectOption(before[1]);
    await page.getByTestId('rp-style-group-down').first().click();

    // Assert — the drawn chart follows at once: accent on the highlighted group, muted elsewhere, the new order
    const expectedOrder = [before[1], before[0], ...before.slice(2)];
    await expect.poll(async () => (await drawnGroups(page)).order, { timeout: 30_000 }).toEqual(expectedOrder);
    const { colour } = await drawnGroups(page);
    expect(colour[before[1]]).toBe(kw.style.accentColor);
    for (const g of before.filter((x) => x !== before[1])) expect(colour[g]).toBe(kw.style.mutedColor);

    // Act — a named palette, with no highlight (the palette colours the groups)
    await page.getByTestId('rp-style-highlight').selectOption('');
    await page.getByTestId('rp-style-palette').selectOption('colour-blind-safe');

    // Assert
    await expect.poll(async () => (await drawnGroups(page)).colour[expectedOrder[0]], { timeout: 30_000 }).toBe('#0072B2');
    await expect(page.getByTestId('rp-style-status')).toBeVisible();
  });

  test('AC11 FR22 — 7.3b the style is kept for that result: a reload shows it @SI-066 @SI-018', async ({ browser }) => {
    // Arrange
    const served = await restyleRouteServed();
    test.skip(!served, 'owed after merge of AXI-2603: the gateway under test does not serve PUT …/result-page/chart-style');
    const page = await openInvestigatorPage(browser);
    await page.getByTestId('rp-style-palette').selectOption('greys');
    await expect(page.getByTestId('rp-style-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });

    // Act
    await page.reload();
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });

    // Assert — the page read serves the kept style
    await expect(page.getByTestId('rp-style-palette')).toHaveValue('greys');
    const reread = await api.get(resultPageApi(), t.headers);
    expect(reread.body.results.find((r: any) => r.operationId === KW).style.palette).toEqual(['#252525', '#636363', '#969696', '#BDBDBD']);
  });

  test('NFR10 — 7.5 the investigator result page carries the research-use-only notice @SI-066', async ({ browser }) => {
    // Arrange / Act
    const page = await openInvestigatorPage(browser);

    // Assert
    await expect(page.getByTestId('rp-ruo-notice')).toHaveText('For Research Use Only. Not for use in diagnostic procedures.');
  });

  test('AC12 FR24 FR25 EC10 D20 — 7.4 one download menu offers the report PDF, the figure and the table; a PDF not produced says so and offers the Markdown @SI-066 @SI-018', async ({ browser }) => {
    // Arrange (AXI-2626: the three former report buttons collapse into one "Download" menu)
    const page = await openInvestigatorPage(browser);

    // Act — open the menu: exactly PDF, SVG, PNG, never a stand-alone Markdown button
    await page.getByTestId('rp-export-menu').click();
    await expect(page.getByTestId('rp-export-pdf')).toBeVisible();
    await expect(page.getByTestId('rp-export-svg')).toBeVisible();
    await expect(page.getByTestId('rp-export-png')).toBeVisible();
    await expect(page.getByTestId('rp-export-md')).toHaveCount(0);

    // Act — PDF: either a .pdf download, or the plain-words notice with the Markdown offered
    const pdf = page.waitForEvent('download', { timeout: 60_000 }).then((d) => ({ kind: 'file' as const, d })).catch(() => null);
    await page.getByTestId('rp-export-pdf').click();
    const notice = page.getByTestId('rp-export-pdf-unavailable');
    const outcome = await Promise.race([pdf, notice.waitFor({ timeout: 60_000 }).then(() => ({ kind: 'notice' as const }))]);

    // Assert — never silent
    expect(outcome, 'the PDF neither downloaded nor was said to be unavailable').not.toBeNull();
    if (outcome?.kind === 'file') {
      expect(outcome.d.suggestedFilename()).toMatch(/\.pdf$/);
    } else {
      await expect(notice).toHaveText(/The PDF of this report could not be produced\. The report is available in Markdown\./);
      const [fallback] = await Promise.all([page.waitForEvent('download'), page.getByTestId('rp-export-pdf-fallback-md').click()]);
      expect(fallback.suggestedFilename()).toMatch(/\.md$/);
    }

    // Act — reopen the menu and export the figure as SVG, then PNG
    await page.getByTestId('rp-export-menu').click();
    const svgDownload = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('rp-export-svg').click();
    expect((await svgDownload).suggestedFilename()).toMatch(/\.svg$/);
    await page.getByTestId('rp-export-menu').click();
    const pngDownload = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('rp-export-png').click();
    expect((await pngDownload).suggestedFilename()).toMatch(/\.png$/);
  });
});
