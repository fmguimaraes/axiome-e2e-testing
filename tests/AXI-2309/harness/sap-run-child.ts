import { expect, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { sleep } from '../../AXI-1400/harness/api';
import type { Actor, PrivateProjectsWorld } from '../../AXI-2265/private-projects-fixtures';

/**
 * AXI-2480 (epic AXI-2455) — provisions a REAL Run SAP child for the report / export e2e specs
 * (AXI-2311, AXI-2313). The per-run SAP binding is gone (AXI-2443) and the free-text SAP writes
 * answer 410 (AXI-2438), so a "SAP-bound" run is now the governed child of a SAP run
 * (`POST /projects/:id/saps/:sapId/runs`, AXI-2441) on a SAP version minted by draft + finalise
 * (AXI-2439). The SAP pins the NEWEST T1 version the project's catalog lists — never a hard-coded one.
 *
 * Lives in a harness (not a `*.spec.ts`) because the spec linter forbids fixed sleeps in specs.
 */

const READY_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 240_000;
const POLL_MS = 2_000;
const SETTLED_NODE = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL']);

export const SAP_QUESTION_TEXT = 'Does arm A change the score compared with arm B?';

export interface SapRunChildWorld {
  world: PrivateProjectsWorld;
  editor: Actor;
}

export interface ProvisionedSap {
  project: string;
  dataset: string;
  ingestion: string;
  sap: any;
  t1Version: string;
}

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);

export async function waitUntil(read: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await sleep(POLL_MS);
  }
  throw new Error(`AXI-2480 harness: ${what} timed out after ${timeoutMs} ms`);
}

export async function newProject(w: SapRunChildWorld, name: string): Promise<string> {
  const res = await w.editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2480 ${name} ${Date.now()}`, workspaceId: w.world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function pinNewestT1(w: SapRunChildWorld, projectId: string): Promise<string> {
  const res = await w.editor.api.get(`${base(projectId)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
}

/**
 * A dataset unique to `token` (every score carries a token-derived offset, so no computation can
 * DEDUP onto another spec's run) with fully separated arms. Subject ids carry the token too:
 * report/export specs assert no data row (NFR7) reaches a document by looking for it.
 */
export async function uploadTokenDataset(w: SapRunChildWorld, token: string, filenamePrefix: string): Promise<{ id: string; subjectPrefix: string }> {
  const offset = [...token].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 9973, 7) / 10_000;
  const subjectPrefix = `s${token.replace(/[^0-9a-z]/gi, '')}_`;
  const datasets = apiUrl(`/api/v1/workspaces/${w.world.workspaceId}/datasets`);
  const init = await w.editor.api.post(datasets, {
    data: { organizationId: w.world.orgId, originalFilename: `${filenamePrefix}-${token}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 16 }, (_, i) => {
    const arm = i % 2 === 0 ? 'A' : 'B';
    const score = arm === 'A' ? 20 + i * 0.7 + offset : 5 + i * 0.3 + offset;
    return `${subjectPrefix}${i + 1},${arm},${score.toFixed(4)}`;
  });
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: `subject_id,arm,score\n${rows.join('\n')}\n`,
  });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await w.editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return { id: created.id, subjectPrefix };
}

export async function linkDataset(w: SapRunChildWorld, projectId: string, datasetId: string): Promise<void> {
  const res = await w.editor.api.post(`${base(projectId)}/datasets`, { data: { datasetId } });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

export async function readyIngestion(w: SapRunChildWorld, datasetId: string): Promise<string> {
  const path = apiUrl(`/api/v1/workspaces/${w.world.workspaceId}/datasets/${datasetId}`);
  let id = '';
  await waitUntil(
    async () => {
      const res = await w.editor.api.get(path);
      const latest = res.ok() ? (await res.json()).latestIngestion : null;
      if (latest?.status === 'failed') throw new Error('AXI-2480 harness: ingestion failed');
      if (latest?.status === 'ready') id = latest.id;
      return latest?.status === 'ready';
    },
    READY_WAIT_MS,
    'dataset ingestion',
  );
  return id;
}

export function primaryQuestion(t1Version: string, text: string) {
  return {
    text,
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
    // NO sensitivity analysis: the question's child is the ONLY producer of its rule run.
    sensitivityAnalyses: [],
  };
}

/** Draft -> one primary T1 question -> wait for a clean completeness report -> finalise (version 1). */
export async function finaliseSap(
  w: SapRunChildWorld,
  projectId: string,
  datasetId: string,
  title: string,
  questionText: string = SAP_QUESTION_TEXT,
): Promise<{ sap: any; t1Version: string }> {
  const t1Version = await pinNewestT1(w, projectId);
  const started = await w.editor.api.post(`${base(projectId)}/saps/draft`);
  expect(started.status(), await started.text()).toBe(201);
  const draft = await started.json();
  expect(draft).toMatchObject({ basedOnVersion: null });
  const titled = await w.editor.api.put(`${base(projectId)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await w.editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: datasetId, question: primaryQuestion(t1Version, questionText) },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await waitUntil(
    async () => {
      const report = await (await w.editor.api.get(`${base(projectId)}/saps/${draft.sapId}/draft/completeness`)).json();
      return report.results.filter((r: any) => r.status === 'fail').length === 0;
    },
    READY_WAIT_MS,
    'draft completeness',
  );
  const finalised = await w.editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/finalise`, {
    data: { basedOnRevision: complete.revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
  return { sap: await finalised.json(), t1Version };
}

/**
 * Opens the amendment draft of a finalised SAP (201, a copy of `basedOnVersion`) and waits for its
 * completeness report to be clean. The caller finalises it with its own reason.
 */
export async function openAmendmentDraft(w: SapRunChildWorld, projectId: string, sapId: string, basedOnVersion: number): Promise<any> {
  const started = await w.editor.api.post(`${base(projectId)}/saps/draft`);
  expect(started.status(), await started.text()).toBe(201);
  const draft = await started.json();
  expect(draft).toMatchObject({ sapId, basedOnVersion });
  await waitUntil(
    async () => {
      const report = await (await w.editor.api.get(`${base(projectId)}/saps/${sapId}/draft/completeness`)).json();
      return report.results.every((r: { status: string }) => r.status !== 'fail');
    },
    READY_WAIT_MS,
    'amendment draft completeness',
  );
  return draft;
}

/** A fresh project holding a finalised one-question T1 SAP on a token dataset. */
export async function provisionSap(
  w: SapRunChildWorld,
  token: string,
  label: string,
  questionText: string = SAP_QUESTION_TEXT,
): Promise<ProvisionedSap & { subjectPrefix: string }> {
  const project = await newProject(w, label);
  const { id: dataset, subjectPrefix } = await uploadTokenDataset(w, token, label);
  await linkDataset(w, project, dataset);
  const ingestion = await readyIngestion(w, dataset);
  const { sap, t1Version } = await finaliseSap(w, project, dataset, `AXI-2480 ${label} plan`, questionText);
  return { project, dataset, ingestion, sap, t1Version, subjectPrefix };
}

export const runsPath = (projectId: string, sapId: string, suffix = '') => `${base(projectId)}/saps/${sapId}/runs${suffix}`;

export async function startSapRun(w: SapRunChildWorld, p: ProvisionedSap, clientRequestId: string): Promise<any> {
  const started = await w.editor.api.post(runsPath(p.project, p.sap.id), {
    data: { datasetVersionId: p.ingestion, clientRequestId },
  });
  expect(started.status(), await started.text()).toBe(201);
  return started.json();
}

/** Polls the SAP run until it leaves `running` (classified + evaluated). */
export async function evaluatedSapRun(w: SapRunChildWorld, p: ProvisionedSap, sapRunId: string): Promise<any> {
  let latest: any = null;
  await waitUntil(
    async () => {
      const res = await w.editor.api.get(runsPath(p.project, p.sap.id, `/${sapRunId}`));
      latest = res.ok() ? await res.json() : null;
      return !!latest && latest.status !== 'running';
    },
    EVALUATION_WAIT_MS,
    'SAP run evaluation',
  );
  return latest;
}

/** A settled governed run's status (names the rule run that produced its result). */
export async function settledChild(w: SapRunChildWorld, projectId: string, runId: string): Promise<any> {
  let latest: any = null;
  await waitUntil(
    async () => {
      const res = await w.editor.api.get(apiUrl(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`));
      latest = res.ok() ? await res.json() : null;
      const nodes: Array<{ status: string }> = latest?.nodes ?? [];
      return nodes.length > 0 && nodes.every((n) => SETTLED_NODE.has(n.status));
    },
    EVALUATION_WAIT_MS,
    'governed child run',
  );
  return latest;
}

/** A provisioned SAP, one started + evaluated SAP run and its first question's settled child. */
export async function runSapChild(w: SapRunChildWorld, p: ProvisionedSap, requestLabel: string) {
  const started = await startSapRun(w, p, `axi2480-${requestLabel}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const sapRun = await evaluatedSapRun(w, p, started.sapRunId);
  const [question] = sapRun.questions;
  const child = await settledChild(w, p.project, question.childRunId);
  return { sapRun, child, ruleRunId: child.ruleRunId as string };
}

/**
 * The rule run's client report (md), read as `reader`. The report is written by the run-completion
 * listener (FR7); the poll only absorbs a transient non-200 read. A download that came first would
 * generate it itself and say so in its `Generated:` line, which the report specs assert on.
 */
export async function clientReportMd(reader: APIRequestContext, workspaceId: string, projectId: string, ruleRunId: string): Promise<string> {
  let text = '';
  await waitUntil(
    async () => {
      const res = await reader.get(apiUrl(`/api/v1/projects/${projectId}/rule-runs/${ruleRunId}/client-report?format=md`), {
        headers: { 'X-Workspace-Id': workspaceId },
      });
      text = await res.text();
      return res.status() === 200;
    },
    60_000,
    'client report',
  );
  return text;
}
