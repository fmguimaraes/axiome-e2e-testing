import { test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  uploadCsvDataset,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2314 (epic AXI-2309 Platform Opening: Headless) — the Delete-upload API:
 * soft delete (FR19/FR20 — the dataset row is marked deleted and stops being
 * readable; hash retention + the delete audit row are unit-level facts,
 * UT-DATA-6019/6020, because a soft-deleted dataset 404s on every read route),
 * and the cite-refusal (EC8/FR20 — a report or an evidence item citing the
 * upload refuses the delete before any cleanup runs), plus deny-by-default
 * access (NFR1). The other citation edges (snapshots of other analyses, rule
 * runs, merges, evidence chart/binding pins) are covered per edge by
 * UT-DATA-6006..6017 — they need a full rule-run pipeline to reach over HTTP.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2314 — Delete-upload API (soft delete, cite-refusal)" (AXI-2314.1 .. .4).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-014', '@SI-010', '@SI-002'] };
const REFUSED_CODE = 'DATASET_DELETE_REFUSED_CITED';

let world: PrivateProjectsWorld;
let admin: Actor;
let editorBelowAdmin: Actor;
let outsider: Actor;
let projectId: string;

const datasets = (suffix = '') => apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets${suffix}`);
const viewAnalyses = (suffix = '') => apiUrl(`/api/v1/view-analyses${suffix}`);

async function newProject(name: string): Promise<string> {
  const res = await admin.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2314 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** A fresh dataset + its auto-created v1 ViewAnalysis, for one test's own isolation. */
async function datasetWithAnalysis(name: string): Promise<{ datasetId: string; viewAnalysisId: string }> {
  const datasetId = await uploadCsvDataset(world, admin);
  const va = await admin.api.post(viewAnalyses(), {
    data: { projectId, datasetId, name: `E2E AXI-2314 ${name} ${Date.now()}` },
  });
  expect(va.status(), await va.text()).toBe(201);
  const viewAnalysisId = (await va.json()).id;
  return { datasetId, viewAnalysisId };
}

/** The ViewAnalysis's auto-created initial (unfiltered, v1) snapshot id. */
async function initialSnapshotId(viewAnalysisId: string): Promise<string> {
  const res = await admin.api.get(viewAnalyses(`/${viewAnalysisId}/snapshots?page=1&limit=10`));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.data.length).toBeGreaterThan(0);
  return body.data[0].id;
}

/** A "report" citation: a published version with no evidence, just to cite the analysis. */
async function citeAsReport(viewAnalysisId: string): Promise<string> {
  const res = await admin.api.post(viewAnalyses('/publish'), {
    data: { viewAnalysisId, evidenceVersionIds: [] },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** An "evidence" citation: an Evidence item whose chart entry cites the real initial snapshot. */
async function citeAsEvidence(viewAnalysisId: string): Promise<string> {
  const snapshotId = await initialSnapshotId(viewAnalysisId);
  const res = await admin.api.post(viewAnalyses('/evidences'), {
    data: {
      viewAnalysisId,
      chartEntries: [
        {
          chartArtifactId: `e2e-axi-2314-chart-${Date.now()}`,
          snapshotId,
          datasetVersionId: `e2e-axi-2314-dv-${Date.now()}`,
        },
      ],
      title: 'AXI-2314 e2e evidence citation',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  admin = await world.actor('admin');
  editorBelowAdmin = await world.actor('editor');
  outsider = await world.actor('outsider');
  await world.addMember(admin, 'admin');
  await world.addMember(editorBelowAdmin, 'editor');
  await world.leaveWorkspace();
  projectId = await newProject('base');
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2314 — Delete-upload API (soft delete, cite-refusal)', TAGS, () => {
  test('AXI-2314.1 [AC7]: an uncited upload soft-deletes and is no longer readable', async () => {
    // Arrange — a dataset with an analysis (auto v1 snapshot) but no evidence
    // and no report: reachable, yet uncited.
    const { datasetId } = await datasetWithAnalysis('uncited');
    const before = await admin.api.get(datasets(`/${datasetId}`));
    expect(before.status(), await before.text()).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.fileHash).toMatch(/^.+$/);
    expect(beforeBody.rawFileHash).toMatch(/^.+$/);

    // Act
    const del = await admin.api.delete(datasets(`/${datasetId}`));

    // Assert
    expect(del.status(), await del.text()).toBe(204);
    const after = await admin.api.get(datasets(`/${datasetId}`));
    expect(after.status()).toBe(404);
    // FR20 "hash kept" and "delete is audited" are NOT observable over HTTP:
    // every dataset read route (incl. `/audit-logs`) resolves the dataset
    // through the live-dataset owner (`deletedAt: null`), so a soft-deleted
    // row 404s by design. Both are pinned at the unit level instead —
    // UT-DATA-6019 (the soft delete writes exactly `{ deletedAt }`) and
    // UT-DATA-6020 (a `delete` audit row is written).
  });

  test('AXI-2314.2 [AC7]: delete is refused when a report (published version) cites the upload', async () => {
    // Arrange
    const { datasetId, viewAnalysisId } = await datasetWithAnalysis('report-cited');
    const publishedVersionId = await citeAsReport(viewAnalysisId);

    // Act
    const del = await admin.api.delete(datasets(`/${datasetId}`));

    // Assert
    expect(del.status(), await del.text()).toBe(409);
    const body = await del.json();
    expect(body.errorCode).toBe(REFUSED_CODE);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'report',
          code: 'DATASET_CITED_BY_REPORT',
          citingId: publishedVersionId,
          viewAnalysisId,
        }),
      ]),
    );

    // Nothing moved: the dataset, the analysis and the report are all untouched.
    const stillThere = await admin.api.get(datasets(`/${datasetId}`));
    expect(stillThere.status()).toBe(200);
    const analysisStillThere = await admin.api.get(viewAnalyses(`/${viewAnalysisId}`));
    expect(analysisStillThere.status()).toBe(200);
    const reportStillThere = await admin.api.get(viewAnalyses(`/published-versions/${publishedVersionId}`));
    expect(reportStillThere.status()).toBe(200);
  });

  test('AXI-2314.3 [AC7]: delete is refused when an evidence item (draft) cites the upload', async () => {
    // Arrange
    const { datasetId, viewAnalysisId } = await datasetWithAnalysis('evidence-cited');
    const evidenceId = await citeAsEvidence(viewAnalysisId);

    // Act
    const del = await admin.api.delete(datasets(`/${datasetId}`));

    // Assert
    expect(del.status(), await del.text()).toBe(409);
    const body = await del.json();
    expect(body.errorCode).toBe(REFUSED_CODE);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'evidence',
          code: 'DATASET_CITED_BY_EVIDENCE',
          citingId: evidenceId,
          viewAnalysisId,
        }),
      ]),
    );

    const stillThere = await admin.api.get(datasets(`/${datasetId}`));
    expect(stillThere.status()).toBe(200);
    const evidenceStillThere = await admin.api.get(viewAnalyses(`/evidences/${evidenceId}`));
    expect(evidenceStillThere.status()).toBe(200);

    // Cite-refusal is itself audited — never silent.
    const logs = await (await admin.api.get(datasets(`/${datasetId}/audit-logs`))).json();
    const actions = (logs.data ?? logs).map((l: { action: string }) => l.action);
    expect(actions).toContain('delete_refused_cited');
  });

  test('AXI-2314.4 [AC7] — NFR1: delete is deny-by-default (no token, below-admin role, cross-workspace)', async () => {
    // Arrange
    const { datasetId } = await datasetWithAnalysis('deny-by-default');
    const anonymous = await apiRequest.newContext({
      extraHTTPHeaders: { 'X-Workspace-Id': world.workspaceId },
    });

    // Act
    const noToken = await anonymous.delete(datasets(`/${datasetId}`));
    const belowAdmin = await editorBelowAdmin.api.delete(datasets(`/${datasetId}`));
    const crossWorkspace = await outsider.api.delete(datasets(`/${datasetId}`));
    const stillThere = await admin.api.get(datasets(`/${datasetId}`));

    // Assert
    expect(noToken.status()).toBe(401);
    expect(belowAdmin.status()).toBe(403);
    // `outsider` was never added to the fixture workspace, so its own
    // `X-Workspace-Id` header never resolves this workspace's dataset — the
    // dataset must behave as absent, not as a cross-tenant leak (AXI-1286).
    expect([403, 404]).toContain(crossWorkspace.status());
    expect(stillThere.status()).toBe(200);

    await anonymous.dispose();
  });
});
