import { test, expect, request as apiRequest } from '@playwright/test';
import { ROLES } from '../../config/roles';
import { ensureAuthTokens } from '../../config/auth';
import { apiUrl } from '../../config/env';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, createAnalysis, createSnapshot, frozenRenderPayload, uniq, type Tenant } from '../AXI-1233/harness/seed-axi1234';

/**
 * AXI-2077 (epic AXI-2073, FR14/NFR1/NFR3/AC8/AC11) — the audit report
 * endpoint itself, exercised at the HTTP/API layer (no browser needed — this
 * is a gateway route, not a UI surface; AXI-2078's spec covers the UI
 * action against the SAME contract).
 *
 * Endpoint contract:
 *   GET /api/v1/view-analyses/evidences/:evidenceId/versions/:versionNumber/audit-report
 *   -> 200 application/zip, Content-Disposition: attachment;
 *      filename="audit-<evidenceId>-v<versionNumber>.zip"
 *   -> 404 unknown evidence/version, or another workspace's evidence
 *   -> 400 a non-positive-integer versionNumber
 *   -> 403 no read access (see the story's manual-e2e decision note: the
 *      gateway's own tenancy convention turns cross-tenant into 404
 *      everywhere, so a genuine 403 has no live path through the real
 *      stack today — this scenario is authored via route interception,
 *      mirroring AXI-2078's own precedent for the identical status code).
 */

let api: Api;
let t: Tenant;
let adminTokens: { accessToken: string; refreshToken: string };
let evidenceId: string;
let versionNumber: number;

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
    title: `AXI-2077 ${uniq()}`,
    createdBy: 'e2e-axi-2077',
  }, t.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { id: res.body.id, versionNumber: res.body.currentVersion.versionNumber };
}

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  const viewAnalysisId = await createAnalysis(api, t, `AXI-2077 ${uniq()}`);
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

// Absolute API URL: the `request` fixture's baseURL is the FRONTEND, which
// answers every unknown path with the SPA's index.html (200 text/html).
function auditReportUrl(evId: string, v: number | string): string {
  return apiUrl(`/api/v1/view-analyses/evidences/${evId}/versions/${v}/audit-report`);
}

test.describe('AXI-2077 — audit report endpoint (FR14, NFR1, NFR3, AC8, AC11)', () => {
  test('AC11/FR14 — a member of the owning workspace downloads 200 application/zip with the exact Content-Disposition filename', async ({ request }) => {
    const response = await request.get(auditReportUrl(evidenceId, versionNumber), {
      headers: {
        Authorization: `Bearer ${adminTokens.accessToken}`,
        'X-Workspace-Id': t.workspaceId,
      },
    });

    expect(response.status(), await response.text().catch(() => '')).toBe(200);
    expect(response.headers()['content-type']).toContain('application/zip');
    expect(response.headers()['content-disposition']).toBe(
      `attachment; filename="audit-${evidenceId}-v${versionNumber}.zip"`,
    );
    const body = await response.body();
    expect(body.length).toBeGreaterThan(0);
  });

  test('AC8/FR14 — an unknown evidence id -> 404', async ({ request }) => {
    const response = await request.get(auditReportUrl('00000000-0000-0000-0000-000000000000', 1), {
      headers: {
        Authorization: `Bearer ${adminTokens.accessToken}`,
        'X-Workspace-Id': t.workspaceId,
      },
    });

    expect(response.status()).toBe(404);
  });

  test('AC8/FR14 — a request scoped to a DIFFERENT workspace than the one that owns the evidence -> 404 (cross-tenant, never 403)', async ({ request }) => {
    const otherWorkspace = await request.post(apiUrl('/api/v1/workspaces'), {
      headers: { Authorization: `Bearer ${adminTokens.accessToken}` },
      data: { name: `AXI-2077 Other WS ${uniq()}`, type: 'internal', ownerOrganizationId: t.orgId },
    });
    expect(otherWorkspace.status()).toBeLessThan(300);
    const otherWorkspaceId = (await otherWorkspace.json()).id;

    const response = await request.get(auditReportUrl(evidenceId, versionNumber), {
      headers: {
        Authorization: `Bearer ${adminTokens.accessToken}`,
        'X-Workspace-Id': otherWorkspaceId,
      },
    });

    expect(response.status()).toBe(404);
  });

  test('NFR3 — a non-positive-integer versionNumber is refused with 400, never forwarded as NaN', async ({ request }) => {
    for (const bad of ['0', '-1', 'not-a-number', '1.5']) {
      const response = await request.get(auditReportUrl(evidenceId, bad), {
        headers: {
          Authorization: `Bearer ${adminTokens.accessToken}`,
          'X-Workspace-Id': t.workspaceId,
        },
      });
      expect(response.status(), `versionNumber=${bad}`).toBe(400);
    }
  });

  // See the manual-e2e decision note: 403 has no live path through the real
  // gateway for this endpoint today (cross-tenant is 404 by the house
  // tenancy convention). Mirrors AXI-2078's own route-interception approach
  // for this status.
  test('AC8/FR14 — a 403 from the endpoint is a distinct status from 404 (contract-level, route interception)', async ({ page }) => {
    // page.route intercepts BROWSER traffic only — page.request bypasses it,
    // so the call goes through an in-page fetch.
    await page.route(auditReportUrl(evidenceId, versionNumber), (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ message: 'Forbidden' }),
      }),
    );
    const status = await page.evaluate(async (url) => (await fetch(url)).status, auditReportUrl(evidenceId, versionNumber));
    expect(status).toBe(403);
  });
});
