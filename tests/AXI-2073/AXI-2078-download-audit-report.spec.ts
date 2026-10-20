import { readFileSync } from 'node:fs';
import { test, expect, Page, request as apiRequest } from '@playwright/test';
import { ROLES } from '../../config/roles';
import { ensureAuthTokens } from '../../config/auth';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, createAnalysis, createSnapshot, frozenRenderPayload, uniq, type Tenant } from '../AXI-1233/harness/seed-axi1234';

/**
 * AXI-2078 (epic AXI-2073, FR15/AC9) — "Download audit report" action on the
 * evidence detail page.
 *
 * Covers: the button is offered for the EVIDENCE VERSION actually shown
 * (AC9); clicking it downloads `audit-<evidenceId>-v<versionNumber>.zip`
 * (FR15), against the endpoint contract AXI-2077 implements
 * (`GET /view-analyses/evidences/:evidenceId/versions/:versionNumber/audit-report`); a 403
 * response is mapped to a user-facing error, never a silent failure.
 *
 * The "visible" and "403 mapping" scenarios exercise the front end only (the
 * button's presence, and its handling of an error status) and run against
 * any stack with this story's front end. The "triggers a real download"
 * scenario calls AXI-2077's endpoint for real and needs that story's route
 * live on the stack under test — see the story report / manual-e2e doc for
 * run disposition if it is not yet deployed.
 */

let api: Api;
let t: Tenant;
let adminTokens: { accessToken: string; refreshToken: string };
let evidenceId: string;
let versionNumber: number;
let viewAnalysisId: string;

async function createEvidenceWithChart(analysisId: string): Promise<{ id: string; versionNumber: number }> {
  const specId = `spec-${uniq()}`;
  // A cited chart must name a REAL snapshot: EvidenceVersion.snapshotIds is a
  // non-null String[], so `snapshotId: null` 500s at persistence.
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries: [
      { chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId }) },
    ],
    title: `AXI-2078 ${uniq()}`,
    createdBy: 'e2e-axi-2078',
  }, t.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { id: res.body.id, versionNumber: res.body.currentVersion.versionNumber };
}

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  viewAnalysisId = await createAnalysis(api, t, `AXI-2078 ${uniq()}`);
  const evidence = await createEvidenceWithChart(viewAnalysisId);
  evidenceId = evidence.id;
  versionNumber = evidence.versionNumber;

  const bootstrap = await apiRequest.newContext();
  const adminRole = ROLES.find((r) => r.name === 'admin')!;
  adminTokens = await ensureAuthTokens(bootstrap, adminRole);
  await bootstrap.dispose();
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

/** Seed the browser with fresh admin tokens + the fixture workspace/org,
 *  mirroring the canonical pattern (AXI-1244 `seedBrowserSession`). */
async function openEvidenceDetail(page: Page): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws, org]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [adminTokens.accessToken, adminTokens.refreshToken, t.workspaceId, t.orgId] as const,
  );
  await page.goto(`/projects/${t.projectId}/view-analyses/${viewAnalysisId}/evidences/${evidenceId}`);
  await expect(page.getByTestId('download-audit-report-button')).toBeVisible();
}

test.describe('AXI-2078 — download audit report action (FR15/AC9)', () => {
  test('AC9 — the evidence detail page offers "Download audit report" for the version shown', async ({ page }) => {
    await openEvidenceDetail(page);
    const button = page.getByTestId('download-audit-report-button');
    await expect(button).toBeEnabled();
    await expect(button).toHaveAccessibleName('Download audit report');
    // The button badge beside the title names the SAME version it downloads.
    await expect(page.getByText(`v${versionNumber}`, { exact: true })).toBeVisible();
  });

  test('a 403 from the endpoint shows a user-facing error, never a silent failure', async ({ page }) => {
    await openEvidenceDetail(page);
    await page.route(`**/api/v1/view-analyses/evidences/${evidenceId}/versions/${versionNumber}/audit-report`, (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Forbidden' }) }),
    );

    await page.getByTestId('download-audit-report-button').click();

    await expect(page.getByText(/do not have access to this evidence's audit report/i)).toBeVisible();
  });

  test('FR15 — clicking the button downloads audit-<evidenceId>-v<versionNumber>.zip', async ({ page }) => {
    await openEvidenceDetail(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-audit-report-button').click(),
    ]);

    expect(download.suggestedFilename()).toBe(`audit-${evidenceId}-v${versionNumber}.zip`);
    const bytes = readFileSync(await download.path());
    expect(bytes.length).toBeGreaterThan(0);
  });
});
