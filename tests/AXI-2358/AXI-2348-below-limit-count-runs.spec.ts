import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';
import { ingestFixture, preflightRun, runAndWait, type RunArgs } from '../AXI-2309/harness/chart-style';

/**
 * AXI-2348 (epic AXI-2358 — restores FR31 of Platform Opening: Headless).
 * Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md,
 * "AXI-2348" section.
 *
 * `describe.below_limit_count` declares one role, `measureColumn`, which had no
 * `ROLE_SOURCES` entry in organization-service, so every submission was refused
 * with "Role 'measureColumn' cannot be bound: the resolver has no source for it"
 * (a 400 on both execute and preflight). These scenarios assert the operation is
 * now accepted and completes, and that an UNBOUND measureColumn gets the ordinary
 * "bind it" refusal instead of "no source".
 *
 * API-level only. Reuses the AXI-1400 seed and the AXI-2309 chart-style harness
 * read-only (fixture `chart-style-multi.csv`: numeric `value`, 2.0..4.0 range,
 * so a declared lod of 2.5 splits the rows into two statuses).
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const OPERATION_ID = 'describe.below_limit_count';
const NO_SOURCE = /has no source for it/;

let api: Api;
let t: Tenant;
let analysis: Analysis;
let datasetId: string;

const args = async (roleBindings: Record<string, string>): Promise<RunArgs> => ({
  operationId: OPERATION_ID,
  runKind: 'DESCRIBE',
  roleBindings,
  operationParams: { lod: 2.5, unit: 'pg/mL' },
  carrierRuleId: await carrierRuleId(OPERATION_ID),
});

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  datasetId = await ingestFixture(api, t);
  analysis = await ensureAnalysis(api, t, 'AXI-2348 below-limit count runs', datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2348 — describe.below_limit_count binds measureColumn and runs (FR31)', { tag: ['@SI-017'] }, () => {
  test('FR31 AXI-2348.1 — preflight accepts a bound measureColumn (no "has no source" refusal)', async () => {
    const preflight = await preflightRun(api, t, analysis, datasetId, await args({ measureColumn: 'value' }));

    expect(preflight.status, JSON.stringify(preflight.body)).toBeLessThan(300);
    expect(JSON.stringify(preflight.body)).not.toMatch(NO_SOURCE);
    const blocks: any[] = preflight.body.blocks ?? [];
    const naming = blocks.filter((b) => JSON.stringify(b).includes('measureColumn'));
    expect(naming, JSON.stringify(blocks)).toEqual([]);
  });

  test('FR31 AXI-2348.2 — the run is accepted and completes with measureColumn recorded', async () => {
    const run = await runAndWait(api, t, analysis, datasetId, await args({ measureColumn: 'value' }));

    expect(['SUCCEEDED', 'DEDUPED'], JSON.stringify(run)).toContain(run.status);
    expect(run.operandRoles?.measureColumn, JSON.stringify(run.operandRoles)).toBe('value');
  });

  test('FR31 AXI-2348.3 — an unbound measureColumn is the ordinary "bind it" refusal, never "no source"', async () => {
    const preflight = await preflightRun(api, t, analysis, datasetId, await args({}));

    expect(JSON.stringify(preflight.body)).not.toMatch(NO_SOURCE);
    expect(JSON.stringify(preflight.body)).toContain('measureColumn');
    if (preflight.status < 300) {
      const ids = (preflight.body.blocks ?? []).map((b: any) => b.id);
      expect(ids, JSON.stringify(preflight.body)).toContain('operand_roles_resolvable');
    }
  });
});
