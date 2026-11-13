import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, ingestFixture, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';
import { preflightRun, runAndWait, type RunArgs } from '../AXI-2309/harness/chart-style';

/**
 * AXI-2494 (epic AXI-2358 — same defect class as AXI-2348/AXI-2493; restores Platform Opening:
 * Headless FR31). Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md,
 * "AXI-2494" section.
 *
 * `stats.site_batch_variance_test` declares `measurementColumn`, `diseaseColumn`, `siteColumn` and
 * `batchColumn`, none of which had a `ROLE_SOURCES` entry in organization-service, so every
 * submission was refused "Role '<role>' cannot be bound: the resolver has no source for it". All
 * four are now per-run `roleBinding`s. The operation declares no structural (semantic) role, so no
 * profile/mapping is needed for the refusal to be reachable — the assertions are not latently green.
 *
 * Fixture `site_batch.csv` (AXI-1400): 48 rows, columns sample_id/disease/site/batch/measurement.
 * API-level only; reuses the AXI-1400 seed and the AXI-2309 chart-style run helpers read-only.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const OPERATION_ID = 'stats.site_batch_variance_test';
const FIXTURE = 'site_batch.csv';
const NO_SOURCE = /has no source for it/;
const BINDINGS = {
  measurementColumn: 'measurement',
  diseaseColumn: 'disease',
  siteColumn: 'site',
  batchColumn: 'batch',
};

let api: Api;
let t: Tenant;
let analysis: Analysis;
let datasetId: string;

const args = async (roleBindings: Record<string, string>): Promise<RunArgs> => ({
  operationId: OPERATION_ID,
  roleBindings,
  operationParams: {},
  carrierRuleId: await carrierRuleId(OPERATION_ID),
});

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  datasetId = await ingestFixture(api, t, FIXTURE);
  analysis = await ensureAnalysis(api, t, 'AXI-2494 site batch variance runs', datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2494 — stats.site_batch_variance_test binds its four roles and runs (FR31)', { tag: ['@SI-017'] }, () => {
  test('FR31 AXI-2494.1 — preflight accepts the four bound roles (no "has no source" refusal)', async () => {
    const preflight = await preflightRun(api, t, analysis, datasetId, await args(BINDINGS));

    expect(preflight.status, JSON.stringify(preflight.body)).toBeLessThan(300);
    expect(JSON.stringify(preflight.body)).not.toMatch(NO_SOURCE);
    const blocks: any[] = preflight.body.blocks ?? [];
    const naming = blocks.filter((b) => /measurementColumn|diseaseColumn|siteColumn|batchColumn/.test(JSON.stringify(b)));
    expect(naming, JSON.stringify(blocks)).toEqual([]);
  });

  test('FR31 AXI-2494.2 — the run is accepted and completes with all four roles recorded', async () => {
    const run = await runAndWait(api, t, analysis, datasetId, await args(BINDINGS));

    expect(['SUCCEEDED', 'DEDUPED'], JSON.stringify(run)).toContain(run.status);
    expect(run.operandRoles, JSON.stringify(run.operandRoles)).toMatchObject(BINDINGS);
  });

  test('FR31 AXI-2494.3 — an unbound siteColumn is the ordinary "bind it" refusal, never "no source"', async () => {
    const { siteColumn: _omitted, ...withoutSite } = BINDINGS;
    const preflight = await preflightRun(api, t, analysis, datasetId, await args(withoutSite));

    expect(JSON.stringify(preflight.body)).not.toMatch(NO_SOURCE);
    expect(JSON.stringify(preflight.body)).toContain('siteColumn');
    if (preflight.status < 300) {
      const ids = (preflight.body.blocks ?? []).map((b: any) => b.id);
      expect(ids, JSON.stringify(preflight.body)).toContain('operand_roles_resolvable');
    }
  });
});
