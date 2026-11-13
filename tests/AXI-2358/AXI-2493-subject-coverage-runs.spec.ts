import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import {
  ensureTenant, ensureAnalysis, ingestFixture, assignProfileAndVerify, carrierRuleId,
  type Tenant, type Analysis,
} from '../AXI-1400/harness/seed';
import { preflightRun, runAndWait, type RunArgs } from '../AXI-2309/harness/chart-style';

/**
 * AXI-2493 (epic AXI-2358 — same defect class as AXI-2348; restores Platform Opening:
 * Headless FR31). Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md,
 * "AXI-2493" section.
 *
 * `describe.subject_coverage` declares `subjectKey` (structural, bound from the project's
 * `patient_id` semantic mapping) and `timepointColumn`, which had no `ROLE_SOURCES` entry in
 * organization-service, so every submission was refused with "Role 'timepointColumn' cannot be
 * bound: the resolver has no source for it". `timepointColumn` is now a per-run `roleBinding`.
 *
 * The fixture MUST have a matched `patient_id` mapping: without it the resolver refuses on
 * `subjectKey` first and never reaches `timepointColumn`, so a "no 'has no source'" assertion
 * would pass before the fix too. `paired_longitudinal.csv` (AXI-1400): 15 patients x T0/T1/T2.
 *
 * API-level only; reuses the AXI-1400 seed and the AXI-2309 chart-style run helpers read-only.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const OPERATION_ID = 'describe.subject_coverage';
const FIXTURE = 'paired_longitudinal.csv';
const NO_SOURCE = /has no source for it/;

let api: Api;
let t: Tenant;
let analysis: Analysis;
let datasetId: string;

const args = async (roleBindings: Record<string, string>): Promise<RunArgs> => ({
  operationId: OPERATION_ID,
  runKind: 'DESCRIBE',
  roleBindings,
  operationParams: { requiredTimepoints: ['T1', 'T2'] },
  carrierRuleId: await carrierRuleId(OPERATION_ID),
});

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  datasetId = await ingestFixture(api, t, FIXTURE);
  await assignProfileAndVerify(api, t, ['patient_id']);
  analysis = await ensureAnalysis(api, t, 'AXI-2493 subject coverage runs', datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2493 — describe.subject_coverage binds timepointColumn and runs (FR31)', { tag: ['@SI-017'] }, () => {
  test('FR31 AXI-2493.1 — preflight accepts a bound timepointColumn (no "has no source" refusal)', async () => {
    const preflight = await preflightRun(api, t, analysis, datasetId, await args({ timepointColumn: 'timepoint' }));

    expect(preflight.status, JSON.stringify(preflight.body)).toBeLessThan(300);
    expect(JSON.stringify(preflight.body)).not.toMatch(NO_SOURCE);
    const blocks: any[] = preflight.body.blocks ?? [];
    const naming = blocks.filter((b) => /timepointColumn|subjectKey/.test(JSON.stringify(b)));
    expect(naming, JSON.stringify(blocks)).toEqual([]);
  });

  test('FR31 AXI-2493.2 — the run is accepted and completes with both roles recorded', async () => {
    const run = await runAndWait(api, t, analysis, datasetId, await args({ timepointColumn: 'timepoint' }));

    expect(['SUCCEEDED', 'DEDUPED'], JSON.stringify(run)).toContain(run.status);
    expect(run.operandRoles?.timepointColumn, JSON.stringify(run.operandRoles)).toBe('timepoint');
    expect(run.operandRoles?.subjectKey, JSON.stringify(run.operandRoles)).toBe('patient_id');
  });

  test('FR31 AXI-2493.3 — an unbound timepointColumn is the ordinary "bind it" refusal, never "no source"', async () => {
    const preflight = await preflightRun(api, t, analysis, datasetId, await args({}));

    expect(JSON.stringify(preflight.body)).not.toMatch(NO_SOURCE);
    expect(JSON.stringify(preflight.body)).toContain('timepointColumn');
    if (preflight.status < 300) {
      const ids = (preflight.body.blocks ?? []).map((b: any) => b.id);
      expect(ids, JSON.stringify(preflight.body)).toContain('operand_roles_resolvable');
    }
  });
});
