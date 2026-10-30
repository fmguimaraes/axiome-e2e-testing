import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { adminApi, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';
import { projectSapVersionId } from '../AXI-2308/harness/project-sap';

/**
 * AXI-2316 (epic AXI-2309 — Feature doc §12, owner-approved 2026-10-29; AC9):
 * edge-case engine behaviour — EC1 (empty/n=1 arm), EC2 (all-tied column),
 * EC3 (missing values per variable), EC5 (merged xlsx header rows), EC6
 * (duplicate column names), EC12 (a SAP's linked method no longer resolves,
 * engine-side half only).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md`
 * §5.1-§5.6. EC4 (negatives on a log axis) is deliberately NOT covered here —
 * SI-018 chart-render territory, outside this story's declared SI-020/021/022
 * boundary; see §5.7 of the scenario doc and the AXI-2316 learnings block in
 * the Developer Epic Context.
 *
 * STATUS: RUN headless, 8/8 green (2026-10-29, review bounce #2 rework),
 * against an ISOLATED stack serving this story's branches — never the shared
 * demo DB: a throwaway Postgres/Mongo/Redis, an own RabbitMQ vhost, own MinIO
 * buckets, and sidecar containers for axiome-back (gateway + user/event/
 * organization/control-plane services) and axiome-bio-compute, each mounting
 * the AXI-2316 worktree. Negative control: the same spec against the
 * pre-rework bio-compute (d8b07e5) fails the boolean-arm test with the
 * reviewer's exact "insufficient groups: 0" and the BOM test with
 * `\ufeffid` / `Value.1.1` — so neither new test is latently green.
 * Run with: `API_BASE_URL=<gateway> npx playwright test tests/AXI-2309/AXI-2316-*`.
 *
 * Every STATISTICAL run is bound to a SAP version (AXI-2310, merged on main:
 * `SAP_VERSION_REQUIRED` otherwise) — see `sapVersionFor`.
 *
 * Seeding reuses the AXI-1400 harness (`ensureTenant`/`ensureAnalysis`/
 * `carrierRuleId`) read-only, additive; this story owns only its own fixtures
 * (`tests/AXI-2309/fixtures/`) and the ingestion/run helpers below.
 */

const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-2309', 'fixtures');
const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 120_000;
const RUN_POLL_MS = 2_000;

const CONTENT_TYPE: Record<string, string> = {
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

async function ingestFixture(api: Api, t: Tenant, filename: string): Promise<string> {
  const ws = t.workspaceId;
  const existing = await api.get(`/api/v1/workspaces/${ws}/datasets?search=${encodeURIComponent(filename)}`, t.headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === filename && d.availability === 'available');
  const datasetId = prior ? prior.id : await uploadAndFinalize(api, t, filename);
  await ensureLink(api, t, datasetId);
  return datasetId;
}

async function uploadAndFinalize(api: Api, t: Tenant, filename: string): Promise<string> {
  const ws = t.workspaceId;
  const ext = filename.slice(filename.lastIndexOf('.'));
  const contentType = CONTENT_TYPE[ext] ?? 'application/octet-stream';
  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const init = await api.post(`/api/v1/workspaces/${ws}/datasets`, {
    organizationId: t.orgId, originalFilename: filename, contentType,
  }, t.headers);
  const datasetId = init.body?.dataset?.id;
  if (!datasetId) throw new Error(`upload init of ${filename} returned no dataset (${init.status}): ${JSON.stringify(init.body)}`);
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${filename} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${ws}/datasets/${datasetId}/finalize`, undefined, t.headers);
  if (fin.status >= 300) throw new Error(`finalize ${filename} failed (${fin.status})`);
  await waitForIngestion(api, t, datasetId, filename);
  return datasetId;
}

async function waitForIngestion(api: Api, t: Tenant, datasetId: string, filename: string): Promise<void> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}`, t.headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return;
    if (status === 'failed') throw new Error(`ingestion of ${filename} failed`);
    await sleep(INGEST_POLL_MS);
  }
  throw new Error(`ingestion of ${filename} timed out`);
}

async function ensureLink(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const linked = async () => {
    const res = await api.get(`/api/v1/projects/${t.projectId}/datasets`, t.headers);
    return asList(res.body).some((l: any) => l.datasetId === datasetId);
  };
  if (await linked()) return;
  await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`dataset ${datasetId} did not link to project ${t.projectId}`);
}

/** The columns + first rows of a dataset as actually ingested/materialized. */
async function queryDataset(api: Api, t: Tenant, datasetId: string): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/query`, { limit: 100 }, t.headers);
  if (res.status !== 200) throw new Error(`query of ${datasetId} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return {
    columns: (res.body.columns ?? []).map((c: { name: string }) => c.name),
    rows: res.body.rows ?? [],
  };
}

interface RunArgs {
  roleBindings: Record<string, string>;
  operationParams?: Record<string, unknown>;
  operationId: string;
  pivot?: { valueColumns?: string[] };
}

/** Submits a rule-run directly (backend-only STATISTICAL contract, mirrors
 *  `tests/AXI-2031/AXI-2034-correlation-q-values.spec.ts`), polls to terminal,
 *  and returns the final run body. */
async function runAndWait(api: Api, t: Tenant, a: Analysis, datasetId: string, args: RunArgs): Promise<any> {
  const body = {
    ruleId: await carrierRuleId(args.operationId),
    runKind: 'STATISTICAL',
    operationId: args.operationId,
    roleBindings: args.roleBindings,
    operationParams: args.operationParams ?? {},
    pivot: args.pivot,
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: a.snapshotId, viewAnalysisId: a.analysisId, scope: 'FILTERED',
    sapVersionId: await sapVersionFor(api, t),
  };
  const submitted = await api.post('/api/v1/rule-runs', body, t.headers);
  // Every caller of this helper expects an ACCEPTED run — a refusal here is
  // the failure under test (e.g. the pre-B1 `sufficient_group_members` BLOCK
  // refusing EC1's n=1 arm at submission), so surface it verbatim instead of
  // returning an undefined `run` for the caller to trip over.
  if (submitted.status >= 400) {
    throw new Error(`rule-run submission of ${args.operationId} refused (${submitted.status}): ${JSON.stringify(submitted.body)}`);
  }
  const ruleRunId = submitted.body.ruleRunId;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
    if (['SUCCEEDED', 'FAILED', 'DEDUPED'].includes(run.body?.status)) return { submitted, run: run.body };
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`run of ${args.operationId} timed out`);
}

/**
 * AXI-2310 (merged on main): every STATISTICAL run must be bound to a SAP
 * version of its own project (`SAP_VERSION_REQUIRED` otherwise, EC7). Since
 * AXI-2338 a project holds exactly one SAP, so the reused tenant project's SAP
 * is created on the first run and bound on every later one
 * (`projectSapVersionId`) — a refusal here is never about the missing binding.
 */
let sapVersionId: Promise<string> | undefined;
function sapVersionFor(api: Api, t: Tenant): Promise<string> {
  sapVersionId ??= projectSapVersionId(api, t.projectId, t.headers, {
    title: `AXI-2316 edge-case engine behaviour ${Date.now()}`,
    questionText: 'Do the edge-case referents (n=1 arm, all-tied, per-variable missing) compute as Feature §12 specifies?',
    planText: 'Kruskal-Wallis across every arm; Mann-Whitney U between arms A and B; alpha = 0.05, two-sided.',
    linkedMethods: [{ operationId: 'stats.kruskal_wallis' }, { operationId: 'stats.mann_whitney_u' }],
  });
  return sapVersionId;
}

function canonicalRunId(run: any): string {
  return run.dedupedFromRunId ?? run.ruleRunId ?? run.id;
}

async function resultTable(api: Api, t: Tenant, runId: string): Promise<{ totalRows: number; columns: string[]; rows: Array<Record<string, unknown>> }> {
  const res = await api.get(`/api/v1/rule-runs/${runId}/table`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let api: Api;
let t: Tenant;
let analysis: Analysis;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2316 — edge-case engine behaviour (AC9)', { tag: ['@SI-021', '@SI-014'] }, () => {
  test('AC9/EC1 — an n=1 arm is excluded by name; the k-sample test runs over the remaining valid arms (@SI-021)', async () => {
    const datasetId = await ingestFixture(api, t, 'armExclusion.csv');
    analysis = await ensureAnalysis(api, t, 'AXI-2316 arm exclusion', datasetId);

    const { run } = await runAndWait(api, t, analysis, datasetId, {
      operationId: 'stats.kruskal_wallis',
      roleBindings: { groupColumn: 'arm' },
      pivot: { valueColumns: ['score'] },
    });
    expect(['SUCCEEDED', 'DEDUPED'], `run never crashed the whole job for a 3-arm referent with one n=1 arm: ${run?.statusMessage ?? run?.errorMessage ?? JSON.stringify(run)}`).toContain(run.status);

    const table = await resultTable(api, t, canonicalRunId(run));
    expect(table.totalRows).toBeGreaterThanOrEqual(1);
    const row = table.rows[0];
    // The statistic is DEFINED (computed over arms A/B after excluding C) —
    // never undefined just because one arm was too small. `row.hStatistic ??
    // row.reason` would pass on EITHER a computed stat OR a (pre-fix)
    // "insufficient groups" reason — it must fail on unfixed code, not just
    // on a crash.
    expect(row.reason, `row carries a reason — the test stayed undefined instead of running on the valid arms: ${JSON.stringify(row)}`).toBeFalsy();
    expect(row.hStatistic, `row carries no hStatistic even though reason is falsy: ${JSON.stringify(row)}`).not.toBeNull();
    expect(row.hStatistic).not.toBeUndefined();
    // Only the two valid arms (A, B) entered the comparison — C was excluded.
    expect(row.nGroups, JSON.stringify(row)).toBe(2);
  });

  test('AC9/EC1 — a BOOLEAN group column is compared over its real arms, never "insufficient groups: 0" (@SI-021)', async () => {
    // Review bounce #2, R1: a `true`/`false` CSV column is inferred Boolean
    // by polars. The referent labels were once `str()`-rendered (`"True"`)
    // while groups were keyed by polars' cast (`"true"`): no arm matched,
    // every arm was "excluded" at n=0, and the test came back undefined.
    const datasetId = await ingestFixture(api, t, 'booleanArm.csv');
    const boolAnalysis = await ensureAnalysis(api, t, 'AXI-2316 boolean arm', datasetId);

    const { run } = await runAndWait(api, t, boolAnalysis, datasetId, {
      operationId: 'stats.kruskal_wallis',
      roleBindings: { groupColumn: 'arm' },
      pivot: { valueColumns: ['score'] },
    });
    expect(['SUCCEEDED', 'DEDUPED'], JSON.stringify(run)).toContain(run.status);

    const row = (await resultTable(api, t, canonicalRunId(run))).rows[0];
    expect(row.reason, `a 3/3 boolean group column must be computable: ${JSON.stringify(row)}`).toBeFalsy();
    expect(row.nGroups, JSON.stringify(row)).toBe(2);
    expect(row.n, JSON.stringify(row)).toBe(6);
  });

  test('AC9/EC2 — an all-tied column is a defined "not computable" result, never a crash (@SI-021)', async () => {
    const datasetId = await ingestFixture(api, t, 'allTied.csv');
    const tiedAnalysis = await ensureAnalysis(api, t, 'AXI-2316 all tied', datasetId);

    const { run } = await runAndWait(api, t, tiedAnalysis, datasetId, {
      operationId: 'stats.mann_whitney_u',
      roleBindings: { groupColumn: 'arm' },
      pivot: { valueColumns: ['score'] },
      operationParams: { groupFrom: 'A', groupTo: 'B' },
    });
    expect(['SUCCEEDED', 'DEDUPED'], `all-tied column must SUCCEED as a method-level warning, not fail: ${run?.statusMessage ?? run?.errorMessage ?? JSON.stringify(run)}`).toContain(run.status);

    const table = await resultTable(api, t, canonicalRunId(run));
    const row = table.rows[0];
    expect(row.reason, `an all-tied column must be a NAMED not-computable result: ${JSON.stringify(row)}`).toBeTruthy();
    expect(row.uStatistic ?? null).toBeNull();
  });

  test('AC9/EC3 — missing values per variable: n reflects only that variable\'s own usable rows (@SI-021)', async () => {
    const datasetId = await ingestFixture(api, t, 'perVariableMissing.csv');
    const missingAnalysis = await ensureAnalysis(api, t, 'AXI-2316 per variable missing', datasetId);

    const runX = await runAndWait(api, t, missingAnalysis, datasetId, {
      operationId: 'stats.mann_whitney_u',
      roleBindings: { groupColumn: 'arm' },
      pivot: { valueColumns: ['varX'] },
      operationParams: { groupFrom: 'A', groupTo: 'B' },
    });
    const runY = await runAndWait(api, t, missingAnalysis, datasetId, {
      operationId: 'stats.mann_whitney_u',
      roleBindings: { groupColumn: 'arm' },
      pivot: { valueColumns: ['varY'] },
      operationParams: { groupFrom: 'A', groupTo: 'B' },
    });

    const tableX = await resultTable(api, t, canonicalRunId(runX.run));
    const tableY = await resultTable(api, t, canonicalRunId(runY.run));
    // varX is missing exactly one of 6 rows (s2); varY is missing exactly one
    // DIFFERENT row (s5) — each test's own usable-row count must reflect only
    // ITS variable's usable rows (5 of 6), never a whole-row drop that also
    // removes the row whose OTHER variable was fine. `stats.mann_whitney_u`'s
    // row carries `nGroupFrom`/`nGroupTo` (groupFrom='A', groupTo='B'), not a
    // bare `n` — there is no such field on this operation's contract, so the
    // sum of the two sides is the "5 of 6 usable" fact under test.
    const rowX = tableX.rows[0];
    const rowY = tableY.rows[0];
    expect((rowX.nGroupFrom as number) + (rowX.nGroupTo as number), JSON.stringify(rowX)).toBe(5);
    expect((rowY.nGroupFrom as number) + (rowY.nGroupTo as number), JSON.stringify(rowY)).toBe(5);
    // And the split itself is the variable's OWN missing row, not the other's:
    // varX drops s2 (arm A) -> A=2/B=3; varY drops s5 (arm B) -> A=3/B=2.
    expect(rowX.nGroupFrom).toBe(2);
    expect(rowX.nGroupTo).toBe(3);
    expect(rowY.nGroupFrom).toBe(3);
    expect(rowY.nGroupTo).toBe(2);
  });

  test('AC9/EC5 — a merged xlsx header cell is flattened deterministically, never shifted/garbled (@SI-014)', async () => {
    const datasetId = await ingestFixture(api, t, 'mergedHeader.xlsx');
    const { columns, rows } = await queryDataset(api, t, datasetId);

    expect(columns).toEqual(expect.arrayContaining(['Timepoint', 'Timepoint.1']));
    expect(rows[0].Timepoint).toBe('W0');
    expect(rows[0]['Timepoint.1']).toBe('W0');
  });

  test('AC9/EC6 — duplicate xlsx column names are disambiguated, never silently overwritten (@SI-014)', async () => {
    const datasetId = await ingestFixture(api, t, 'duplicateColumns.xlsx');
    const { columns, rows } = await queryDataset(api, t, datasetId);

    expect(columns).toEqual(expect.arrayContaining(['Value', 'Value.1']));
    // Each column keeps its OWN data — never overwritten by the other duplicate.
    expect(rows[0].Value).toBe(10);
    expect(rows[0]['Value.1']).toBe(20);
  });

  test('AC9/EC6 — a BOM-prefixed CSV with duplicate names keeps every real column\'s identity (@SI-014)', async () => {
    // Review bounce #2, R2 + R3: Excel's "CSV UTF-8" export (BOM) with
    // `Value,Value,Value.1`. The first column stays `id` (polars' own parse,
    // never `﻿id`); the REAL `Value.1` keeps its name and data; only
    // the repeated `Value` is renamed — to `Value.2`, skipping the taken name.
    const datasetId = await ingestFixture(api, t, 'bomDuplicateColumns.csv');
    const { columns, rows } = await queryDataset(api, t, datasetId);

    expect(columns).toEqual(['id', 'Value', 'Value.2', 'Value.1']);
    expect(rows[0].id).toBe('s1');
    expect(rows[0].Value).toBe(10);
    expect(rows[0]['Value.2']).toBe(20);
    expect(rows[0]['Value.1']).toBe(30);
  });

  test('AC9/EC12 — an unresolvable operation id is refused by name, never guessed (@SI-021)', async () => {
    const datasetId = await ingestFixture(api, t, 'armExclusion.csv');
    const refusalAnalysis = await ensureAnalysis(api, t, 'AXI-2316 unresolved operation', datasetId);

    const body = {
      ruleId: await carrierRuleId('stats.kruskal_wallis'),
      runKind: 'STATISTICAL',
      operationId: 'stats.method_removed_after_sap_linked_it',
      roleBindings: { groupColumn: 'arm' },
      operationParams: {},
      pivot: { valueColumns: ['score'] },
      projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
      snapshotId: refusalAnalysis.snapshotId, viewAnalysisId: refusalAnalysis.analysisId, scope: 'FILTERED',
      // Bound to a valid SAP version, so the refusal under test is the
      // unresolvable operation — never the (AXI-2310) missing SAP binding.
      sapVersionId: await sapVersionFor(api, t),
    };
    const submitted = await api.post('/api/v1/rule-runs', body, t.headers);
    expect(submitted.status, 'an unresolvable operation id must be REFUSED, never accepted/guessed').toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(submitted.body)).toContain('stats.method_removed_after_sap_linked_it');
  });
});
