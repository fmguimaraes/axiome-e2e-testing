import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import {
  linkDataset,
  newProject,
  readyIngestion,
  runsPath,
  startSapRun,
  evaluatedSapRun,
  settledChild,
  uploadTokenDataset,
  waitUntil,
  type SapRunChildWorld,
} from '../AXI-2309/harness/sap-run-child';

/**
 * AXI-2466 (epic AXI-2455 — SAP FR21, FR75, FR40, EC19, EC38, EC39, AC38, AC42; @SI-071, @SI-065,
 * @SI-002). A SAP question/sensitivity analysis declares its own `sidedness` (`two_sided` /
 * `greater` / `less`); on a template version that declares an `alternative` choice (T1/T4 `0.4`,
 * from AXI-2461 — T3/T5 pick this up automatically once a version of theirs declares the same
 * choice, read generically off the pinned version's own parameters, never a hard-coded template
 * id), SI-065 forwards it verbatim as the compiled run's `alternative` parameter (FR75, AC38). A
 * question is never allowed to set `alternative` directly in its own `parameters` (EC39, CC5/CC10);
 * a one-sided `sidedness` against a version that does not declare `alternative` (T2) fails the
 * same way (EC38).
 *
 * Fixture: token datasets minted by the AXI-2309/AXI-2480 harness (`uploadTokenDataset`) — token
 * `arm`/`score` columns, fully separated between the two arms.
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2466.
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2466-*`
 * Authored, NOT run against the demo stack — owner override (no e2e runs for epic AXI-2455).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const TAGS = { tag: ['@SI-071', '@SI-065', '@SI-002'] };
const SETUP_TIMEOUT_MS = 8 * 60_000;
const READY_WAIT_MS = 120_000;

let w: SapRunChildWorld;
let editor: Actor;
let project: string;
let dataset: string;
let ingestion: string;
let subjectPrefix: string;
let t1Version: string;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const adminHeaders = () => ({ 'X-Workspace-Id': w.world.workspaceId });

async function pinNewest(projectId: string, templateId: 'T1' | 'T2'): Promise<string> {
  const res = await editor.api.get(`${base(projectId)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === templateId && e.isNewest);
  expect(newest, `the catalog lists a newest ${templateId}`).toBeTruthy();
  return newest.templateVersion;
}

function t1Question(overrides: { parameters: Record<string, unknown> }) {
  return {
    text: 'Does arm A change the score compared with arm B?',
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
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
    ...overrides,
  };
}

/** Draft -> one T1 question (arbitrary parameters) -> read the completeness report (no wait for clean). */
async function draftWithQuestion(question: unknown): Promise<{ sapId: string; revision: number }> {
  const started = await editor.api.post(`${base(project)}/saps/draft`);
  expect(started.status(), await started.text()).toBe(201);
  const draft = await started.json();
  const titled = await editor.api.put(`${base(project)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: `AXI-2466 ${Date.now()}` },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: dataset, question },
  });
  expect(added.status(), await added.text()).toBe(201);
  const body = await added.json();
  return { sapId: draft.sapId, revision: body.revision };
}

async function completenessReport(sapId: string): Promise<any> {
  const res = await editor.api.get(`${base(project)}/saps/${sapId}/draft/completeness`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** Finalises a draft already holding ONE clean T1 question, and starts + evaluates its SAP run. */
async function finaliseAndRun(sapId: string, revision: number): Promise<any> {
  const finalised = await editor.api.post(`${base(project)}/saps/${sapId}/draft/finalise`, {
    data: { basedOnRevision: revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
  const sap = await finalised.json();
  const p = { project, dataset, ingestion, sap, t1Version };
  const started = await startSapRun(w, p, `axi2466-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const sapRun = await evaluatedSapRun(w, p, started.sapRunId);
  expect(sapRun.status, JSON.stringify(sapRun)).toBe('completed');
  const [question] = sapRun.questions;
  const child = await settledChild(w, project, question.childRunId);
  return child.ruleRunId as string;
}

/** The compiled rule run's `operationParams`, read as the workspace admin. */
async function compiledOperationParams(ruleRunId: string): Promise<Record<string, unknown>> {
  let params: Record<string, unknown> = {};
  await waitUntil(
    async () => {
      const res = await w.world.admin.get(apiUrl(`/api/v1/rule-runs/${ruleRunId}`), { headers: adminHeaders() });
      if (!res.ok()) return false;
      const body = await res.json();
      if (body.status !== 'SUCCEEDED' && body.status !== 'DEDUPED') return false;
      params = body.operationParams ?? {};
      return true;
    },
    60_000,
    'compiled rule run read',
  );
  return params;
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  const world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  await world.addMember(editor, 'editor');
  w = { world, editor };
  project = await newProject(w, 'sidedness');
  t1Version = await pinNewest(project, 'T1');
  const uploaded = await uploadTokenDataset(w, 'axi2466', 'axi2466-sidedness');
  dataset = uploaded.id;
  subjectPrefix = uploaded.subjectPrefix;
  await linkDataset(w, project, dataset);
  ingestion = await readyIngestion(w, dataset);
});

test.afterAll(async () => {
  await w.world?.dispose();
});

test.describe('AXI-2466 — sidedness drives the template alternative', TAGS, () => {
  test('AC38 — AXI-2466.1: a one-sided T1 question passes CC5 and compiles `alternative` into the Mann-Whitney node', async () => {
    // Arrange / Act
    const { sapId, revision } = await draftWithQuestion(t1Question({ parameters: { alpha: 0.05, sidedness: 'greater' } }));
    const report = await completenessReport(sapId);
    // Assert — CC5 passes
    expect(report.results.filter((r: any) => r.checkId === 'CC5')).toEqual([expect.objectContaining({ status: 'pass' })]);
    // Act — run it and read the compiled node
    const ruleRunId = await finaliseAndRun(sapId, revision);
    const params = await compiledOperationParams(ruleRunId);
    // Assert
    expect(params.alternative).toBe('greater');
  });

  test('FR75 — AXI-2466.2: a two-sided T1 question still forwards `alternative` explicitly', async () => {
    // Arrange / Act
    const { sapId, revision } = await draftWithQuestion(t1Question({ parameters: { alpha: 0.05, sidedness: 'two_sided' } }));
    const report = await completenessReport(sapId);
    expect(report.results.filter((r: any) => r.checkId === 'CC5')).toEqual([expect.objectContaining({ status: 'pass' })]);
    const ruleRunId = await finaliseAndRun(sapId, revision);
    const params = await compiledOperationParams(ruleRunId);
    // Assert — explicit, not absent (FR75: sidedness is forwarded whenever the version declares `alternative`)
    expect(params.alternative).toBe('two_sided');
  });

  test('FR21 — AXI-2466.3 (EC38): a one-sided T2 question fails CC5; T2 declares no `alternative`', async () => {
    // Arrange
    const t2Version = await pinNewest(project, 'T2');
    const question = {
      text: 'Does the score differ across clusters?',
      role: 'primary',
      estimand: {
        population: 'All randomised subjects',
        variable: 'Score at week 12',
        intercurrentEvents: 'Treatment policy',
        populationSummary: 'Difference in medians',
        treatmentComparison: 'Across clusters',
      },
      template: { templateId: 'T2', templateVersion: t2Version },
      bindings: [
        { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_three_plus_levels' },
        { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
      ],
      parameters: { alpha: 0.05, sidedness: 'greater' },
      decisionCriterion: { kind: 'p_at_or_below_alpha' },
      sensitivityAnalyses: [],
    };
    // Act
    const { sapId } = await draftWithQuestion(question);
    const report = await completenessReport(sapId);
    // Assert
    const cc5 = report.results.filter((r: any) => r.checkId === 'CC5');
    const sidedness = cc5.find((r: any) => r.status === 'fail' && r.field === 'parameters.sidedness');
    expect(sidedness, JSON.stringify(cc5)).toBeTruthy();
    expect(sidedness.message).toContain('Kruskal-Wallis omnibus test has no one-sided form');
  });

  test('FR75 — AXI-2466.4 (EC39): a question that sets `parameters.alternative` directly fails CC5', async () => {
    // Arrange / Act
    const { sapId } = await draftWithQuestion(
      t1Question({ parameters: { alpha: 0.05, sidedness: 'two_sided', alternative: 'greater' } }),
    );
    const report = await completenessReport(sapId);
    // Assert
    const cc5 = report.results.filter((r: any) => r.checkId === 'CC5');
    expect(cc5.some((r: any) => r.status === 'fail' && r.field === 'parameters.alternative')).toBe(true);
  });

  test('FR75 — AXI-2466.5 (EC39): a sensitivity analysis that sets `alternative` directly fails CC10 the same way', async () => {
    // Arrange
    const question = t1Question({ parameters: { alpha: 0.05, sidedness: 'two_sided' } });
    (question as any).sensitivityAnalyses = [
      {
        label: 'Per-protocol',
        template: { templateId: 'T1', templateVersion: t1Version },
        bindings: question.bindings,
        parameters: { alpha: 0.05, sidedness: 'less', alternative: 'less' },
      },
    ];
    // Act
    const { sapId } = await draftWithQuestion(question);
    const report = await completenessReport(sapId);
    // Assert
    const cc10 = report.results.filter((r: any) => r.checkId === 'CC10');
    // CC10 prefixes the field with the sensitivity analysis' own index.
    expect(
      cc10.some((r: any) => r.status === 'fail' && r.field === 'sensitivityAnalyses[0].parameters.alternative'),
    ).toBe(true);
  });
});
