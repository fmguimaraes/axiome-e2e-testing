import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { carrierRuleId } from '../AXI-1400/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2474 (epic AXI-2455 — SAP FR57, FR50, NFR8; SI-047, SI-016, SI-013) — ONE SAP-run reference
 * reader: the client report's SAP section and the rule-run read (`GET /rule-runs/:id` `sapRun`)
 * agree for every run. The case they disagreed on before: an ORDINARY run inside a ◆ SAP analysis
 * (here a direct `POST /rule-runs` on a snapshot of the SAP run's analysis). Its run read served
 * `sapRun: null`, while its client report claimed "This run is part of SAP run …" with the question
 * "not recorded". Now both say it is no SAP-run child, and the report prints the FR51 sentence.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md
 * § "AXI-2474" (AXI-2474.1, .2 playwright; .3 manual — the index plan is a database fact).
 *
 * API-level by design: the change is in two server reads; no screen changes.
 *
 * World: the AXI-2265 `PrivateProjectsWorld` (editor = governed_execution:submit + sap:write). The
 * platform admin STAYS a member and makes the rule-run reads, the client-report reads and the direct
 * run: the `op:` carrier is a SYSTEM rule a self-registered actor's fresh organization is not
 * entitled to (AXI-1290 run hiding; the AXI-2443 / AXI-2444 specs' reason). The SAP pins the
 * NEWEST T1 version the project's `/sap-templates` lists — never a hard-coded version.
 *
 * Needs AXI-2474 on the target backend: against a backend without it, AXI-2474.1 FAILS (the
 * report still claims the SAP run) — that is the defect this story fixes.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-047', '@SI-016', '@SI-013'] };
const MWU = 'stats.mann_whitney_u';
const READY_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 180_000;
const SETUP_TIMEOUT_MS = 8 * 60_000;
const NOT_A_SAP_RUN = 'This run is not part of a SAP run; its result is exploratory.';
const QUESTION_TEXT = 'Does arm A change the score compared with arm B?';
/** The AXI-2308 harness' settled node statuses (`settledGovernedRun`). */
const SETTLED_NODE = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL']);

let world: PrivateProjectsWorld;
let editor: Actor;
let project: string;
let dataset: string;
let ingestion: string;
let sap: any;
let t1Version: string;
let run: any;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const runsPath = (sapId: string, suffix = '') => `${base(project)}/saps/${sapId}/runs${suffix}`;
const requestId = (label: string) => `axi2474-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const adminHeaders = () => ({ 'X-Workspace-Id': world.workspaceId });

async function pinNewestT1(projectId: string): Promise<string> {
  const res = await editor.api.get(`${base(projectId)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
}

/** One primary question, NO sensitivity analysis: its child is the ONLY producer of its rule run. */
function primaryQuestion() {
  return {
    text: QUESTION_TEXT,
    role: 'primary',
    estimand: {
      population: 'All randomised subjects',
      variable: 'Score at week 12',
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Difference in medians',
      treatmentComparison: 'Arm A vs arm B',
    },
    template: { templateId: 'T1', templateVersion: t1Version },
    bindings: [
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

async function uploadSeparatedDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2474-${Date.now()}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 16 }, (_, i) => {
    const arm = i % 2 === 0 ? 'A' : 'B';
    const score = arm === 'A' ? 20 + i * 0.7 : 5 + i * 0.3;
    return `S${i + 1},${arm},${score.toFixed(1)}`;
  });
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: `subject_id,arm,score\n${rows.join('\n')}\n`,
  });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

async function readyIngestion(datasetId: string): Promise<string> {
  const path = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}`);
  let id = '';
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(path);
        const latest = res.ok() ? (await res.json()).latestIngestion : null;
        if (latest?.status === 'ready') id = latest.id;
        return latest?.status ?? 'none';
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toBe('ready');
  return id;
}

async function finaliseSap(projectId: string, datasetId: string): Promise<any> {
  const draft = await (await editor.api.post(`${base(projectId)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(projectId)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'AXI-2474 reference plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: datasetId, question: primaryQuestion() },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await expect
    .poll(
      async () => {
        const report = await (await editor.api.get(`${base(projectId)}/saps/${draft.sapId}/draft/completeness`)).json();
        return report.results.filter((r: any) => r.status === 'fail').map((r: any) => r.checkId);
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toEqual([]);
  const finalised = await editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/finalise`, {
    data: { basedOnRevision: complete.revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
  return finalised.json();
}

async function evaluatedRun(sapRunId: string): Promise<any> {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(runsPath(sap.id, `/${sapRunId}`));
        latest = res.ok() ? await res.json() : null;
        return latest?.status ?? `http ${res.status()}`;
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .not.toBe('running');
  return latest;
}

async function settledGovernedRun(runId: string): Promise<any> {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(apiUrl(`/api/v1/governed-execution/status?projectId=${project}&runId=${runId}`));
        latest = res.ok() ? await res.json() : null;
        const nodes: Array<{ status: string }> = latest?.nodes ?? [];
        return nodes.length > 0 && nodes.every((n) => SETTLED_NODE.has(n.status));
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .toBe(true);
  return latest;
}

/** `GET /rule-runs/:id` as the workspace admin, polled until the run is terminal. */
async function settledRuleRun(ruleRunId: string): Promise<any> {
  let body: any = null;
  await expect
    .poll(
      async () => {
        const res = await world.admin.get(apiUrl(`/api/v1/rule-runs/${ruleRunId}`), { headers: adminHeaders() });
        body = res.ok() ? await res.json() : null;
        return body?.status ?? `HTTP ${res.status()}`;
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toMatch(/^(SUCCEEDED|FAILED|DEDUPED)$/);
  return body;
}

async function clientReport(ruleRunId: string): Promise<string> {
  let text = '';
  await expect
    .poll(
      async () => {
        const res = await world.admin.get(apiUrl(`/api/v1/projects/${project}/rule-runs/${ruleRunId}/client-report?format=md`), {
          headers: adminHeaders(),
        });
        text = await res.text();
        return res.status();
      },
      { timeout: 60_000, intervals: [2_000, 5_000] },
    )
    .toBe(200);
  return text;
}

/** An empty-filter snapshot of the ◆ SAP analysis (reused if one exists). */
async function sapAnalysisSnapshot(viewAnalysisId: string): Promise<string> {
  const listed = await world.admin.get(apiUrl(`/api/v1/view-analyses/${viewAnalysisId}/snapshots?page=1&limit=100`), {
    headers: adminHeaders(),
  });
  expect(listed.status(), await listed.text()).toBe(200);
  const body = await listed.json();
  const rows: any[] = Array.isArray(body) ? body : body.data ?? body.items ?? [];
  const baseline = rows.find((s) => s.origin === 'filter' && (s.filters == null || s.filters.length === 0));
  if (baseline) return baseline.id;
  const created = await world.admin.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    headers: adminHeaders(),
    data: { viewAnalysisId, filters: [] },
  });
  expect(created.status(), await created.text()).toBeLessThan(300);
  return (await created.json()).id;
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS); // hooks are governed by setTimeout, never describe.configure
  await approveCarriersFor([MWU]);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  await world.addMember(editor, 'editor');
  const created = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2474 reference ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(created.status(), await created.text()).toBe(201);
  project = (await created.json()).id;
  t1Version = await pinNewestT1(project);
  dataset = await uploadSeparatedDataset();
  const linked = await editor.api.post(`${base(project)}/datasets`, { data: { datasetId: dataset } });
  expect(linked.status(), await linked.text()).toBeLessThan(300);
  ingestion = await readyIngestion(dataset);
  sap = await finaliseSap(project, dataset);
  const started = await editor.api.post(runsPath(sap.id), {
    data: { datasetVersionId: ingestion, clientRequestId: requestId('run') },
  });
  expect(started.status(), await started.text()).toBe(201);
  run = await evaluatedRun((await started.json()).sapRunId);
  expect(run.status, JSON.stringify(run)).toBe('completed');
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2474 — one SAP-run reference reader', TAGS, () => {
  test("FR57, FR50 — AXI-2474.1: a SAP-run child's rule-run read and client report name the SAME SAP run and question", async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 60_000);
    // Arrange
    const [question] = run.questions;
    const child = await settledGovernedRun(question.childRunId);
    expect(child.ruleRunId, JSON.stringify(child.nodes)).toBeTruthy();

    // Act
    const ruleRun = await settledRuleRun(child.ruleRunId);
    const report = await clientReport(child.ruleRunId);

    // Assert — the run read
    expect(ruleRun.sapRun).toEqual({
      sapRunId: run.sapRunId,
      questionId: question.questionId,
      sensitivityIndex: null,
      role: 'primary',
    });
    // Assert — the report agrees
    expect(report).toContain(`This run is part of SAP run ${ruleRun.sapRun.sapRunId}`);
    expect(report).toContain(`Question Q1 (${ruleRun.sapRun.role}), verbatim:`);
    expect(report).toContain(QUESTION_TEXT);
    expect(report).not.toContain(NOT_A_SAP_RUN);
  });

  test('FR57, FR50, FR51 — AXI-2474.2: an ordinary run inside the ◆ SAP analysis is no SAP-run child in its rule-run read AND its client report', async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 60_000);
    // Arrange — a direct rule run (groups B vs A) on a snapshot of the SAP run's own analysis
    const snapshotId = await sapAnalysisSnapshot(run.viewAnalysisId);
    const submitted = await world.admin.post(apiUrl('/api/v1/rule-runs'), {
      headers: adminHeaders(),
      data: {
        ruleId: await carrierRuleId(MWU),
        runKind: 'STATISTICAL',
        operationId: MWU,
        roleBindings: { groupColumn: 'arm' },
        pivot: { valueColumns: ['score'] },
        operationParams: { groupFrom: 'B', groupTo: 'A' },
        projectId: project,
        workspaceId: world.workspaceId,
        datasetId: dataset,
        snapshotId,
        viewAnalysisId: run.viewAnalysisId,
        scope: 'FILTERED',
      },
    });
    const submittedText = await submitted.text();
    expect(submitted.status(), submittedText).toBeLessThan(300);
    const ruleRunId: string = JSON.parse(submittedText).ruleRunId;

    // Act
    const ruleRun = await settledRuleRun(ruleRunId);
    expect(ruleRun.status, JSON.stringify(ruleRun)).not.toBe('FAILED');
    const report = await clientReport(ruleRunId);

    // Assert — the run read: an ordinary run, unbound
    expect({ sapBinding: ruleRun.sapBinding ?? null, sapVersionId: ruleRun.sapVersionId ?? null, sapRun: ruleRun.sapRun }).toEqual({
      sapBinding: null,
      sapVersionId: null,
      sapRun: null,
    });
    // Assert — the report agrees: exploratory, no SAP-run claim
    expect(report).toContain(NOT_A_SAP_RUN);
    expect(report).not.toContain(`This run is part of SAP run ${run.sapRunId}`);
    expect(report).not.toContain('## Statistical Analysis Plan — SAP run');
  });
});
