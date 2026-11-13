import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';
import {
  canonicalRunId,
  ingestFixture,
  pollRecommendedCandidate,
  renderUntilReady,
  resolveResultDatasetId,
  runAndWait,
} from '../AXI-2309/harness/chart-style';

/**
 * AXI-2347 (epic AXI-2358 — restores FR12 "never blank" of Platform Opening:
 * Headless). Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md,
 * "AXI-2347" section.
 *
 * Gallery bindings carry `column_id: "col_<name>"`; bio-compute's renderer
 * matched the id verbatim against the parquet's raw names, so a render that
 * DID reach `ready` answered `{ error: "binding columns not found", data: [] }`.
 * The AXI-2312 §5.1 assertion (`payload` truthy) is latently green against
 * that error payload, so this spec asserts the payload itself: no `error`,
 * non-empty `data`.
 *
 * API-level only. Reuses the AXI-1400 seed and AXI-2309 chart-style harness
 * read-only (own fixture `chart-style-multi.csv`, a two-level `group` column).
 *
 * Depends on AXI-2337 (render instance-id agreement) for the render poll to
 * reach `ready` at all; before AXI-2337 merges, the poll times out instead.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

let api: Api;
let t: Tenant;
let analysis: Analysis;
let datasetId: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  datasetId = await ingestFixture(api, t);
  analysis = await ensureAnalysis(api, t, 'AXI-2347 gallery render real data', datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2347 — a ready gallery default-chart render returns real data (FR12)', { tag: ['@SI-017'] }, () => {
  test('FR12 — AXI-2347-S1: recommended describe.count chart (col_ bindings) renders real bars, not "binding columns not found"', async () => {
    const run = await runAndWait(api, t, analysis, datasetId, {
      operationId: 'describe.count',
      runKind: 'DESCRIBE',
      roleBindings: { groupColumns: 'group' },
      operationParams: {},
      carrierRuleId: await carrierRuleId('describe.count'),
    });
    const resultDatasetId = await resolveResultDatasetId(api, t, analysis.analysisId, canonicalRunId(run));
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, analysis.analysisId);
    expect(recommended, 'no recommended-origin spec minted for the describe.count result').toBeTruthy();

    // The defect's precondition: the spec's bindings are canonical `col_` ids.
    const columnIds = Object.values(recommended.bindings ?? {})
      .map((b: any) => b?.column_id)
      .filter((c: unknown): c is string => typeof c === 'string');
    expect(columnIds.length, JSON.stringify(recommended.bindings)).toBeGreaterThan(0);
    for (const c of columnIds) expect(c, 'binding id is not in canonical col_<name> form').toMatch(/^col_./);

    const rendered = await renderUntilReady(api, t, recommended.id);
    const payload = rendered.payload;
    expect(payload?.error, `ready render answered an error payload: ${JSON.stringify(payload)}`).toBeUndefined();
    expect(Array.isArray(payload?.data) && payload.data.length > 0, `ready render is blank: ${JSON.stringify(payload)}`).toBe(true);
  });
});
