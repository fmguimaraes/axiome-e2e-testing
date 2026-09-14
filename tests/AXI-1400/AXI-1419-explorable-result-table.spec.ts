import { test, expect, Page } from '@playwright/test';
import { adminApi, asList, sleep, type Api } from './harness/api';
import {
  ensureTenant, ingestFixture, ensureAnalysis,
  type Tenant, type Analysis,
} from './harness/seed';

/**
 * AXI-1400 — Statistical Surface: Explorable Result Tables (epic acceptance, W5).
 *
 * The epic brings a governed STATISTICAL run's result to *parity with the delta
 * path*: its output is registered as a first-class result table, dropped into the
 * triggering analysis as a rule-derived snapshot, filterable through the existing
 * filter surface, offered ranked chart candidates + user-authored charts, linked
 * into the provenance graph, and (unlike a delta result) explicitly NOT eligible
 * as a further rule referent unless its operation declares so. This spec DRIVES
 * that whole explorable surface end-to-end against the running demo, reusing the
 * platform's own snapshot / filter / candidate / dataview / provenance machinery
 * (NFR10 — no statistical-specific viewer, filter, or chart builder).
 *
 * It executes ONE governed `stats.differential_abundance` run (one row per
 * feature, columns feature/effect/pValue/qValue/reason — a multi-row result with
 * a first-class `reason` column and a declared `volcano` chart), then asserts
 * each explorable property against it. All seeding is reuse-or-create by stable
 * name (idempotent on the shared demo DB); an identical re-submission legitimately
 * DEDUPES (FR17) and the assertions resolve to the original materialised run, so
 * the spec is deterministic under `--repeat-each`.
 *
 * Live-run hardening reused from tests/AXI-1435: (a) accept SUCCEEDED **or**
 * DEDUPED as terminal-success (a DEDUPED run must name its original), and
 * (b) pin the workspace/org scope in localStorage before any UI navigation.
 *
 * Story / requirement coverage (SSoT = the feature doc):
 *   AXI-1419 FR32 AC12 — first-class result table + profiled columns (+ renders)
 *   AXI-1420 FR33 AC12 — rule-derived snapshot in the triggering analysis
 *   AXI-1421 FR34 AC13 — filterable via the existing filter surface; statistic /
 *                        fingerprint / stamp unchanged
 *   AXI-1422 FR35 FR36 AC14 — ranked chart candidates (distinct from the declared
 *                        defaultChart) + a persisted user-authored chart
 *   AXI-1423 FR37 AC15 — per-operation rule-referent eligibility (default off)
 *   AXI-1424 FR38 FR39 AC16 — provenance chain result table -> rule node ->
 *                        referent, no table-to-table edge; undefined-row handling
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const OP = 'stats.differential_abundance';
const TAXA = Array.from({ length: 8 }, (_, i) => `taxon_${i}`);
/** The operation's declared result grammar (descriptor output shape). */
const DECLARED_COLUMNS = ['feature', 'effect', 'pValue', 'qValue', 'reason'];

interface Descriptor {
  operationId: string;
  runKind: string;
  defaultChart: { type: string; roles?: Record<string, string>; annotation?: string[] } | null;
}

let api: Api;
let tenant: Tenant;
let analysis: Analysis;
let datasetId: string;
let userId: string;

let canonicalRunId: string;
let runDetail: any;
let table: any;
let resultSnap: any;
let descriptor: Descriptor;

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'DEDUPED']);

async function pollTerminal(ruleRunId: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const rr = await api.get(`/api/v1/rule-runs/${ruleRunId}`, tenant.headers);
    if (TERMINAL.has(rr.body?.status)) return rr.body;
    await sleep(2000);
  }
  throw new Error(`run ${ruleRunId} did not reach a terminal status`);
}

/** Submit the governed differential-abundance run, retrying only TRANSIENT
 *  dev-stack resets, and return the resolved materialised (original) run plus
 *  the submit response (which names the existing snapshot on a DEDUPE). */
async function runDifferentialAbundance(): Promise<{ run: any; submit: any }> {
  const body = {
    ruleId: tenant.ruleId, runKind: 'STATISTICAL', operationId: OP,
    operationParams: { groupFrom: 'A', groupTo: 'B' },
    roleBindings: { featureColumns: TAXA, groupColumn: 'arm' },
    projectId: tenant.projectId, workspaceId: tenant.workspaceId, datasetId,
    snapshotId: analysis.snapshotId, viewAnalysisId: analysis.analysisId, scope: 'FILTERED',
  };
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const submit = await api.post('/api/v1/rule-runs', body, tenant.headers);
    if (submit.status >= 300) { last = `submit ${submit.status}: ${JSON.stringify(submit.body)}`; await sleep(3000); continue; }
    const runId: string = submit.body.ruleRunId;
    expect(runId, `execute() returned no ruleRunId: ${JSON.stringify(submit.body)}`).toBeTruthy();
    const term = await pollTerminal(runId);
    if (term.status === 'SUCCEEDED' || term.status === 'DEDUPED') {
      if (term.status === 'DEDUPED') {
        expect(term.dedupedFromRunId, 'a DEDUPED run must name its original').toBeTruthy();
        const original = await api.get(`/api/v1/rule-runs/${term.dedupedFromRunId}`, tenant.headers);
        return { run: original.body, submit: submit.body };
      }
      return { run: term, submit: submit.body };
    }
    const msg = String(term.statusMessage ?? term.errorMessage ?? '');
    if (!/fetch failed|econn|reset|socket|timeout|unavailable|503/i.test(msg)) {
      throw new Error(`${OP} → ${term.status}: ${msg}`);
    }
    last = `${OP} → ${term.status} (transient): ${msg}`;
    await sleep(3000);
  }
  throw new Error(last || `${OP} did not materialise`);
}

/** Pin workspace/org scope the SPA reads from localStorage (mirrors AXI-1435). */
async function seedWorkspaceScope(page: Page): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [tenant.workspaceId, tenant.orgId] as const,
  );
}

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
  const me = await api.get('/api/v1/auth/me', tenant.headers);
  userId = me.body.id;
  expect(userId, 'admin user id').toBeTruthy();

  // A SPEC-OWNED dataset (unique CONTENT → unique datasetVersionId) paired with a
  // spec-owned analysis. The STATISTICAL run fingerprint keys on the referent's
  // datasetVersionId + rule + operation/params + operandRoles (NOT the analysis
  // or snapshot id — kernel/run-fingerprint.ts), so a unique-content referent is
  // what makes THIS spec the original materialiser: its run lands a rule-derived
  // snapshot in THIS analysis rather than deduping to some other analysis's
  // identical run on the shared demo DB. An identical re-submission
  // (--repeat-each) then dedups WITHIN this analysis, where the snapshot exists.
  datasetId = await ingestFixture(api, tenant, 'axi1400_result_surface.csv');
  analysis = await ensureAnalysis(api, tenant, 'AXI-1400 Explorable Result Surface', datasetId);

  const ops = await api.get('/api/v1/rule-runs/operations');
  descriptor = (asList(ops.body?.operations ?? ops.body) as Descriptor[]).find((d) => d.operationId === OP)!;
  expect(descriptor, `${OP} absent from the live operation surface`).toBeTruthy();

  const { run, submit } = await runDifferentialAbundance();
  canonicalRunId = run.id;
  runDetail = run;
  expect(canonicalRunId, 'materialised run id').toBeTruthy();

  table = (await api.get(`/api/v1/rule-runs/${canonicalRunId}/table?page=1&limit=100`, tenant.headers)).body;

  // The rule-derived snapshot is created as the run materialises; poll briefly
  // to absorb any small lag between terminal status and snapshot registration.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !resultSnap) {
    const snaps = await api.get(`/api/v1/view-analyses/${analysis.analysisId}/snapshots?page=1&limit=100`, tenant.headers);
    resultSnap = asList(snaps.body).find((s: any) => s.origin === 'rule_derived' && s.ruleRunId === canonicalRunId);
    if (!resultSnap) await sleep(2000);
  }
  // Defensive: if a DEDUPE reused a pre-existing materialisation, the submit
  // response names its snapshot directly (mirrors tests/AXI-1435).
  if (!resultSnap && submit?.existingSnapshotId) {
    const snaps = await api.get(`/api/v1/view-analyses/${analysis.analysisId}/snapshots?page=1&limit=100`, tenant.headers);
    resultSnap = asList(snaps.body).find((s: any) => s.id === submit.existingSnapshotId);
  }
  expect(resultSnap, `no rule-derived snapshot registered for run ${canonicalRunId}`).toBeTruthy();
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1400 — explorable statistical result table', { tag: ['@SI-017', '@SI-021', '@SI-023', '@SI-016', '@SI-035'] }, () => {
  test('AXI-1419 FR32/AC12 — the run output is a first-class, profiled result table that renders through the shared surface', async ({ page }) => {
    // FR32 — the result is registered as a first-class table and profiled through
    // the same path an uploaded dataset takes: it has a registered dataset with
    // measured, typed columns, exactly the operation's declared output grammar.
    expect(table.columns, 'declared result columns').toEqual(expect.arrayContaining(DECLARED_COLUMNS));
    expect(table.totalRows, 'one row per feature (8 taxa)').toBe(8);
    expect(runDetail.materializedNodeId, 'result materialised as a citable node').toBeTruthy();

    // Profiled-as-a-dataset: the rule-derived snapshot points at a registered
    // result dataset (the ingestion/profiling path's output), not raw run JSON.
    expect(resultSnap.datasetId, 'result registered as a dataset version').toBeTruthy();

    // AC12 — it renders through the EXISTING explorable snapshot surface (the same
    // analysis table viewer, not a bespoke statistical viewer — NFR10).
    await seedWorkspaceScope(page);
    await page.goto(`/projects/${tenant.projectId}/view-analyses/${analysis.analysisId}?snapshotId=${resultSnap.id}`);
    await expect(page.getByRole('columnheader', { name: 'feature' })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('columnheader', { name: 'pValue' })).toBeVisible();
  });

  test('AXI-1420 FR33/AC12 — a rule-derived snapshot lands in the triggering analysis, named for the operation, parented to the referent, scope recorded but not re-applied', async () => {
    expect(resultSnap.origin, 'rule-derived origin').toBe('rule_derived');
    expect(String(resultSnap.name), 'snapshot named for the operation').toContain(OP);
    // Parented to the referent snapshot the run was triggered from (FR33).
    expect(resultSnap.parentSnapshotId, 'parented to the referent snapshot').toBe(analysis.snapshotId);
    // The run's scope is recorded for display (sourceScope) but the result rows
    // are physical — no filter is re-applied over them (FR33/FR20).
    expect(resultSnap.sourceScope, 'run scope recorded for display').toBeTruthy();
    expect(resultSnap.filters ?? [], 'scope not re-applied to the result rows').toEqual([]);
  });

  test('AXI-1421 FR34/AC13 — the result is filterable through the existing filter surface; the statistic, fingerprint and stamp are unchanged', async () => {
    // Capture the statistic / fingerprint / stamp BEFORE filtering.
    const before = await api.get(`/api/v1/rule-runs/${canonicalRunId}`, tenant.headers);
    const beforeTable = await api.get(`/api/v1/rule-runs/${canonicalRunId}/table?page=1&limit=100`, tenant.headers);

    // FR34 — filter the RESULT snapshot through the SAME filter surface used for
    // any analysis snapshot: a child filter-derived snapshot over the result's
    // own columns. No statistical-specific filter implementation (NFR10).
    const filtered = await api.post('/api/v1/view-analyses/snapshots', {
      viewAnalysisId: analysis.analysisId,
      datasetId: resultSnap.datasetId,
      parentSnapshotId: resultSnap.id,
      origin: 'filter',
      filters: [{ column: 'pValue', operator: 'lt', value: 0.05 }],
    }, tenant.headers);
    expect(filtered.status, `filter snapshot create: ${JSON.stringify(filtered.body)}`).toBeLessThan(300);
    expect(filtered.body.origin, 'filter-derived child').toBe('filter');
    expect(filtered.body.parentSnapshotId, 'child of the result snapshot').toBe(resultSnap.id);
    expect(
      (filtered.body.filters ?? []).some((f: any) => f.column === 'pValue'),
      'the filter over a result column is persisted on the same surface',
    ).toBeTruthy();

    // AC13 — filtering altered neither the statistic, the run fingerprint, nor the
    // provenance stamp (materialised node) of the underlying result.
    const after = await api.get(`/api/v1/rule-runs/${canonicalRunId}`, tenant.headers);
    const afterTable = await api.get(`/api/v1/rule-runs/${canonicalRunId}/table?page=1&limit=100`, tenant.headers);
    expect(after.body.runFingerprint, 'run fingerprint unchanged').toBe(before.body.runFingerprint);
    expect(after.body.materializedNodeId, 'provenance stamp (materialised node) unchanged').toBe(before.body.materializedNodeId);
    expect(after.body.summaryJson, 'computed statistic unchanged').toEqual(before.body.summaryJson);
    expect(afterTable.body.rows, 'result rows unchanged').toEqual(beforeTable.body.rows);
  });

  test('AXI-1422 FR35/AC14 — ranked chart candidates are generated for the result table, distinct from the declared defaultChart', async () => {
    const resultDatasetId: string = resultSnap.datasetId;
    const fetchCandidates = async () =>
      asList((await api.get(
        `/api/v1/workspaces/${tenant.workspaceId}/datasets/${resultDatasetId}/candidates?viewAnalysisId=${analysis.analysisId}&snapshotId=${resultSnap.id}`,
        tenant.headers,
      )).body);

    let candidates = await fetchCandidates();
    if (candidates.length === 0) {
      await api.post(`/api/v1/workspaces/${tenant.workspaceId}/datasets/${resultDatasetId}/candidates/regenerate`, {}, tenant.headers);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && candidates.length === 0) { await sleep(2000); candidates = await fetchCandidates(); }
    }

    // FR35 — the existing candidate-generation engine produced ranked candidates
    // over the result table (the exploratory surface).
    const auto = candidates.filter((c: any) => c.origin === 'auto');
    expect(auto.length, 'auto-generated chart candidates over the result table').toBeGreaterThan(0);
    expect(auto.every((c: any) => c.candidateRank != null && c.candidateScore != null), 'candidates are ranked/scored').toBeTruthy();
    expect(auto.every((c: any) => c.datasetVersionId === resultDatasetId), 'candidates bound to the result dataset version').toBeTruthy();

    // FR35 — the operation's DECLARED defaultChart is a separate, opinionated
    // recommendation carried on the descriptor; it is NOT conflated with the
    // engine-generated candidate list (which is origin 'auto', not 'recommended').
    expect(descriptor.defaultChart, 'operation declares a defaultChart').toBeTruthy();
    expect(typeof descriptor.defaultChart!.type, 'declared chart type').toBe('string');
    expect(descriptor.defaultChart!.type.length, 'declared chart type is non-empty').toBeGreaterThan(0);
  });

  test('AXI-1422 FR36/AC14 — a user can author and persist their own chart over the result table', async () => {
    const resultDatasetId: string = resultSnap.datasetId;
    const list = async () =>
      asList((await api.get(
        `/api/v1/workspaces/${tenant.workspaceId}/datasets/${resultDatasetId}/candidates?viewAnalysisId=${analysis.analysisId}`,
        tenant.headers,
      )).body);

    const TITLE = 'AXI-1400 E2E user chart';
    const auto = (await list()).find((c: any) => c.origin === 'auto');
    expect(auto, 'an auto candidate to base the user chart template on').toBeTruthy();

    // Reuse-or-create by title so the spec is idempotent under --repeat-each.
    let mine = (await list()).find((c: any) => c.origin === 'user' && c.title === TITLE);
    if (!mine) {
      const created = await api.post(`/api/v1/workspaces/${tenant.workspaceId}/datasets/${resultDatasetId}/candidates`, {
        datasetVersionId: auto.datasetVersionId,
        templateId: auto.templateId,
        templateVersion: auto.templateVersion,
        bindings: auto.bindings,
        title: TITLE,
        createdByUserId: userId,
        viewAnalysisId: analysis.analysisId,
        snapshotId: resultSnap.id,
      }, tenant.headers);
      expect(created.status, `author chart: ${JSON.stringify(created.body)}`).toBeLessThan(300);
      mine = created.body;
    }

    // FR36 — authored through the SAME dataview surface (origin 'user') ...
    expect(mine.origin, 'user-authored chart').toBe('user');
    expect(mine.createdByUserId, 'authored by the acting user').toBe(userId);
    // ... and PERSISTED in the analysis (returned by the analysis-scoped listing).
    const persisted = (await list()).some((c: any) => c.id === mine.id && c.origin === 'user' && c.viewAnalysisId === analysis.analysisId);
    expect(persisted, 'the user chart persists in the analysis').toBeTruthy();
  });

  test('AXI-1423 FR37/AC15 — the statistical result is NOT eligible as a further rule referent by default', async () => {
    // FR37 — explorability and referent-eligibility are separate: the result is
    // explorable (above) yet, because differential_abundance does not declare
    // referent-eligibility, a rule run pinned to the result snapshot is refused.
    const asReferent = await api.post('/api/v1/rule-runs', {
      ruleId: tenant.ruleId, runKind: 'STATISTICAL', operationId: 'stats.correlation',
      operationParams: { method: 'pearson' },
      roleBindings: { xColumn: 'pValue', yColumn: 'qValue' },
      projectId: tenant.projectId, workspaceId: tenant.workspaceId, datasetId: resultSnap.datasetId,
      snapshotId: resultSnap.id, viewAnalysisId: analysis.analysisId, scope: 'FILTERED',
    }, tenant.headers);

    expect(asReferent.status, 'a statistical result is refused as a rule referent').toBe(400);
    expect(String(asReferent.body?.message ?? ''), 'refusal names the FR37 referent-eligibility rule')
      .toContain('referent-eligibility');
    expect(asReferent.body?.ruleRunId ?? null, 'no run row is created on the refusal').toBeFalsy();
  });

  test('AXI-1424 FR38/AC16 — the provenance chain result table -> rule node -> referent is navigable, with no direct table-to-table edge', async () => {
    const graph = (await api.get(`/api/v1/view-analyses/${analysis.analysisId}/provenance-graph`, tenant.headers)).body;
    const nodes: any[] = graph.nodes ?? [];
    const edges: any[] = graph.edges ?? [];

    // The rule node for our run (a MaterializedView carrying the operation).
    const ruleNode = nodes.find((n) => n.nodeType === 'MaterializedView' && n.referenceId === canonicalRunId);
    expect(ruleNode, 'the rule node (MaterializedView) for this run').toBeTruthy();
    expect(ruleNode.metadata?.operationId, 'rule node carries the operation').toBe(OP);

    // The result table node (the Dataset the run materialised).
    const resultTableNode = nodes.find((n) => n.nodeType === 'Dataset' && n.referenceId === resultSnap.datasetId);
    expect(resultTableNode, 'the result-table Dataset node').toBeTruthy();

    // The referent node (the snapshot the run was triggered from).
    const referentNode = nodes.find((n) => n.nodeType === 'ViewAnalysisSnapshot' && n.referenceId === resultSnap.parentSnapshotId);
    expect(referentNode, 'the referent snapshot node').toBeTruthy();

    const connected = (a: string, b: string) =>
      edges.some((e) => (e.sourceNodeId === a && e.targetNodeId === b) || (e.sourceNodeId === b && e.targetNodeId === a));

    // FR38 — result table -> rule node -> referent is navigable.
    expect(connected(resultTableNode.id, ruleNode.id), 'result table linked to the rule node').toBeTruthy();
    expect(connected(ruleNode.id, referentNode.id), 'rule node linked to the referent').toBeTruthy();

    // FR38 — no DIRECT table-to-table edge (Dataset <-> Dataset); every table hop
    // goes through the rule node.
    const datasetIds = new Set(nodes.filter((n) => n.nodeType === 'Dataset').map((n) => n.id));
    const tableToTable = edges.filter((e) => datasetIds.has(e.sourceNodeId) && datasetIds.has(e.targetNodeId));
    expect(tableToTable, 'no direct table-to-table edge').toHaveLength(0);
  });

  test('AXI-1424 FR39 — undefined rows are a first-class, filterable result column and excluded from chart candidates', async () => {
    // FR39 — the operation could-not-compute channel (`reason`) is a first-class
    // column of the result table, visible alongside the computed rows ...
    expect(table.columns, 'reason is a first-class result column').toContain('reason');
    expect(table.rows.every((r: any) => 'reason' in r), 'every row carries its reason channel').toBeTruthy();

    // ... and the run tracks the undefined-row count explicitly (never silent).
    expect(runDetail.summaryJson, 'run summary present').toBeTruthy();
    expect(runDetail.summaryJson.undefinedFeatures, 'undefined-feature count is tracked explicitly').not.toBeUndefined();

    // FR39 — `reason` is filterable through the same surface as any other column.
    const filtered = await api.post('/api/v1/view-analyses/snapshots', {
      viewAnalysisId: analysis.analysisId,
      datasetId: resultSnap.datasetId,
      parentSnapshotId: resultSnap.id,
      origin: 'filter',
      filters: [{ column: 'reason', operator: 'is_null' }],
    }, tenant.headers);
    expect(filtered.status, `reason is filterable: ${JSON.stringify(filtered.body)}`).toBeLessThan(300);
    expect((filtered.body.filters ?? []).some((f: any) => f.column === 'reason'), 'reason filter persisted').toBeTruthy();

    // FR39 — the undefined-row channel is EXCLUDED from charts: no generated
    // candidate binds `reason` into a plotted encoding.
    const resultDatasetId: string = resultSnap.datasetId;
    const candidates = asList((await api.get(
      `/api/v1/workspaces/${tenant.workspaceId}/datasets/${resultDatasetId}/candidates?viewAnalysisId=${analysis.analysisId}&snapshotId=${resultSnap.id}`,
      tenant.headers,
    )).body).filter((c: any) => c.origin === 'auto');
    const bindsReason = candidates.some((c: any) =>
      Object.values(c.bindings ?? {}).some((b: any) => String((b as any)?.column_id ?? b).toLowerCase().includes('reason')),
    );
    expect(bindsReason, 'no chart candidate plots the undefined-row (reason) channel').toBeFalsy();
  });
});
