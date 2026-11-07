import { createHash } from 'node:crypto';
import { test, expect, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2444 (epic AXI-2433 Structured SAP) — SAP reports: the SAP-run report download and the
 * SAP section of a SAP-run child's client report. API-level by design (the Runs tab's
 * "Download report" button is AXI-2446, which consumes exactly this route).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md
 * § "AXI-2444 — SAP reports" (AXI-2444.1 .. AXI-2444.5).
 *
 * World: the AXI-2265 `PrivateProjectsWorld` — editor (governed_execution:submit + sap:write),
 * viewer (neither), outsider (no project access). The platform admin STAYS a member: it reads
 * the rule-run client report, whose `op:` carrier is a system rule a self-registered actor's
 * fresh organization is not entitled to (the AXI-2338 spec's reason). The SAP pins the NEWEST
 * T1 version the project's `/sap-templates` lists — never a hard-coded version.
 *
 * Needs AXI-2444 on the target backend. AXI-2444.5 (FR51 on a NEW ordinary run) also needs
 * AXI-2443 (binder retirement): until then an ordinary run still records a legacy SAP binding
 * and the scenario SKIPS with that reason — it never passes against the legacy wording.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-016', '@SI-065', '@SI-010', '@SI-002'] };
const READY_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 180_000;
const SETUP_TIMEOUT_MS = 6 * 60_000;
const RUO = 'Research Use Only. Not for use in diagnostic procedures.';
const NOT_A_SAP_RUN = 'This run is not part of a SAP run; its result is exploratory.';
const OVERCLAIM = /proven|confirmed effect|confirms/i;
/** The AXI-2308 harness' settled node statuses (`settledGovernedRun`). */
const SETTLED_NODE = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL']);
const QUESTION_TEXT = 'Does arm A change the score compared with arm B?';

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;
let project: string;
let otherProject: string;
let dataset: string;
let ingestion: string;
let sap: any;
let t1Version: string;
let run: any;
let firstDownload: { status: number; headers: Record<string, string>; body: string };

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const runsPath = (projectId: string, sapId: string, suffix = '') => `${base(projectId)}/saps/${sapId}/runs${suffix}`;
const reportPath = (projectId: string, sapId: string, sapRunId: string) => runsPath(projectId, sapId, `/${sapRunId}/report`);
const requestId = (label: string) => `axi2444-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The client report's verification rule (FR10), re-implemented from the report alone. */
function recomputeReportHash(markdown: string): string {
  const lines = markdown.split('\n');
  const firstHeading = lines.findIndex((l) => l.startsWith('## '));
  const headerEnd = firstHeading === -1 ? lines.length : firstHeading;
  const generated = lines.findIndex((l, i) => i < headerEnd && l.startsWith('Generated: '));
  const hashLine = lines.findIndex((l, i) => i < headerEnd && l.startsWith('Report SHA-256: '));
  const kept = lines.filter((_, i) => i !== generated && i !== hashLine);
  return createHash('sha256').update(kept.join('\n'), 'utf8').digest('hex');
}

async function download(res: APIResponse) {
  return { status: res.status(), headers: res.headers(), body: await res.text() };
}

async function pinNewestT1(projectId: string): Promise<string> {
  const res = await editor.api.get(`${base(projectId)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
}

function t1Analysis() {
  return {
    template: { templateId: 'T1', templateVersion: t1Version },
    bindings: [
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
  };
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
    ...t1Analysis(),
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2444 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** Fully separated arms — a clearly rejected T1. */
async function uploadSeparatedDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2444-${Date.now()}.csv`, contentType: 'text/csv' },
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

async function link(projectId: string, datasetId: string): Promise<void> {
  const res = await editor.api.post(`${base(projectId)}/datasets`, { data: { datasetId } });
  expect(res.status(), await res.text()).toBeLessThan(300);
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
    data: { basedOnRevision: draft.revision, title: 'AXI-2444 reports plan' },
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
        const res = await editor.api.get(runsPath(project, sap.id, `/${sapRunId}`));
        latest = res.ok() ? await res.json() : null;
        return latest?.status ?? `http ${res.status()}`;
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .not.toBe('running');
  return latest;
}

/** A settled governed run's status (names the rule run that produced its result). */
async function settledGovernedRun(projectId: string, runId: string): Promise<any> {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(apiUrl(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`));
        latest = res.ok() ? await res.json() : null;
        const nodes: Array<{ status: string }> = latest?.nodes ?? [];
        return nodes.length > 0 && nodes.every((n) => SETTLED_NODE.has(n.status));
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .toBe(true);
  return latest;
}

/** The rule run's client report as Markdown, read as the workspace's admin member (see header). */
async function clientReport(projectId: string, ruleRunId: string): Promise<string> {
  let text = '';
  await expect
    .poll(
      async () => {
        const res = await world.admin.get(apiUrl(`/api/v1/projects/${projectId}/rule-runs/${ruleRunId}/client-report?format=md`), {
          headers: { 'X-Workspace-Id': world.workspaceId },
        });
        text = await res.text();
        return res.status();
      },
      { timeout: 60_000, intervals: [2_000, 5_000] },
    )
    .toBe(200);
  return text;
}

/** A one-node ordinary plan (groups B vs A — never the SAP child's computation, so no dedup onto it). */
function ordinaryPlan() {
  return {
    planId: `PL-AXI-2444-ordinary-${Date.now()}`,
    revision: 1,
    question: 'Does score differ between arm B and arm A?',
    sendData: false,
    reasoning: {
      restatedQuestion: 'Compare score between B and A',
      whyThisApproach: 'Two independent groups, no normality assumption',
      whatThisWillNotEstablish: 'Causality',
      alternativesConsidered: [],
    },
    datasetsUsed: [],
    datasetsAvailableNotUsed: [],
    declaredFamily: null,
    nodes: [
      {
        id: 'n1',
        nodeType: 'compare_groups',
        stepLabel: 'Compare B vs A',
        clinicalQuestion: 'Does score differ between B and A?',
        why: 'AXI-2444 FR51 probe',
        dependsOn: [],
        params: {},
        expectedEvidence: { effect_measure: 'difference', report_ci: false },
        visualisation: null,
        proposedClaimCeiling: 'exploratory',
        familyId: null,
        operation: {
          operationId: 'stats.mann_whitney_u',
          roleBindings: { groupColumn: 'arm' },
          pivot: { valueColumns: ['score'] },
          operationParams: { groupFrom: 'B', groupTo: 'A' },
        },
      },
    ],
  };
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  project = await newProject('reports');
  otherProject = await newProject('ordinary');
  t1Version = await pinNewestT1(project);
  dataset = await uploadSeparatedDataset();
  await link(project, dataset);
  ingestion = await readyIngestion(dataset);
  sap = await finaliseSap(project, dataset);
  const started = await editor.api.post(runsPath(project, sap.id), {
    data: { datasetVersionId: ingestion, clientRequestId: requestId('run') },
  });
  expect(started.status(), await started.text()).toBe(201);
  run = await started.json();
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2444 — SAP reports', TAGS, () => {
  test('FR49, AC22, NFR11, AC33 — AXI-2444.1: a completed SAP run has a downloadable report carrying every FR49 element, verifiable from the file alone', async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 60_000);
    // Arrange
    run = await evaluatedRun(run.sapRunId);
    expect(run.status).toBe('completed');

    // Act
    firstDownload = await download(await editor.api.get(reportPath(project, sap.id, run.sapRunId)));

    // Assert — the file
    expect(firstDownload.status, firstDownload.body.slice(0, 500)).toBe(200);
    expect(firstDownload.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(firstDownload.headers['content-disposition']).toBe(`attachment; filename="sap-run-report-${run.sapRunId}.md"`);
    const hash = firstDownload.headers['x-report-hash'];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(recomputeReportHash(firstDownload.body)).toBe(hash);
    expect(firstDownload.body).toContain(`Report SHA-256: sha256:${hash}`);
    // Assert — the FR49 elements
    const report = firstDownload.body;
    for (const expected of [
      `# SAP-run report — AXI-2444 reports plan, version ${sap.version}`,
      `## Statistical Analysis Plan — version ${sap.version}`,
      `- Dataset version: ${ingestion}`,
      '- Classification: planned final look',
      '## Multiplicity procedure',
      '## Q1 — primary, position 1',
      QUESTION_TEXT,
      'Population: All randomised subjects',
      `- Template: T1 version ${t1Version}`,
      '  - groupingColumn → column arm (grouping_two_levels)',
      '- Decision criterion: main p-value at or below alpha 0.05 (two_sided)',
      '- Verdict: Met — the pre-specified criterion was met under the declared procedure',
      `- SAP run: ${run.sapRunId}`,
      RUO,
    ]) {
      expect(report, expected).toContain(expected);
    }
    expect(report).toMatch(/^- Main p-value: (?!not recorded)\S+$/m);
    expect(report).not.toMatch(OVERCLAIM);
  });

  test('AC22, NFR2 — AXI-2444.2: every later download ships the same bytes and the same hash', async () => {
    // Act
    const again = await download(await editor.api.get(reportPath(project, sap.id, run.sapRunId)));
    const byViewer = await download(await viewer.api.get(reportPath(project, sap.id, run.sapRunId)));

    // Assert
    for (const later of [again, byViewer]) {
      expect(later.status).toBe(200);
      expect(later.body).toBe(firstDownload.body);
      expect(later.headers['x-report-hash']).toBe(firstDownload.headers['x-report-hash']);
    }
  });

  test('NFR1, AC30 — AXI-2444.3: without project access, under another project, or for an unknown run, the report is 404', async () => {
    // Act
    const calls = [
      await outsider.api.get(reportPath(project, sap.id, run.sapRunId)),
      await editor.api.get(reportPath(otherProject, sap.id, run.sapRunId)),
      await editor.api.get(reportPath(project, sap.id, '00000000-0000-4000-8000-000000000000')),
    ];

    // Assert
    for (const res of calls) {
      const text = await res.text();
      expect(res.status(), text).toBe(404);
      expect(text).not.toContain('SAP-run report —');
      // the still-running code is only for a VISIBLE run that is running — never a not-found
      expect(text).not.toContain('SAP_RUN_REPORT_NOT_WRITTEN');
    }
  });

  test("FR50, AC23, NFR11, AC33 — AXI-2444.4: a SAP-run child's client report names the SAP run, version, question key, text, role and estimand, and points to the SAP-run report", async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 60_000);
    // Arrange
    const [question] = run.questions;
    const child = await settledGovernedRun(project, question.childRunId);
    expect(child.ruleRunId, JSON.stringify(child.nodes)).toBeTruthy();

    // Act
    const report = await clientReport(project, child.ruleRunId);

    // Assert
    for (const expected of [
      `## Statistical Analysis Plan — SAP run, version ${sap.version}`,
      `This run is part of SAP run ${run.sapRunId}`,
      'Question Q1 (primary), verbatim:',
      QUESTION_TEXT,
      'Population: All randomised subjects',
      'Treatment comparison: Arm A vs arm B',
      `/api/v1/projects/${project}/saps/${sap.id}/runs/${run.sapRunId}/report`,
      `- SAP run: ${run.sapRunId}`,
    ]) {
      expect(report, expected).toContain(expected);
    }
    expect(report).not.toContain(NOT_A_SAP_RUN);
    expect(report).not.toMatch(OVERCLAIM);
  });

  test('FR51, EC26 — AXI-2444.5: a new ordinary run (not part of a SAP run) prints the single exploratory sentence', async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 60_000);
    // Arrange
    await link(otherProject, dataset);
    const res = await editor.api.post(apiUrl('/api/v1/governed-execution/submit'), {
      data: { projectId: otherProject, plan: ordinaryPlan(), datasetId: dataset, workspaceId: world.workspaceId },
    });
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
    const ordinary = await settledGovernedRun(otherProject, body.runId);
    test.skip(
      ordinary.sapBinding !== undefined && ordinary.sapBinding !== null,
      `needs AXI-2443 (binder retirement): this backend still records sapBinding=${ordinary.sapBinding} on an ordinary run`,
    );
    expect(ordinary.ruleRunId, JSON.stringify(ordinary.nodes)).toBeTruthy();

    // Act
    const report = await clientReport(otherProject, ordinary.ruleRunId);

    // Assert
    const section = report.slice(report.indexOf('## Statistical Analysis Plan'));
    expect(section.split('\n## ')[0].trim()).toBe(['## Statistical Analysis Plan', '', NOT_A_SAP_RUN].join('\n'));
    expect(report).not.toMatch(OVERCLAIM);
  });
});
