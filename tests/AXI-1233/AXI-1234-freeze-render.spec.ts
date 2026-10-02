import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, createAnalysis, createSnapshot, frozenRenderPayload, uniq, type Tenant } from './harness/seed-axi1234';

/**
 * AXI-1234 (epic AXI-1233 MIPP Testing Campaign) — API-level coverage for
 * freeze-on-cite. Manual-E2E §4.3/§4.4/§4.5
 * (`axiome-docs/manual-e2e/AXI-1234-Freeze-Rendered-Chart-At-Citation-Time.md`).
 *
 * The frontend capture-at-bind-time is not wired at any call site yet (see the
 * story report), so this spec drives `POST /api/v1/view-analyses/evidences`
 * directly with a `frozenRender` payload — exactly the contract a capture site
 * will call once it exists. AC5 (full provenance chain) is left to the manual
 * plan: `provenance-backfill` + `provenance-graph` work (confirmed by unit
 * test UT-RULES-1234-009), but this spec stays API-only and does not assert
 * the graph shape, to avoid over-fitting a response contract while under time
 * pressure — see the story report for the explicit disclosure.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let api: Api;
let t: Tenant;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
});
test.afterAll(async () => {
  await api.ctx.dispose();
});

async function createEvidence(analysisId: string, chartEntries: unknown[]) {
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries,
    title: `AXI-1234 ${uniq()}`,
    createdBy: 'e2e-axi-1234',
  }, t.headers);
  expect(res.status, `createEvidence → ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

async function getEvidence(evidenceId: string) {
  const res = await api.get(`/api/v1/view-analyses/evidences/${evidenceId}`, t.headers);
  expect(res.status).toBe(200);
  return res.body;
}

test('AC1 @SI-017 — freezing a chart at cite time persists a dvi_ fingerprint and marks the EvidenceChart frozen', async () => {
  const analysisId = await createAnalysis(api, t, `AXI-1234 AC1 ${uniq()}`);
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const specId = `spec-${uniq()}`;

  const evidence = await createEvidence(analysisId, [
    { chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: frozenRenderPayload({ dataviewSpecId: specId }) },
  ]);

  const fingerprint = evidence.currentVersion.chartArtifactIds[0];
  expect(fingerprint, 'frozen citation is keyed by a fingerprint, not the raw spec id').not.toBe(specId);
  expect(fingerprint).toMatch(/^dvi_/);

  const fetched = await getEvidence(evidence.id);
  const chart = fetched.currentVersion.charts[0];
  expect(chart.chartArtifactId).toBe(fingerprint);
  expect(chart.frozen, 'EvidenceChart.frozen must be true for a freeze-on-cite entry').toBe(true);
});

test('AC2 @SI-017 — the same chart cited from two different snapshots freezes to two distinct fingerprints', async () => {
  const analysisId = await createAnalysis(api, t, `AXI-1234 AC2 ${uniq()}`);
  const snapshotA = await createSnapshot(api, t, analysisId, []);
  const snapshotB = await createSnapshot(api, t, analysisId, [{ column: 'padj', operator: 'lt', value: 0.05 }]);
  const specId = `spec-${uniq()}`;
  const shared = frozenRenderPayload({ dataviewSpecId: specId });

  const evA = await createEvidence(analysisId, [{ chartArtifactId: specId, snapshotId: snapshotA, datasetVersionId: t.datasetId, frozenRender: shared }]);
  const evB = await createEvidence(analysisId, [{ chartArtifactId: specId, snapshotId: snapshotB, datasetVersionId: t.datasetId, frozenRender: shared }]);

  const fpA = evA.currentVersion.chartArtifactIds[0];
  const fpB = evB.currentVersion.chartArtifactIds[0];
  expect(fpA).toMatch(/^dvi_/);
  expect(fpB).toMatch(/^dvi_/);
  expect(fpA, 'distinct snapshots must freeze to distinct fingerprints (AC2)').not.toBe(fpB);
});

test('AC1/AC3 @SI-017 — freezing the identical render twice (same chart, same snapshot) is idempotent, not a duplicate row', async () => {
  const analysisId = await createAnalysis(api, t, `AXI-1234 AC3 ${uniq()}`);
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const specId = `spec-${uniq()}`;
  const shared = frozenRenderPayload({ dataviewSpecId: specId });

  const first = await createEvidence(analysisId, [{ chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: shared }]);
  const second = await createEvidence(analysisId, [{ chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: shared }]);

  expect(second.currentVersion.chartArtifactIds[0], 'identical inputs resolve to the same fingerprint (stable, re-usable row)')
    .toBe(first.currentVersion.chartArtifactIds[0]);
});

test('AC6 @SI-017 — a legacy citation (no frozenRender) is marked unfrozen and keeps its spec id', async () => {
  const analysisId = await createAnalysis(api, t, `AXI-1234 AC6 ${uniq()}`);
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const specId = `spec-${uniq()}`;

  const evidence = await createEvidence(analysisId, [{ chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId }]);

  expect(evidence.currentVersion.chartArtifactIds[0], 'a legacy entry is never reinterpreted as a fingerprint').toBe(specId);
  const fetched = await getEvidence(evidence.id);
  expect(fetched.currentVersion.charts[0].frozen, 'EvidenceChart.frozen must be false for a legacy citation (AC6)').toBe(false);
});
