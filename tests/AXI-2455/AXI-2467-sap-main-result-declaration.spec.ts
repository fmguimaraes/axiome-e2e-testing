import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { linkDataset, newProject, readyIngestion, runsPath, type SapRunChildWorld } from '../AXI-2309/harness/sap-run-child';

/**
 * AXI-2467 (epic AXI-2455 — SAP FR72, FR73, FR74, FR25, FR33, FR35, EC35, EC36, EC37, EC40, AC39,
 * AC40, AC41; @SI-071, @SI-065, @SI-002). The SAP reads a question's main result off the pinned
 * template version's OWN declaration (TPL FR58) — the frozen FR33 table serves only T1–T5
 * `0.2`/`0.3`. T3/T5 `0.4` declare the whole-matrix global test (`global_p`, no signed effect,
 * not one cell): CC9 admits several cells on `0.4` (EC35) and, on a one-cell pin, names the
 * whole-matrix version (EC36, AC40); CC6 refuses a direction on it (EC37).
 *
 * Run path (FR73): executing the composition's `globalTest` step is NOT built by AXI-2467 — the
 * governed executor cannot feed an upstream result table into a node (see the story report). Until
 * it is, pre-flight refuses a T3/T5 `0.4` SAP run `template_main_result_not_run` (AXI-2467.4), and
 * the AC39 end-to-end number check (AXI-2467.5) is `test.fixme`.
 *
 * Fixture: a token dataset (`subject_id, arm, score, crp, il6`) unique to this spec.
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2467.
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2467-*`
 * Authored, NOT run against the demo stack — owner override (no e2e runs for epic AXI-2455).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const TAGS = { tag: ['@SI-071', '@SI-065', '@SI-002'] };
const SETUP_TIMEOUT_MS = 8 * 60_000;

let w: SapRunChildWorld;
let editor: Actor;
let project: string;
let dataset: string;
let ingestion: string;
let wholeMatrixVersion: string;
let oneCellVersion: string;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);

/** A dataset unique to this spec, with three continuous measures for a multi-cell T3 matrix. */
async function uploadMatrixDataset(token: string): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${w.world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: w.world.orgId, originalFilename: `axi2467-${token}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 20 }, (_, i) => {
    const score = 10 + i * 0.9;
    return `s${token}_${i + 1},${i % 2 === 0 ? 'A' : 'B'},${score.toFixed(3)},${(score * 0.5 + (i % 3)).toFixed(3)},${(30 - i * 0.4).toFixed(3)}`;
  });
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: `subject_id,arm,score,crp,il6\n${rows.join('\n')}\n`,
  });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

/** The newest T3 version (declares the whole-matrix main result) and the one-cell pin that names it. */
async function t3Versions(): Promise<{ whole: string; oneCell: string }> {
  const res = await editor.api.get(`${base(project)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const t3 = (await res.json()).filter((e: any) => e.templateId === 'T3');
  const whole = t3.find((e: any) => e.isNewest);
  expect(whole?.mainResult, JSON.stringify(t3)).toMatchObject({ pValueField: 'global_p', cellBound: false, source: 'declared' });
  const oneCell = t3.find((e: any) => e.wholeMatrixMainResultVersion === whole.templateVersion);
  expect(oneCell, 'a one-cell T3 pin names the whole-matrix version').toBeTruthy();
  return { whole: whole.templateVersion, oneCell: oneCell.templateVersion };
}

function t3Question(templateVersion: string, decisionCriterion: Record<string, unknown> = { kind: 'p_at_or_below_alpha' }) {
  return {
    text: 'Is the score associated with any of the inflammation markers?',
    role: 'primary',
    estimand: {
      population: 'All enrolled subjects',
      variable: 'Score and inflammation markers',
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Spearman association',
      treatmentComparison: 'Score vs markers',
    },
    template: { templateId: 'T3', templateVersion },
    bindings: [
      { slot: 'x', column: 'score', semanticRole: 'continuous' },
      { slot: 'y', column: 'crp', semanticRole: 'continuous' },
      { slot: 'y', column: 'il6', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion,
    sensitivityAnalyses: [],
  };
}

async function draftWithQuestion(question: unknown): Promise<{ sapId: string; revision: number }> {
  const started = await editor.api.post(`${base(project)}/saps/draft`);
  expect(started.status(), await started.text()).toBe(201);
  const draft = await started.json();
  const titled = await editor.api.put(`${base(project)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: `AXI-2467 ${Date.now()}` },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: dataset, question },
  });
  expect(added.status(), await added.text()).toBe(201);
  return { sapId: draft.sapId, revision: (await added.json()).revision };
}

async function checkRows(sapId: string, checkId: string): Promise<any[]> {
  const res = await editor.api.get(`${base(project)}/saps/${sapId}/draft/completeness`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).results.filter((r: any) => r.checkId === checkId);
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  const world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  await world.addMember(editor, 'editor');
  w = { world, editor };
  project = await newProject(w, 'main-result-declaration');
  ({ whole: wholeMatrixVersion, oneCell: oneCellVersion } = await t3Versions());
  dataset = await uploadMatrixDataset(`${Date.now()}`);
  await linkDataset(w, project, dataset);
  ingestion = await readyIngestion(w, dataset);
});

test.afterAll(async () => {
  await w.world?.dispose();
});

test.describe('AXI-2467 — SAP main result from the template declaration', TAGS, () => {
  test('FR25 — AXI-2467.1 (EC35): a confirmatory multi-cell T3 question on the whole-matrix version passes CC9', async () => {
    const { sapId } = await draftWithQuestion(t3Question(wholeMatrixVersion));
    expect(await checkRows(sapId, 'CC9')).toEqual([expect.objectContaining({ status: 'pass' })]);
  });

  test('AC40 — AXI-2467.2 (EC36, FR74): the same question on the one-cell pin fails CC9 and names the whole-matrix version', async () => {
    const { sapId } = await draftWithQuestion(t3Question(oneCellVersion));
    const failures = (await checkRows(sapId, 'CC9')).filter((r: any) => r.status === 'fail');
    expect(failures.map((f: any) => f.field)).toEqual(['bindings.y']);
    expect(failures[0].message).toContain(`T3@${wholeMatrixVersion} declares a whole-matrix main result`);
  });

  test('FR73 — AXI-2467.3 (EC37): a direction on the whole-matrix main result fails CC6', async () => {
    const { sapId } = await draftWithQuestion(t3Question(wholeMatrixVersion, { kind: 'p_at_or_below_alpha', direction: 'positive' }));
    const cc6 = (await checkRows(sapId, 'CC6')).filter((r: any) => r.status === 'fail');
    expect(cc6.some((r: any) => r.message.includes('declares no signed effect for its main result'))).toBe(true);
  });

  test('FR73 — AXI-2467.4 (FR35): until the global-test step runs, a whole-matrix SAP run is refused before any child starts', async () => {
    const { sapId, revision } = await draftWithQuestion(t3Question(wholeMatrixVersion));
    const finalised = await editor.api.post(`${base(project)}/saps/${sapId}/draft/finalise`, {
      data: { basedOnRevision: revision, basedOnVersion: null },
    });
    expect(finalised.status(), await finalised.text()).toBe(201);
    const sap = await finalised.json();
    const started = await editor.api.post(runsPath(project, sap.id), {
      data: { datasetVersionId: ingestion, clientRequestId: `axi2467-${Date.now()}` },
    });
    expect(started.status(), await started.text()).toBe(422);
    const body = await started.json();
    expect(body.code).toBe('SAP_RUN_PREFLIGHT_FAILED');
    expect(body.errors).toEqual([expect.objectContaining({ reason: 'template_main_result_not_run' })]);
    expect(body.errors[0].message).toContain('stats.matrix_global_test');
  });

  // AC39 needs the run path that executes the composition's `globalTest` step (follow-up story):
  // today pre-flight refuses the run (AXI-2467.4). When that lands, delete AXI-2467.4 and un-fixme.
  test.fixme('AC39 — AXI-2467.5 (FR73, EC40): the question\'s main p-value is the global test\'s global_p, judged at its alpha', async () => {
    // Arrange: AC39's four-cell matrix (raw cell p 0.004 / 0.03 / 0.2 / 0.5 → m = 4, global_p 0.016).
    // Act: finalise + start the SAP run, poll it to `completed`.
    // Assert: questions[0].mainPValue === 0.016, effectSign null, verdict `met`; the child's
    //         `stats.matrix_global_test` result carries `significant_cells` as supporting detail.
  });
});
