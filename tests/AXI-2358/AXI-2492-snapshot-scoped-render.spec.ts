import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureAnalysis, ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { ingestFixture } from '../AXI-2309/harness/chart-style';
import { pollAnyCandidate, renderAndPoll } from './AXI-2337-render-harness';
import { ensureSnapshot, renderSnapshotAndPoll, renderSnapshotRaw } from './AXI-2492-snapshot-harness';

/**
 * AXI-2492 (epic AXI-2358 — restores Headless FR12/FR15 for snapshot scope).
 *
 * Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md,
 * "AXI-2492" section (2492.1–2492.4; 2492.5 deploy skew is `manual`, unit-covered).
 *
 * AXI-2337 refused every render carrying `snapshotId`. Now the snapshot's
 * effective scope is dispatched to bio-compute and applied, so the payload
 * honours the snapshot-keyed instance ID. Fixture `chart-style-multi.csv`:
 * 16 rows, `group` 8 A / 8 B, 5 of the A rows have `value > 3`.
 * `rowCountInput` (rows reaching the renderer after every filter) is the
 * observable, independent of the template.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const DVI = /^dvi_[0-9a-f]{16}$/;

let api: Api;
let t: Tenant;
let specId: string;
let analysisId: string;
let unscoped: { id: string; rows: number };
let groupA: { snapshotId: string; id: string; rows: number };

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  const datasetId = await ingestFixture(api, t);
  specId = (await pollAnyCandidate(api, t, datasetId)).id;
  analysisId = (await ensureAnalysis(api, t, 'AXI-2492 snapshot-scoped render', datasetId)).analysisId;
  const { dispatched, ready } = await renderAndPoll(api, t, specId);
  unscoped = { id: dispatched.instanceId, rows: ready.rowCountInput };
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2492 — a snapshot-scoped render honours its snapshot (FR12/FR15)', { tag: ['@SI-018', '@SI-017'] }, () => {
  test('FR12 FR15 — a snapshot render reaches ready under its own key with the snapshot rows only (2492.1)', async () => {
    const snapshotId = await ensureSnapshot(api, t, analysisId, [{ column: 'group', operator: 'eq', value: 'A' }]);

    const { dispatched, ready } = await renderSnapshotAndPoll(api, t, specId, snapshotId);

    expect(dispatched.instanceId).toMatch(DVI);
    expect(dispatched.instanceId, 'a snapshot render shares the unscoped key').not.toBe(unscoped.id);
    expect(ready.instanceId).toBe(dispatched.instanceId);
    expect(ready.rowCountInput, 'snapshot scope not applied — same row count as unscoped').toBeLessThan(unscoped.rows);
    expect(ready.rowCountInput).toBeGreaterThan(0);
    groupA = { snapshotId, id: dispatched.instanceId, rows: ready.rowCountInput };

    const again = await renderSnapshotRaw(api, t, specId, snapshotId);
    expect(again.body.cacheHit, JSON.stringify(again.body)).toBe(true);
    expect(again.body.instanceId).toBe(groupA.id);
  });

  test('FR15 — a chained snapshot renders its composed lineage, narrower than its parent (2492.2)', async () => {
    const child = await ensureSnapshot(
      api, t, analysisId,
      [{ column: 'group', operator: 'eq', value: 'A' }, { column: 'value', operator: 'gt', value: 3 }],
      groupA.snapshotId,
    );

    const { dispatched, ready } = await renderSnapshotAndPoll(api, t, specId, child);

    expect(dispatched.instanceId).not.toBe(groupA.id);
    expect(ready.rowCountInput, 'lineage not composed').toBeLessThan(groupA.rows);
    expect(ready.rowCountInput).toBeGreaterThan(0);
  });

  test('FR12 — an unknown snapshot is refused 404 before anything is dispatched (2492.3)', async () => {
    const res = await renderSnapshotRaw(api, t, specId, '00000000-0000-4000-8000-000000000000');

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(JSON.stringify(res.body)).toContain('RENDER_SNAPSHOT_NOT_FOUND');
  });

  test('FR12 — a non-string snapshotId is refused 400 (2492.4)', async () => {
    const res = await renderSnapshotRaw(api, t, specId, { id: 'x' });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain('RENDER_SNAPSHOT_ID_INVALID');
  });
});
