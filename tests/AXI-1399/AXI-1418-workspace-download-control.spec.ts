import { test, expect, type Page } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ingestFixture, type Tenant } from '../AXI-1400/harness/seed';

/**
 * AXI-1418 — Surface-spec download control on the PROJECT dataset-detail page
 * (manual-e2e AXI-1396-Governed-Statistical-Analysis-Surface.md §4.17; epic
 * AXI-1399; FR30, AC17).
 *
 * AXI-1399 W5 relocation: the build-generated governed-statistical-surface
 * markdown (AXI-1417, SI-017) is served as a plain static file, and its
 * download control now lives on the PROJECT dataset-detail page
 * (`/projects/:projectId/datasets/:datasetId`, `DatasetDetail.tsx` in project
 * mode) — where a reviewer/collaborator/LLM is actually working with the
 * dataset — rather than the workspace page it originally shipped on. No API
 * endpoint, no backend fetch: the anchor points at the committed copy under
 * `axiome-front/public/`, per the feature's thin static-serving intent
 * (§7 "Downloading the surface spec").
 *
 * This spec is a read-only UI liveness proxy. It self-provisions an additive
 * project + a linked, ingested dataset over the public API (reuse-or-create by
 * stable name — idempotent on the shared demo DB, via the AXI-1400 seed
 * harness), opens that dataset's project-context detail page in the browser,
 * and asserts the download control is present and wired to the expected static
 * path. It does not assert the artifact's *content* (that is AXI-1417/SI-017's
 * own drift-guard responsibility). Auth is the suite-wide admin storageState;
 * only the workspace/org scope the SPA reads from localStorage is pinned here
 * (mirrors AXI-1419).
 */

const SURFACE_SPEC_HREF = '/GOVERNED-STATISTICAL-SURFACE.md';
const SURFACE_SPEC_FILENAME = 'GOVERNED-STATISTICAL-SURFACE.md';

let api: Api;
let tenant: Tenant;
let datasetId: string;

/** Pin workspace/org scope the SPA reads from localStorage (mirrors AXI-1419). */
async function seedWorkspaceScope(page: Page): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [tenant.workspaceId, tenant.orgId] as const,
  );
}

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
  // A linked, ingested dataset in the project — so its project-context detail
  // page renders. No materialization, so no auto_default analysis is created
  // and the page does not redirect away to a default view-analysis.
  datasetId = await ingestFixture(api, tenant, 'axi1400_result_surface.csv');
  expect(datasetId, 'provisioned dataset id').toBeTruthy();
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1418 — project dataset-detail surface-spec download control (§4.17, FR30/AC17)', { tag: ['@SI-030', '@SI-035'] }, () => {
  test('FR30/AC17 — the project dataset-detail page exposes a download control linking straight at the committed static artifact', async ({ page }) => {
    await seedWorkspaceScope(page);

    await page.goto(`/projects/${tenant.projectId}/datasets/${datasetId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 25_000 });

    const downloadLink = page.getByRole('link', { name: /download the analysis capability spec/i });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute('href', SURFACE_SPEC_HREF);
    await expect(downloadLink).toHaveAttribute('download', SURFACE_SPEC_FILENAME);
  });
});
