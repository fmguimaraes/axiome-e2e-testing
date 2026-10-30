import { inflateRawSync } from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { gotoSettled, seedScope } from './harness/new-analysis';
import { launchAndDrain, wizardBody } from './harness/result-page';

/**
 * AXI-2331 (epic AXI-2308 — FR34, AC26, AC27, AC29, AC38, EC11, NFR4, NFR6): the result
 * page's four export buttons (CSV, SVG, PNG 300 dpi, report) — a CONSUMER of the
 * Headless engine's own shared contract, `GET
 * /api/v1/projects/:projectId/rule-runs/:ruleRunId/exports/:kind`
 * (`libs/contracts/src/run-export/run-export.contract.ts`). This spec proves the
 * FRONT's button wiring only — each button fires that one route for the ACTIVE tab's
 * OWN `ruleRunId` and the browser downloads the engine's own bytes, nothing rendered
 * or recomputed client-side. The route's own behavior (file bytes, 300 dpi, dedup,
 * forbidden-content scan) is proven exhaustively by
 * `tests/AXI-2309/AXI-2311-client-report.spec.ts` and
 * `tests/AXI-2309/AXI-2313-exports-api.spec.ts` and is not re-verified here.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2331 (.3–.6).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339).
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2331-* --project=chromium --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers
 * (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const PX_PER_METRE_300_DPI = 11811;
const FORBIDDEN_MARKERS = ['AWS_ACCESS_KEY', 'postgresql://', 'amqp://', 'BEGIN PRIVATE KEY'];

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let t1RunId: string;
let t2GovernedRunId: string;
let t2Run1Id: string;
let t2Run2Id: string;

const pagePath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;
const exportUrlPattern = (ruleRunId: string, kind: string) =>
  new RegExp(`/api/v1/projects/${t.projectId}/rule-runs/${ruleRunId}/exports/${kind}$`);

async function openTeamPage(page: Page, runId: string): Promise<void> {
  await seedScope(page, t);
  await gotoSettled(page, pagePath(runId));
  await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
}

/** Click an export button and wait for its own request/response pair, for `ruleRunId`. */
async function clickExport(page: Page, kind: 'csv' | 'svg' | 'png' | 'report', ruleRunId: string) {
  const response = page.waitForResponse((r) => exportUrlPattern(ruleRunId, kind).test(r.url()));
  await page.getByTestId(`rp-export-${kind}`).click();
  return response;
}

function readZip(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const name = zip.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength;
    entries.set(name, inflateRawSync(zip.subarray(start, start + size)));
    offset = start + size;
  }
  return entries;
}

function pngPhys(png: Buffer): [number, number, number] | null {
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'pHYs') return [png.readUInt32BE(offset + 8), png.readUInt32BE(offset + 12), png[offset + 16]];
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return null;
}

test.describe.serial('AXI-2331 result page export buttons — CSV, SVG, PNG 300 dpi, report @SI-066 @SI-033 @SI-013 @SI-010 @SI-002 @SI-018', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u', 'stats.kruskal_wallis', 'stats.dunn_posthoc']);
    await silenceTours(await adminToken());
    t1RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T1', 'Does igg4_g_l differ by sex?', 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
    t2GovernedRunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', 'Does igg4_g_l differ across the clusters?', 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
    const served = await api.get(`/api/v1/projects/${t.projectId}/runs/${t2GovernedRunId}/result-page`, t.headers);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    expect(served.body.results.length).toBeGreaterThanOrEqual(2);
    t2Run1Id = served.body.results[0].ruleRunId;
    t2Run2Id = served.body.results[1].ruleRunId;
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AC26 AC29 — AXI-2331.3 the report already exists and downloads with the question verbatim at its top @SI-066 @SI-033 @SI-013 @SI-002 @SI-018', async ({ page }) => {
    // Arrange
    await openTeamPage(page, t1RunId);
    await expect(page.getByTestId('rp-export-buttons')).toBeVisible();

    // Act
    const response = await clickExport(page, 'report', t1RunId);

    // Assert
    expect(response.status(), await response.text().catch(() => '')).toBe(200);
    expect(response.headers()['content-type']).toContain('zip');
    const zip = readZip(await response.body());
    const reportMd = zip.get('report.md')?.toString('utf8');
    expect(reportMd).toBeDefined();
    expect(reportMd).toContain('Does igg4_g_l differ by sex?');
  });

  test('AC27 EC11 NFR4 — AXI-2331.4 CSV, SVG and 300 dpi PNG export the run\'s own file, with a busy/disabled button while in flight @SI-066 @SI-033 @SI-013 @SI-002 @SI-018', async ({ page }) => {
    // Arrange
    await openTeamPage(page, t1RunId);

    // Act — CSV
    const csv = await clickExport(page, 'csv', t1RunId);

    // Assert
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');

    // Act — SVG
    const svg = await clickExport(page, 'svg', t1RunId);

    // Assert
    expect(svg.status()).toBe(200);
    expect(svg.headers()['content-type']).toContain('svg');

    // Act — PNG, asserting the busy/disabled state while the request is in flight
    const pngRequest = page.waitForResponse((r) => exportUrlPattern(t1RunId, 'png').test(r.url()));
    await page.getByTestId('rp-export-png').click();
    await expect(page.getByTestId('rp-export-png')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('rp-export-csv')).toBeDisabled();
    const png = await pngRequest;

    // Assert
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toBe('image/png');
    const phys = pngPhys(await png.body());
    expect(phys).toEqual([PX_PER_METRE_300_DPI, PX_PER_METRE_300_DPI, 1]);
    await expect(page.getByTestId('rp-export-png')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('rp-export-csv')).toBeEnabled();
  });

  test('AC27 — AXI-2331.5 T2: each tab\'s export button targets that tab\'s OWN ruleRunId @SI-066 @SI-033 @SI-013', async ({ page }) => {
    // Arrange
    await openTeamPage(page, t2GovernedRunId);
    expect(t2Run1Id).not.toBe(t2Run2Id);

    // Act — first tab
    const first = await clickExport(page, 'csv', t2Run1Id);

    // Assert
    expect(first.status()).toBe(200);

    // Act — second tab
    await page.getByTestId('rp-next').click();
    const second = await clickExport(page, 'csv', t2Run2Id);

    // Assert
    expect(second.status()).toBe(200);
  });

  test('AC38 NFR6 — AXI-2331.6 no secret, host or connection string leaves in the CSV or the report zip @SI-013 @SI-018', async ({ page }) => {
    // Arrange
    await openTeamPage(page, t1RunId);

    // Act
    const csv = await clickExport(page, 'csv', t1RunId);
    const report = await clickExport(page, 'report', t1RunId);
    const csvText = (await csv.body()).toString('utf8');
    const zip = readZip(await report.body());
    const reportText = [...zip.values()].map((b) => b.toString('utf8')).join('\n');

    // Assert
    for (const marker of FORBIDDEN_MARKERS) {
      expect(csvText).not.toContain(marker);
      expect(reportText).not.toContain(marker);
    }
  });
});
