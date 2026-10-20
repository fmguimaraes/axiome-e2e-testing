import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import {
  ensureTenant, ingestFixture, assignProfileAndVerify, ensureAnalysis, pollTerminal,
  type Tenant, type Analysis,
} from '../AXI-1435/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { frozenRenderPayload, uniq } from '../AXI-1233/harness/seed-axi1234';

/**
 * AXI-2087 (epic AXI-2073, feature §17 D6; FR2, FR4, EC8, AC2, AC6) — audit
 * step 4 ("Cohort") reads the CohortDefinition the run row was linked to at
 * creation. Scenarios 1-4 of
 * `axiome-docs/manual-e2e/AXI-2073-Evidence-Audit-Report.md` § AXI-2087.
 *
 * Everything is produced by the platform itself through the REST surface —
 * a REAL `stats.correlation` run (the AXI-2081 recipe), a real evidence over
 * its rule-derived snapshot, and the existing cohort unlock/version routes for
 * EC8. Nothing is hand-seeded: the run_scope cohort is whatever the run's own
 * creation path wrote.
 *
 * Serial: scenario 3 (AXI-2155) exercises the A1 immutability refusal on the
 * cohort scenario 1 found, and scenario 2 reads the list that cohort must be
 * absent from.
 *
 * DISPOSITION (2026-10-20, last touched by AXI-2155): authored, typechecked
 * and `--list`ed, NOT run. A
 * green run needs a stack serving the AXI-2087 backend WITH migration
 * `20261020090000_add_rule_run_cohort_link` applied; the only stack up is the
 * shared demo stack on `axiome-localhost`, which story agents may not migrate.
 * Do not read this file's existence as `e2e-pass`.
 */

let api: Api;
let tenant: Tenant;
let analysis: Analysis;
let datasetId: string;
let runEvidence: { id: string; versionNumber: number };
let cohortId: string;

const CORRELATION_OP = 'stats.correlation';

function auditReportUrl(evId: string, v: number): string {
  return `/api/v1/view-analyses/evidences/${evId}/versions/${v}/audit-report`;
}

/** Same submission as AXI-2081's spec: a real run, polled to a governed outcome. */
async function runCorrelationAndGetSnapshotId(): Promise<string> {
  const submit = await api.post('/api/v1/rule-runs', {
    ruleId: tenant.ruleIds[CORRELATION_OP],
    runKind: 'STATISTICAL',
    operationId: CORRELATION_OP,
    roleBindings: { xColumn: 'score', yColumn: 'score2' },
    operationParams: {},
    projectId: tenant.projectId,
    workspaceId: tenant.workspaceId,
    datasetId,
    snapshotId: analysis.snapshotId,
    viewAnalysisId: analysis.analysisId,
    scope: 'FILTERED',
  }, tenant.headers);
  expect(submit.status, `submit -> ${submit.status}: ${JSON.stringify(submit.body)}`).toBeLessThan(300);
  const run = await pollTerminal(api, tenant, submit.body.ruleRunId);
  expect(['SUCCEEDED', 'DEDUPED'], `run: ${run.statusMessage ?? run.errorMessage ?? ''}`).toContain(run.status);
  const resultRunId: string = run.status === 'DEDUPED' ? submit.body.dedupedFromRunId ?? run.dedupedFromRunId : run.id;
  const snapshots = await api.get(`/api/v1/view-analyses/${analysis.analysisId}/snapshots?page=1&limit=100`, tenant.headers);
  const producedId: string | undefined =
    asList(snapshots.body).find((s: any) => s.ruleRunId === resultRunId)?.id
    ?? (submit.body.existingSnapshotId as string | undefined);
  expect(producedId, `no rule-derived snapshot for run ${resultRunId}`).toBeTruthy();
  return producedId!;
}

async function createEvidence(snapshotId: string, label: string): Promise<{ id: string; versionNumber: number }> {
  const specId = `spec-${uniq()}`;
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysis.analysisId,
    chartEntries: [{
      chartArtifactId: specId,
      snapshotId,
      datasetVersionId: datasetId,
      frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: datasetId }),
    }],
    title: `AXI-2087 ${label} ${uniq()}`,
    createdBy: 'e2e-axi-2087',
  }, tenant.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { id: res.body.id, versionNumber: res.body.currentVersion.versionNumber };
}

/** Download the bundle and return report.md's `### Cohort` section only. */
async function cohortSection(evidence: { id: string; versionNumber: number }): Promise<string> {
  const zip = await api.ctx.get(apiUrl(auditReportUrl(evidence.id, evidence.versionNumber)), { headers: tenant.headers });
  expect(zip.status(), 'audit-report download').toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'axi-2087-audit-'));
  writeFileSync(join(dir, 'bundle.zip'), await zip.body());
  const md = execFileSync('unzip', ['-p', join(dir, 'bundle.zip'), 'report.md']).toString('utf8');
  const start = md.indexOf('### Cohort');
  expect(start, 'report.md has a Cohort section').toBeGreaterThanOrEqual(0);
  const end = md.indexOf('\n### ', start + 1);
  return md.slice(start, end === -1 ? undefined : end);
}

function line(section: string, label: string): string | undefined {
  return section.split('\n').find((l) => l.startsWith(`- ${label}:`))?.slice(`- ${label}: `.length);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
  await approveCarriersFor([CORRELATION_OP]);
  datasetId = await ingestFixture(api, tenant, 'statistical-trigger.csv');
  await assignProfileAndVerify(api, tenant, ['patient_id', 'timepoint']);
  analysis = await ensureAnalysis(api, tenant, `AXI-2087 cohort step ${uniq()}`, datasetId);
  runEvidence = await createEvidence(await runCorrelationAndGetSnapshotId(), 'run');
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2087 — audit step 4 reads the run-linked cohort (D6, FR2, FR4, EC8)', { tag: ['@SI-016', '@SI-017', '@SI-014'] }, () => {
  test('FR2/AC2 — a run created after the release shows a recorded, locked run_scope cohort', async () => {
    const section = await cohortSection(runEvidence);

    cohortId = line(section, 'ID') ?? '';
    expect(cohortId, section).toMatch(/^[0-9a-f-]{36}$/);
    expect(line(section, 'Version')).toBe('1');
    expect(line(section, 'Content hash')).toBe(line(section, 'cohortHash'));
    expect(line(section, 'cohortHash')).toMatch(/^[0-9a-f]{64}$/);
    expect(line(section, 'origin')).toBe('run_scope');
    expect(line(section, 'lockState')).toBe('locked');
    expect(line(section, 'lockedBy')).toBeTruthy();
    expect(line(section, 'lockedAt')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line(section, 'filters')).toContain('"filterCombinator"');
    expect(line(section, 'Created at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line(section, 'createdBy')).toBe(line(section, 'Actor'));
    expect(line(section, 'Not recorded') ?? '').not.toContain('cohortDefinitionId');
  });

  test('FR2/D6 — the run_scope cohort is absent from the project cohort list', async () => {
    expect(cohortId, 'scenario 1 must have found the cohort').toBeTruthy();
    const list = await api.get(`/api/v1/cohorts?projectId=${tenant.projectId}&page=1&limit=100`, tenant.headers);
    expect(list.status).toBe(200);

    expect(asList(list.body).map((c: any) => c.id)).not.toContain(cohortId);
    const byId = await api.get(`/api/v1/cohorts/${cohortId}`, tenant.headers);
    expect(byId.status, 'still resolvable by id').toBe(200);
  });

  test('AXI-2155 A1/D6 — unlock and new-version are REFUSED on the run_scope cohort (immutability)', async () => {
    // AXI-2155 review follow-up: a run-scope cohort records what a run used
    // and may no longer drift (A1). Before this fix, scenario 3 re-versioned
    // this very cohort to exercise EC8's "newer version noted" rendering;
    // that path is now a 400 by design. EC8 itself (a chain of
    // `parentVersionId` versions is noted, never substituted) stays covered
    // at the unit level only — `audit-cohort-step.spec.ts` UT-GRAPH-2168..2177
    // (AXI-2087) — because reproducing it honestly now requires a SEPARATE
    // live `user` cohort with the run's exact resolved ready-ingestion id,
    // which this harness has no API to read back (follow-up, not a unit of
    // this story).
    expect(cohortId, 'scenario 1 must have found the cohort').toBeTruthy();

    const unlock = await api.patch(`/api/v1/cohorts/${cohortId}/unlock`, {}, tenant.headers);
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(400);
    expect(JSON.stringify(unlock.body)).toContain('immutable');

    const v2 = await api.post(
      '/api/v1/cohorts/version',
      { parentCohortId: cohortId, filterSpec: { groups: [] } },
      tenant.headers,
    );
    expect(v2.status, JSON.stringify(v2.body)).toBe(400);
    expect(JSON.stringify(v2.body)).toContain('immutable');

    // The report is unaffected — still the original, still locked.
    const section = await cohortSection(runEvidence);
    expect(line(section, 'ID')).toBe(cohortId);
    expect(line(section, 'Version')).toBe('1');
    expect(line(section, 'lockState')).toBe('locked');
  });

  test('FR4/AC6 — evidence over a snapshot no run produced keeps the cohort step "not recorded"', async () => {
    const baselineEvidence = await createEvidence(analysis.snapshotId, 'baseline');

    const section = await cohortSection(baselineEvidence);

    expect(line(section, 'ID')).toBe('not recorded');
    expect(line(section, 'Not recorded')).toContain('cohortDefinitionId');
    expect(line(section, 'cohortHash')).toBeUndefined();
  });
});
