import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import {
  ensureTenant, ensureProject, findQcRuleId, ingestFixture, ensureDefaultAnalysis,
  pollRunTerminal, resolveMaterialisedRow, triggerReingestion, NAMES,
} from './harness/seed';

/**
 * AXI-1482 (epic AXI-1474) §4.5/AC21 — a new dataset version makes the strip
 * say so. Previously `manual` only ("needs a real second ingestion to
 * completion", per the scenario doc) because nothing in the suite drove one;
 * `triggerReingestion` (harness/seed.ts) now does, via the same
 * `.../ingestions` re-processing endpoint the platform uses for a genuine new
 * version — no file re-upload required, so this needs no fixture beyond the
 * one §4.1-4.3 already ingest.
 */
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let api: Api;
let t: Awaited<ReturnType<typeof ensureTenant>>;
let ruleId: string;
let datasetId: string;
let projectId: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  ruleId = await findQcRuleId(api, t);
  datasetId = await ingestFixture(api, t);
  projectId = await ensureProject(api, t, NAMES.stalenessProject);
  await ensureDefaultAnalysis(api, t, projectId, datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('AC21 — a new dataset version marks the earlier verdict stale on the strip', { tag: ['@SI-014', '@SI-017', '@SI-032'] }, async () => {
  const submit = await api.post('/api/v1/rule-runs', {
    ruleId, runKind: 'QC', operationId: 'qc.rule_gate',
    projectId, workspaceId: t.workspaceId, datasetId,
  }, t.headers);
  expect(submit.status, `QC submit: ${JSON.stringify(submit.body)}`).toBeLessThan(300);
  const polled = await pollRunTerminal(api, t, submit.body.ruleRunId);
  expect(polled.status, `QC run status: ${JSON.stringify(polled)}`).toMatch(/SUCCEEDED|DEDUPED/);
  const row = await resolveMaterialisedRow(api, t, polled);

  const before = await api.get(
    `/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/qc-strip?projectId=${projectId}`,
    t.headers,
  );
  const entryBefore = (before.body.entries ?? []).find((e: any) => e.ruleRunId === row.id);
  expect(entryBefore, 'strip carries the run before re-ingestion').toBeTruthy();
  expect(entryBefore.staleMarked, 'not stale before a new version exists').toBe(false);
  expect(entryBefore.computedOnEarlierVersion, 'not stale before a new version exists').toBe(false);
  const v1DatasetVersionId = entryBefore.datasetVersionId;

  const v2IngestionId = await triggerReingestion(api, t, datasetId);
  expect(v2IngestionId, 'a new ingestion id was minted').not.toBe(v1DatasetVersionId);

  const after = await api.get(
    `/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/qc-strip?projectId=${projectId}`,
    t.headers,
  );
  expect(after.body.currentDatasetVersionId, 'the strip reads the new current version').toBe(v2IngestionId);
  const entryAfter = (after.body.entries ?? []).find((e: any) => e.ruleRunId === row.id);
  expect(entryAfter, 'the earlier verdict is still openable, not retracted').toBeTruthy();
  expect(entryAfter.datasetVersionId, 'the verdict still names the version it actually read').toBe(v1DatasetVersionId);
  expect(entryAfter.staleMarked, 'FR34: an appended staleness marking now exists').toBe(true);
  expect(entryAfter.computedOnEarlierVersion, 'live comparison also says it is not current').toBe(true);
  expect(entryAfter.staleReason, 'the marking carries a reason').toBeTruthy();
  expect(entryAfter.snapshotId, 'the earlier snapshot is still openable').toBe(entryBefore.snapshotId);
});
