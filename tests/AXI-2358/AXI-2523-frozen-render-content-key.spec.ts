import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, createAnalysis, createSnapshot, frozenRenderPayload, uniq, type Tenant } from '../AXI-1233/harness/seed-axi1234';

/**
 * AXI-2523 (epic AXI-2358) — the frozen-render fingerprint is content-addressed.
 * Manual-E2E: `axiome-docs/manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md`
 * § AXI-2523.
 *
 * `frozenRender.payloadJson` is rendered by the client and `frozen_chart_renders` is
 * append-only. Before the fix the fingerprint covered the render ingredients +
 * snapshot only, so the FIRST freeze of a (chart, snapshot) pinned its payload and
 * every later citer of the same chart and snapshot was handed that row. A fingerprint
 * names exactly one row (UNIQUE `instance_id`), so distinct fingerprints prove the
 * later citer is not bound to the earlier picture.
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

async function citeFrozen(analysisId: string, snapshotId: string, frozenRender: Record<string, unknown>): Promise<string> {
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries: [{ chartArtifactId: frozenRender.dataviewSpecId, snapshotId, datasetVersionId: t.datasetId, frozenRender }],
    title: `AXI-2523 ${uniq()}`,
    createdBy: 'e2e-axi-2523',
  }, t.headers);
  expect(res.status, `createEvidence → ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body.currentVersion.chartArtifactIds[0];
}

async function seedChart(label: string) {
  const analysisId = await createAnalysis(api, t, `AXI-2523 ${label} ${uniq()}`);
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const specId = `spec-${uniq()}`;
  return { analysisId, snapshotId, specId };
}

test('AC1 AXI-2523.1 @SI-017 — a tampered payload frozen first does not capture a later honest citation of the same chart and snapshot', async () => {
  const { analysisId, snapshotId, specId } = await seedChart('2523.1');
  const honest = frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId });
  const tampered = { ...honest, payloadJson: { data: [{ type: 'scatter', x: [9, 9], y: [9, 9] }], layout: { title: 'fabricated' } } };

  const poisoned = await citeFrozen(analysisId, snapshotId, tampered);
  const cited = await citeFrozen(analysisId, snapshotId, honest);

  expect(poisoned).toMatch(/^dvi_[0-9a-f]{16}$/);
  expect(cited).toMatch(/^dvi_[0-9a-f]{16}$/);
  expect(cited, 'the honest citation must not resolve to the tampered frozen row').not.toBe(poisoned);
});

test('AC1 AC3 AXI-2523.2 @SI-017 — re-citing the identical picture reuses the same frozen fingerprint', async () => {
  const { analysisId, snapshotId, specId } = await seedChart('2523.2');
  const honest = frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId });

  const first = await citeFrozen(analysisId, snapshotId, honest);
  const second = await citeFrozen(analysisId, snapshotId, honest);

  expect(second, 'the identical picture is idempotent, not a second row').toBe(first);
});

test('AC1 AC3 AXI-2523.3 @SI-017 — the same payload with its JSON keys reordered reuses the same frozen fingerprint', async () => {
  const { analysisId, snapshotId, specId } = await seedChart('2523.3');
  const honest = frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId });
  const reordered = { ...honest, payloadJson: { layout: {}, data: [{ y: [3, 4], x: [1, 2], type: 'scatter' }] } };

  const first = await citeFrozen(analysisId, snapshotId, honest);
  const second = await citeFrozen(analysisId, snapshotId, reordered);

  expect(second, 'content, not key order, decides the fingerprint').toBe(first);
});

test('AC1 AXI-2523.4 @SI-017 — the same picture cited under a different spec id freezes to a different fingerprint', async () => {
  const { analysisId, snapshotId, specId } = await seedChart('2523.4');
  const honest = frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId });

  const other = await citeFrozen(analysisId, snapshotId, { ...honest, dataviewSpecId: `spec-${uniq()}` });
  const cited = await citeFrozen(analysisId, snapshotId, honest);

  expect(cited, 'the cited spec is part of the frozen identity').not.toBe(other);
});
