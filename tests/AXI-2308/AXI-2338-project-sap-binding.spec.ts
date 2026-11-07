import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  neverCreatedProjectId,
  refusalOf,
} from '../AXI-2265/private-projects-fixtures';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import { ingestFixture } from '../AXI-2309/harness/chart-style';
import { provisionSap, runSapChild, waitUntil } from '../AXI-2309/harness/sap-run-child';
import { actorApi, settledGovernedRun } from './harness/actor-api';
import type { Api } from '../AXI-1400/harness/api';

/**
 * AXI-2338 (epic AXI-2308 Platform Opening: Human Guided) — originally: a project holds ONE
 * SAP and a governed run binds its CURRENT version. Since AXI-2443 the per-run binding is gone: a run
 * binds nothing (the SAP is optional, owner ruling 2026-10-30) and a SAP is only ever applied by a
 * RUN SAP (AXI-2441); the DERIVED `sapAnalysis` flag and the SAP-write permission (FR16, FR17,
 * AC12, EC5) remain; every planned run records its entry mode, validated against the
 * AXI-2339 opening-template registry (FR19, AC13); Headless §10 delta / §17 D8
 * (typed second-create refusal, `sap:write` SAP write). API-level by design: the
 * screens that paste the SAP and pick a mode are AXI-2328/AXI-2341.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md
 * § "AXI-2338" (AXI-2338.1 .. AXI-2338.9).
 *
 * Requires organization-service with `SAP_RUN_BINDING` unset,
 * `GOVERNED_EXECUTION_RECONCILER=on` and bio-compute reachable, on a gateway
 * serving the AXI-2338 branch (three branch migrations applied). No LLM call:
 * §.4 pins the workspace planner arm to `fallback` (deterministic); §.9 compiles
 * through the LLM-free opening-template compiler.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

// AXI-2480 (epic AXI-2455) — the free-text-era scenarios of this spec were RETIRED or REWRITTEN; none was
// dropped silently. The per-run SAP binding (AXI-2443) and the free-text SAP writes (AXI-2438) are gone:
//   .1 RETIRED  -> AXI-2438.1/.2/.6 (draft start, one open draft, 410 on the free-text create) and
//                  AXI-2439.4/.6 (a finalised SAP, amended into version 2);
//   .2 kept     (adapted to the null read by AXI-2443);
//   .3 REWRITTEN on a Run SAP (a SAP run pins the CURRENT final version; after an amendment the next SAP run
//                  pins version 2 while run 1 stays on version 1);
//   .4 kept;
//   .5 REWRITTEN on the SAP DRAFT API (the Investigator's sap:write on his own project only);
//   .6 REWRITTEN without a SAP (the Guided mode record is independent of any SAP);
//   .7 kept;
//   .8 RETIRED  -> AXI-2443.3 (an ordinary run, with no choice or with "skip", records no binding: null/null/null);
//   .9 REWRITTEN without a SAP choice (the wizard call, compiled plan + mode, still records the template).
// Manual-E2E doc: axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md § "AXI-2338".

const MWU = 'stats.mann_whitney_u';
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let api: Api;

const saps = (projectId: string, suffix = '') => apiUrl(`/api/v1/projects/${projectId}/saps${suffix}`);

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2338 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** Links the shared CSV fixture (uploaded once into the fresh workspace) to `projectId`. */
async function linkFixture(projectId: string): Promise<string> {
  return ingestFixture(api, {
    orgId: world.orgId,
    workspaceId: world.workspaceId,
    projectId,
    headers: { 'X-Workspace-Id': world.workspaceId },
  });
}

/**
 * A one-node inline plan: Mann–Whitney U of `valueColumn` between two groups.
 * Scenarios that must read their OWN rule run use a distinct column or group
 * order: the kernel dedups an identical computation across analyses, and the
 * governed status then names the canonical run.
 */
function mannWhitneyPlan(label: string, valueColumn = 'value', groups: [string, string] = ['A', 'B']) {
  return {
    planId: `PL-AXI-2338-${label}-${Date.now()}`,
    revision: 1,
    question: 'Does value differ between group A and group B?',
    sendData: false,
    reasoning: {
      restatedQuestion: 'Compare value between A and B',
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
        stepLabel: 'Compare A vs B',
        clinicalQuestion: 'Does value differ between A and B?',
        why: 'AXI-2338 SAP binding probe',
        dependsOn: [],
        params: {},
        expectedEvidence: { effect_measure: 'difference', report_ci: false },
        visualisation: null,
        proposedClaimCeiling: 'exploratory',
        familyId: null,
        operation: {
          operationId: MWU,
          roleBindings: { groupColumn: 'group' },
          pivot: { valueColumns: [valueColumn] },
          operationParams: { groupFrom: groups[0], groupTo: groups[1] },
        },
      },
    ],
  };
}

function submit(projectId: string, datasetId: string, plan: unknown, extra: Record<string, unknown> = {}) {
  return editor.api.post(apiUrl('/api/v1/governed-execution/submit'), {
    data: { projectId, plan, datasetId, workspaceId: world.workspaceId, ...extra },
  });
}

/** The run's client report as Markdown (AXI-2311 route), read as the workspace's admin member. */
async function clientReportMarkdown(projectId: string, ruleRunId: string): Promise<string> {
  const res = await world.admin.get(apiUrl(`/api/v1/projects/${projectId}/rule-runs/${ruleRunId}/client-report?format=md`), {
    headers: { 'X-Workspace-Id': world.workspaceId },
  });
  const text = await res.text();
  expect(res.status(), text.slice(0, 500)).toBe(200);
  return text;
}

/** The Guided wizard's template id the run-start declares — an AXI-2339 registry key (`OPENING_TEMPLATE_IDS`). */
const TEMPLATE_ID = 'T1';

// §.4 → §.7: the project and the stored (automatic) plan §.7 contradicts.
let modeProject: string;
let modeDatasetId: string;
let automaticPlanId: string;

/** One analysis as the list AND the detail read serve it — both carry the derived SAP fields. */
async function analysisSapOf(projectId: string, viewAnalysisId: string): Promise<{ list: any; detail: any }> {
  const listed = await editor.api.get(apiUrl(`/api/v1/view-analyses?projectId=${projectId}&limit=100`));
  expect(listed.status(), await listed.text()).toBe(200);
  const body = await listed.json();
  const rows: any[] = body?.data ?? body;
  const detail = await editor.api.get(apiUrl(`/api/v1/view-analyses/${viewAnalysisId}`));
  expect(detail.status(), await detail.text()).toBe(200);
  return { list: rows.find((r) => r.id === viewAnalysisId), detail: await detail.json() };
}

async function analysesOf(projectId: string): Promise<number> {
  const res = await editor.api.get(apiUrl(`/api/v1/view-analyses?projectId=${projectId}&limit=100`));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return body?.meta?.total ?? (body?.data ?? body).length;
}

/**
 * Read as the workspace's admin member: the run's `op:` carrier is a SYSTEM
 * rule, and a self-registered actor's fresh organization is not entitled to
 * it, so that actor's own reads hide the row (AXI-1290 run-hiding — orthogonal
 * to the SAP binding).
 */
async function ruleRunOf(ruleRunId: string): Promise<any> {
  const res = await world.admin.get(apiUrl(`/api/v1/rule-runs/${ruleRunId}`), {
    headers: { 'X-Workspace-Id': world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** Every rule run of the spec's fresh workspace (read as its admin member). */
async function ruleRunsOfWorkspace(): Promise<Array<{ id: string; status: string; sapVersionId: string | null; dedupedFromRunId: string | null }>> {
  const res = await world.admin.get(apiUrl(`/api/v1/rule-runs?workspaceId=${world.workspaceId}&limit=100`), {
    headers: { 'X-Workspace-Id': world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).ruleRuns;
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  // §.4: the deterministic planner arm — no LLM call, no spend.
  const arm = await world.admin.put(apiUrl(`/api/v1/workspaces/${world.workspaceId}/planner-arm-setting`), {
    data: { plannerArm: 'fallback' },
    headers: { 'X-Workspace-Id': world.workspaceId },
  });
  expect(arm.status(), await arm.text()).toBe(200);
  // The admin stays a member (unlike AXI-2310's world): it is the reader of the
  // runs' rule-run rows below, and no scenario here asserts on admin-less access.
  api = actorApi(editor);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2338 — project-bound SAP & run binding + mode record', { tag: ['@SI-065', '@SI-047', '@SI-045', '@SI-010', '@SI-002', '@SI-017'] }, () => {
  test('AC12, EC5 — AXI-2338.2: a governed run on a project with NO SAP proceeds unbound and records no binding — reads sapBinding null since AXI-2443 (the SAP is optional) @SI-047 @SI-065', async () => {
    // Arrange
    const project = await newProject('no-sap');
    const datasetId = await linkFixture(project);

    // Act
    // B vs A: distinct from §.3's A vs B, so §.3's v1 run is never deduped onto this unbound one.
    const res = await submit(project, datasetId, mannWhitneyPlan('nosap', 'value', ['B', 'A']));
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
    const run = await settledGovernedRun(api, project, body.runId);
    const analysis = await analysisSapOf(project, body.viewAnalysisId);

    // Assert — never a 422 SAP_VERSION_REQUIRED on this path; the run executed
    expect(body.errorCode).toBeUndefined();
    const statuses = (run.nodes as Array<{ status: string }>).map((n) => n.status);
    expect(statuses, JSON.stringify(run.nodes)).not.toContain('FAILED');
    expect(statuses).not.toContain('BLOCKED');
    // AXI-2443 (FR52): was `sapBinding: 'none'` — a new run records no binding and reads null.
    expect(run).toMatchObject({ sapBinding: null, sapVersionId: null, sapAnalysis: false });
    expect(analysis.list, 'the run\'s analysis is listed').toBeTruthy();
    expect(analysis.list).toMatchObject({ sapAnalysis: false, sapBinding: null, sapVersionId: null });
    expect(analysis.detail).toMatchObject({ sapAnalysis: false, sapBinding: null, sapVersionId: null });
  });

  test('AC12, FR55 — AXI-2338.3: a SAP run pins the project\'s CURRENT final SAP version; after an amendment the next SAP run pins version 2 and run 1 stays on version 1 @SI-047 @SI-017 @SI-065', async () => {
    test.setTimeout(10 * 60_000);
    // Arrange — a project with its finalised SAP (version 1) and a first SAP run on it
    const w = { world, editor };
    const sap = await provisionSap(w, `2338-3-${Date.now()}`, 'current-version');
    const first = await runSapChild(w, sap, 'v1');
    const v1SapVersionId = sap.sap.sapVersionId;
    expect(first.sapRun.sapVersionId).toBe(v1SapVersionId);

    // Act — amend the SAP (draft copied from version 1, finalised with its reason), then run it again
    const base = apiUrl(`/api/v1/projects/${sap.project}/saps`);
    const draft = await (await editor.api.post(`${base}/draft`)).json();
    expect(draft).toMatchObject({ sapId: sap.sap.id, basedOnVersion: 1 });
    await waitUntil(
      async () => {
        const report = await (await editor.api.get(`${base}/${draft.sapId}/draft/completeness`)).json();
        return report.results.every((r: { status: string }) => r.status !== 'fail');
      },
      120_000,
      'amendment draft completeness',
    );
    const amended = await editor.api.post(`${base}/${draft.sapId}/draft/finalise`, {
      data: { basedOnRevision: draft.revision, basedOnVersion: 1, amendmentReason: 'AXI-2338.3 amendment' },
    });
    expect(amended.status(), await amended.text()).toBe(201);
    const v2 = await amended.json();
    const second = await runSapChild(w, sap, 'v2');

    // Assert — run 2 pins version 2, never version 1; run 1 is unchanged
    expect(v2).toMatchObject({ id: sap.sap.id, version: 2, status: 'final' });
    expect(v2.sapVersionId).not.toBe(v1SapVersionId);
    expect(second.sapRun.sapVersionId).toBe(v2.sapVersionId);
    expect(second.sapRun.sapRunId).not.toBe(first.sapRun.sapRunId);
    const run1Detail = await (await editor.api.get(`${base}/${sap.sap.id}/runs/${first.sapRun.sapRunId}`)).json();
    expect(run1Detail.sapVersionId).toBe(v1SapVersionId);
    // each child's own reads name the version of its own SAP run
    expect(first.child).toMatchObject({ sapVersionId: v1SapVersionId, sapRun: { sapRunId: first.sapRun.sapRunId } });
    expect(second.child).toMatchObject({ sapVersionId: v2.sapVersionId, sapRun: { sapRunId: second.sapRun.sapRunId } });
  });

  test('AC13 — AXI-2338.4: a planned run records mode "automatic" on the plan and on the plans listing @SI-045 @SI-047', async () => {
    // Arrange
    const project = await newProject('mode');
    const datasetId = await linkFixture(project);
    const anchored = await anchorDataset(api, world.workspaceId, project, { datasetId });
    expect(anchored).not.toBeNull();

    // Act
    const planned = await editor.api.post(apiUrl('/api/v1/guided-analysis/plan'), {
      data: {
        projectId: project,
        envelope: {
          projectId: project,
          question: 'Does value differ between group A and group B?',
          sendData: false,
          context: { scientificContext: 'AXI-2338 mode record E2E' },
          datasets: [anchored],
        },
      },
    });
    const body = await planned.json();
    const listed = await editor.api.get(apiUrl(`/api/v1/guided-analysis/plans?projectId=${project}`));
    const plans = await listed.json();

    // Assert
    expect(planned.status(), JSON.stringify(body).slice(0, 500)).toBeLessThan(300);
    expect(body.mode).toBe('automatic');
    expect(body.planner).not.toBe('anthropic');
    expect(listed.status()).toBe(200);
    const list: Array<{ planId: string; mode: string | null }> = Array.isArray(plans) ? plans : plans?.data ?? plans?.plans ?? [];
    const row = list.find((p) => p.planId === body.plan.planId);
    expect(row, JSON.stringify(plans).slice(0, 500)).toBeTruthy();
    expect(row!.mode).toBe('automatic');
    modeProject = project;
    modeDatasetId = datasetId;
    automaticPlanId = body.plan.planId;
  });

  test('AC12 — AXI-2338.5: an Investigator (sap:write) opens a SAP draft on his own project only; a plain viewer (no sap:write) cannot @SI-010 @SI-065', async () => {
    // Arrange — the Investigator role is AXI-2322's seed; AXI-2338 grants it `sap:write`
    // (owner ruling 2026-10-30: seed row …0105 + step 14 backfill). A stack without the
    // grant is a FAILED precondition, never a skip. Since AXI-2438 the SAP is written through
    // the DRAFT (a free-text create answers 410), so the write probe is the draft start.
    const role = await world.admin.get(apiUrl(`/api/v1/roles/${INVESTIGATOR_ROLE_ID}`));
    expect(role.status(), await role.text()).toBe(200);
    const permissions: string[] = (await role.json())?.permissions ?? [];
    expect(permissions, 'the seeded Investigator role holds sap:write').toContain('sap:write');
    const investigator = await world.actor('investigator');
    await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
    const own = await newProject('investigator-own');
    expect((await access.visibility(editor, own, 'private')).status()).toBe(200);
    expect((await access.grant(editor, own, investigator.userId, 'editor')).status()).toBeLessThan(300);
    const foreign = await newProject('investigator-foreign');
    expect((await access.visibility(editor, foreign, 'private')).status()).toBe(200);
    const viewerProject = await newProject('viewer');

    // Act
    const started = await investigator.api.post(saps(own, '/draft'));
    const startedBody = await started.json();
    const titled = await investigator.api.put(saps(own, `/${startedBody.sapId}/draft`), {
      data: { basedOnRevision: startedBody.revision, title: 'Investigator plan' },
    });
    const onForeign = await refusalOf(await investigator.api.post(saps(foreign, '/draft')));
    const onGhost = await refusalOf(await investigator.api.post(saps(neverCreatedProjectId(), '/draft')));
    const byViewer = await viewer.api.post(saps(viewerProject, '/draft'));

    // Assert
    expect(started.status(), JSON.stringify(startedBody)).toBe(201);
    expect(titled.status(), await titled.text()).toBe(200);
    expect(onForeign.status).toBe(404);
    expect(onForeign).toEqual(onGhost);
    expect(byViewer.status()).toBe(403);
  });

  test('AC13 — AXI-2338.6: a Guided run-start records { mode: guided, templateId } — on the run status, the rule-run evidence read and the client report @SI-047 @SI-010 @SI-002 @SI-017', async () => {
    // Arrange — a project (the mode record is independent of any SAP since AXI-2443); `value2` keeps this
    // computation distinct from every other scenario's (no kernel dedup onto another analysis' run).
    const project = await newProject('guided-mode');
    const datasetId = await linkFixture(project);

    // Act
    const res = await submit(project, datasetId, mannWhitneyPlan('guided', 'value2'), { mode: 'guided', templateId: TEMPLATE_ID });
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
    const run = await settledGovernedRun(api, project, body.runId);
    const ruleRun = await ruleRunOf(run.ruleRunId);
    const report = await clientReportMarkdown(project, run.ruleRunId);

    // Assert
    expect(run).toMatchObject({ mode: 'guided', templateId: TEMPLATE_ID, sapBinding: null, sapVersionId: null, sapAnalysis: false });
    expect(ruleRun).toMatchObject({ mode: 'guided', templateId: TEMPLATE_ID, sapVersionId: null });
    expect(report).toContain(`- Mode: guided (template ${TEMPLATE_ID})`);
    expect(report).not.toContain('- Mode: not recorded');
  });

  test('AC13 — AXI-2338.7: an ill-formed mode record or a template outside the registry is 400 RUN_MODE_INVALID, one contradicting the stored plan is 400 RUN_MODE_MISMATCH, an unknown SAP choice is 400 RUN_SAP_CHOICE_INVALID; nothing is created @SI-047 @SI-045 @SI-010', async () => {
    // Arrange — §.4's project and its stored plan (recorded `automatic`).
    expect(automaticPlanId, 'needs §.4 (serial)').toBeTruthy();
    const plan = mannWhitneyPlan('mode-refusals');
    const before = await analysesOf(modeProject);

    // Act
    const illFormed = await Promise.all(
      [
        { mode: 'guided' },
        { mode: 'automatic', templateId: TEMPLATE_ID },
        { templateId: TEMPLATE_ID },
        { mode: 'manual' },
        { mode: 'guided', templateId: 'T9' },
        { mode: 'guided', templateId: 'two-group-comparison' },
      ].map(
        async (extra) => {
          const r = await submit(modeProject, modeDatasetId, plan, extra);
          return { status: r.status(), body: await r.json() };
        },
      ),
    );
    const contradicting = await submit(modeProject, modeDatasetId, plan, {
      planId: automaticPlanId,
      mode: 'guided',
      templateId: TEMPLATE_ID,
    });
    const contradictingBody = await contradicting.json();
    const badChoice = await submit(modeProject, modeDatasetId, plan, { sap: 'maybe' });
    const badChoiceBody = await badChoice.json();

    // Assert
    for (const r of illFormed) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.errorCode).toBe('RUN_MODE_INVALID');
      expect(r.body).not.toHaveProperty('runId');
    }
    expect(contradicting.status(), JSON.stringify(contradictingBody)).toBe(400);
    expect(contradictingBody.errorCode).toBe('RUN_MODE_MISMATCH');
    expect(badChoice.status(), JSON.stringify(badChoiceBody)).toBe(400);
    expect(badChoiceBody.errorCode).toBe('RUN_SAP_CHOICE_INVALID');
    expect(await analysesOf(modeProject)).toBe(before);
  });

  test('AC13 — AXI-2338.9: the wizard call — the plan compiled by POST /opening-templates/compile, submitted with { mode: guided, templateId } — runs and records the template; a templateId the compiled plan does not carry is 400 RUN_MODE_MISMATCH @SI-045 @SI-047 @SI-010', async () => {
    // Arrange — a project and the fixture's schema for the compiler (no SAP: the choice `sap: 'bind'` is retired, AXI-2443)
    const project = await newProject('compiled');
    const datasetId = await linkFixture(project);
    const anchored = await anchorDataset(api, world.workspaceId, project, { datasetId });
    expect(anchored).not.toBeNull();
    const compiled = await editor.api.post(apiUrl('/api/v1/guided-analysis/opening-templates/compile'), {
      data: {
        projectId: project,
        templateId: 'T1',
        dataset: anchored,
        parameters: { datasetId, outcome: 'value3', groupingColumn: 'group', groups: ['A', 'B'] },
      },
    });
    const compiledBody = await compiled.json();
    expect(compiled.status(), JSON.stringify(compiledBody).slice(0, 500)).toBeLessThan(300);
    expect(compiledBody.ok, JSON.stringify(compiledBody).slice(0, 500)).toBe(true);
    const plan = compiledBody.plan;
    expect(plan.templateRef.templateId).toBe('OPENING-T1');
    const before = await analysesOf(project);

    // Act
    const mismatched = await submit(project, datasetId, plan, { planId: plan.planId, mode: 'guided', templateId: 'T2' });
    const mismatchedBody = await mismatched.json();
    const afterRefusal = await analysesOf(project);
    const res = await submit(project, datasetId, plan, { planId: plan.planId, mode: 'guided', templateId: 'T1' });
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
    const run = await settledGovernedRun(api, project, body.runId);

    // Assert
    expect(mismatched.status(), JSON.stringify(mismatchedBody)).toBe(400);
    expect(mismatchedBody.errorCode).toBe('RUN_MODE_MISMATCH');
    expect(afterRefusal).toBe(before);
    expect(body).toMatchObject({ runId: expect.any(String), viewAnalysisId: expect.any(String) });
    expect(run).toMatchObject({ mode: 'guided', templateId: 'T1', sapBinding: null, sapVersionId: null, sapAnalysis: false });
  });
});
