import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import {
  INVESTIGATOR_ROLE_ID,
  addMember,
  launchAs,
  person,
  signIn,
  wizardBody,
  type Person,
} from '../AXI-2308/harness/result-page';

/**
 * AXI-2668 (epic AXI-2630, FR78, AC59): the Investigator opens his analysis in the classic explorer
 * from the result page, read-only, and is refused any analysis he cannot read.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2630-AXI-2668-Investigator-Open-Explorer.md`.
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2630/AXI-2668-* --project=chromium --no-deps`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000002668';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let investigator: Person;
let hisRunId: string;
let hisAnalysisId: string;
let privateAnalysisId: string;
let privateProjectId: string;

/** His own session: the bearer token and workspace header are set on `investigator.api`. */
const his = (path: string) => investigator.api.get(apiUrl(path));

test.describe.serial('AXI-2668 Investigator opens an analysis in the explorer @SI-066 @SI-033 @SI-030 @SI-010', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
    await silenceTours(await adminToken());
    investigator = await person('investigator', t.workspaceId);
    await addMember(api, t, investigator, INVESTIGATOR_ROLE_ID);
    await silenceTours(investigator.accessToken);

    hisRunId = await launchAs(investigator, api, t, wizardBody(t, dataset, 'T1', 'Does igg4_g_l differ by sex? (AXI-2668)', 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));

    const me = await api.get('/api/v1/auth/me', t.headers);
    const project = await api.post('/api/v1/projects', { name: `AXI-2668 private ${Date.now()}`, workspaceId: t.workspaceId }, t.headers);
    expect(project.status, JSON.stringify(project.body)).toBeLessThan(300);
    privateProjectId = project.body.id;
    const hidden = await api.post('/api/v1/view-analyses', {
      projectId: privateProjectId, datasetId: dataset.datasetId, name: 'Private analysis (AXI-2668)', createdBy: me.body.id,
    }, t.headers);
    expect(hidden.status, JSON.stringify(hidden.body)).toBeLessThan(300);
    privateAnalysisId = hidden.body.id;
    const closed = await api.patch(`/api/v1/projects/${privateProjectId}/visibility`, { visibility: 'private' }, t.headers);
    expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(300);
  });

  test.afterAll(async () => {
    await api.ctx.delete(`/api/v1/workspaces/${t.workspaceId}/members/${investigator.userId}`, { headers: t.headers }).catch(() => undefined);
    await investigator?.api.dispose();
    await api?.ctx.dispose();
  });

  test('AC59 AXI-2668.2 the result page opens the same analysis in the read-only explorer @SI-066 @SI-033 @SI-030', async ({ browser }) => {
    // Arrange
    const page = await browser.newPage();
    await signIn(page, investigator, t, `/investigator/projects/${t.projectId}/runs/${hisRunId}`);
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });

    // Act
    await page.getByTestId('rp-open-explorer').click();

    // Assert — the explorer on his surface
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${t.projectId}/view-analyses/[^/?]+`), { timeout: 30_000 });
    await expect(page.getByTestId('question-title')).toBeVisible({ timeout: 60_000 });
    hisAnalysisId = new URL(page.url()).pathname.split('/').pop() as string;

    // Assert — nothing on the page edits, runs, publishes or comments
    await expect(page.getByRole('tab', { name: 'Provenance' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Run rule/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Discussion/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Publish/ })).toHaveCount(0);

    // Act — the explorer's "Result view" stays on his surface
    await page.getByTestId('object-line-result-view').click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${t.projectId}/runs/${hisRunId}$`), { timeout: 30_000 });
    await page.close();
  });

  test('AC59 AXI-2668.3 a direct URL to an analysis he cannot read shows not found @SI-066 @SI-030', async ({ browser }) => {
    // Arrange
    const page = await browser.newPage();

    // Act
    await signIn(page, investigator, t, `/investigator/projects/${privateProjectId}/view-analyses/${privateAnalysisId}`);

    // Assert
    await expect(page.getByText('ViewAnalysis not found')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Private analysis (AXI-2668)')).toHaveCount(0);
    await page.close();
  });

  test('AC59 AXI-2668.4 the API refuses every read of an analysis he cannot read, as for an unknown id @SI-010', async () => {
    // Act
    const reads = await Promise.all([
      his(`/api/v1/view-analyses/${privateAnalysisId}`),
      his(`/api/v1/view-analyses/${privateAnalysisId}/snapshots`),
      his(`/api/v1/view-analyses/${privateAnalysisId}/framing`),
    ]);
    const unknown = await his(`/api/v1/view-analyses/${UNKNOWN_ID}`);

    // Assert
    for (const read of reads) expect(read.status()).toBe(404);
    expect(unknown.status()).toBe(404);

    // Assert — the list leaves it out, even when asked for that project
    const list = await his(`/api/v1/view-analyses?projectId=${privateProjectId}`);
    expect(await list.text()).not.toContain(privateAnalysisId);
  });

  test('AC59 AXI-2668.5 the API still refuses a write on an analysis he can read @SI-010', async () => {
    // Act
    const write = await investigator.api.patch(apiUrl(`/api/v1/view-analyses/${hisAnalysisId}`), { data: { name: 'Renamed by the Investigator' } });

    // Assert
    expect(write.status()).toBe(403);
  });
});
