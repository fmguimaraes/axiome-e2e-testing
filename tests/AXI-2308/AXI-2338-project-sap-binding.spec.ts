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
import { actorApi, settledGovernedRun } from './harness/actor-api';
import type { Api } from '../AXI-1400/harness/api';

/**
 * AXI-2338 (epic AXI-2308 Platform Opening: Human Guided) — a project holds ONE
 * SAP; a governed run binds the project's CURRENT SAP version unless the run-start
 * says `sap: 'skip'`, and a project with NO SAP runs unbound (owner ruling
 * 2026-10-30: the SAP is optional). Every governed run records bound | skipped |
 * none, and every analysis carries the DERIVED `sapAnalysis` flag (FR16, FR17,
 * AC12, EC5); every planned run records its entry mode, validated against the
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

const MWU = 'stats.mann_whitney_u';
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let api: Api;

function content(overrides: Record<string, unknown> = {}) {
  return {
    title: `E2E AXI-2338 SAP ${Date.now()}`,
    questionText: 'Does arm A differ from arm B?',
    planText: 'Primary: Mann–Whitney U on value, group A vs B, α = 0.05, two-sided.',
    linkedMethods: [],
    ...overrides,
  };
}

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
  test('AC12 — AXI-2338.1: a project holds exactly one SAP; a second create is 409 SAP_ALREADY_EXISTS; re-plan is a version @SI-065 @SI-010 @SI-002', async () => {
    // Arrange
    const project = await newProject('one-sap');

    // Act
    const first = await editor.api.post(saps(project), { data: content() });
    const firstBody = await first.json();
    const second = await editor.api.post(saps(project), {
      data: content({ planText: 'A different plan.', linkedMethods: [{ operationId: MWU }] }),
    });
    const listed = await (await editor.api.get(saps(project, '?page=1&limit=100'))).json();
    const replan = await editor.api.post(saps(project, `/${firstBody.id}/versions`), {
      data: { ...content({ planText: 'Amended: Holm correction.' }), basedOnVersion: 1 },
    });
    const listedAfter = await (await editor.api.get(saps(project, '?page=1&limit=100'))).json();

    // Assert
    expect(first.status(), JSON.stringify(firstBody)).toBe(201);
    expect(firstBody).toMatchObject({ projectId: project, version: 1, linkedMethods: [] });
    expect(second.status()).toBe(409);
    const refused = await second.json();
    expect(refused.errorCode).toBe('SAP_ALREADY_EXISTS');
    expect(refused).not.toHaveProperty('sapVersionId');
    expect(listed.meta.total).toBe(1);
    expect(listed.data.map((s: { id: string }) => s.id)).toEqual([firstBody.id]);
    expect(replan.status()).toBe(201);
    expect(await replan.json()).toMatchObject({ id: firstBody.id, version: 2 });
    expect(listedAfter.meta.total).toBe(1);
    expect(listedAfter.data[0]).toMatchObject({ id: firstBody.id, version: 2 });
  });

  test('AC12, EC5 — AXI-2338.2: a governed run on a project with NO SAP proceeds unbound and records sapBinding "none" (the SAP is optional) @SI-047 @SI-065', async () => {
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
    expect(run).toMatchObject({ sapBinding: 'none', sapVersionId: null, sapAnalysis: false });
    expect(analysis.list, 'the run\'s analysis is listed').toBeTruthy();
    expect(analysis.list).toMatchObject({ sapAnalysis: false, sapBinding: 'none', sapVersionId: null });
    expect(analysis.detail).toMatchObject({ sapAnalysis: false, sapBinding: 'none', sapVersionId: null });
  });

  test('AC12 — AXI-2338.3: a governed run binds the project\'s CURRENT SAP version; after re-plan the run binds v2, never reusing the v1 step @SI-047 @SI-017 @SI-065', async () => {
    // Arrange
    const project = await newProject('governed');
    const datasetId = await linkFixture(project);
    const createdRes = await editor.api.post(saps(project), { data: content({ linkedMethods: [{ operationId: MWU }] }) });
    expect(createdRes.status(), await createdRes.text()).toBe(201);
    const v1 = await createdRes.json();
    // The workspace is shared by every scenario (serial): §.3's runs are the
    // rows that appear AFTER this point, never the workspace's whole list.
    const priorRunIds = new Set((await ruleRunsOfWorkspace()).map((r) => r.id));

    // Act — run 1, bound to v1
    const first = await submit(project, datasetId, mannWhitneyPlan('v1'));
    const firstBody = await first.json();
    expect(first.status(), JSON.stringify(firstBody)).toBeLessThan(300);
    const run1 = await settledGovernedRun(api, project, firstBody.runId);

    // Act — re-plan to v2, run 2 with the same plan
    const replan = await editor.api.post(saps(project, `/${v1.id}/versions`), {
      data: { ...content({ planText: 'Amended: one-sided.', linkedMethods: [{ operationId: MWU }] }), basedOnVersion: 1 },
    });
    expect(replan.status(), await replan.text()).toBe(201);
    const v2 = await replan.json();
    const second = await submit(project, datasetId, mannWhitneyPlan('v2'));
    const secondBody = await second.json();
    expect(second.status(), JSON.stringify(secondBody)).toBeLessThan(300);
    const run2 = await settledGovernedRun(api, project, secondBody.runId);

    // Assert — run 1 carries v1, on the status and on its rule run
    expect(run1.sapVersionId).toBe(v1.sapVersionId);
    expect(run1).toMatchObject({ sapBinding: 'bound', sapAnalysis: true });
    const analysis1 = await analysisSapOf(project, firstBody.viewAnalysisId);
    expect(analysis1.list).toMatchObject({ sapAnalysis: true, sapBinding: 'bound', sapVersionId: v1.sapVersionId });
    expect(analysis1.detail).toMatchObject({ sapAnalysis: true, sapBinding: 'bound', sapVersionId: v1.sapVersionId });
    expect(run1.ruleRunId, JSON.stringify(run1.nodes)).toBeTruthy();
    expect((await ruleRunOf(run1.ruleRunId)).sapVersionId).toBe(v1.sapVersionId);
    // run 2 carries v2 — never v1 — and no step of it was reused from run 1
    // (the SAP version is a reuse-fingerprint component, UT-GOVEXEC-6130).
    expect(v2.sapVersionId).not.toBe(v1.sapVersionId);
    expect(run2.sapVersionId).toBe(v2.sapVersionId);
    expect(run2).toMatchObject({ sapBinding: 'bound', sapAnalysis: true });
    const statuses = (run2.nodes as Array<{ status: string }>).map((n) => n.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses, JSON.stringify(run2.nodes)).not.toContain('REUSED');
    // The governed status names the RESULT's run: when the kernel dedups run 2's
    // identical computation onto run 1's result, that is run 1's id. Run 2's OWN
    // rule-run row (DEDUPED, or a fresh run) is the one stamped v2 — read from
    // the rows this scenario created (the scenarios run serially).
    const rows = (await ruleRunsOfWorkspace()).filter((r) => !priorRunIds.has(r.id));
    expect(rows.map((r) => r.id), JSON.stringify(rows)).toContain(run1.ruleRunId);
    const boundToV2 = rows.filter((r) => r.sapVersionId === v2.sapVersionId);
    expect(boundToV2, JSON.stringify(rows)).toHaveLength(1);
    expect(boundToV2[0].id).not.toBe(run1.ruleRunId);
    if (boundToV2[0].status === 'DEDUPED') expect(boundToV2[0].dedupedFromRunId).toBe(run1.ruleRunId);
    // Every run §.3 created is bound to one of its project's two versions — none unbound.
    expect(rows.filter((r) => r.sapVersionId === v1.sapVersionId).length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sapVersionId === v1.sapVersionId || r.sapVersionId === v2.sapVersionId), JSON.stringify(rows)).toBe(true);
    // An inline plan is not a stored plan: its mode is "not recorded", never inferred.
    expect(run1.mode ?? null).toBeNull();
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

  test('AC12 — AXI-2338.5: an Investigator (sap:write) writes the SAP on his own project only; a plain viewer (no sap:write) cannot @SI-010 @SI-065', async () => {
    // Arrange — the Investigator role is AXI-2322's seed; AXI-2338 grants it `sap:write`
    // (owner ruling 2026-10-30: seed row …0105 + step 14 backfill). A stack without the
    // grant is a FAILED precondition, never a skip.
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
    const created = await investigator.api.post(saps(own), { data: content() });
    const createdBody = await created.json();
    const replan = await investigator.api.post(saps(own, `/${createdBody.id}/versions`), {
      data: { ...content({ planText: 'Investigator amendment.' }), basedOnVersion: 1 },
    });
    const onForeign = await refusalOf(await investigator.api.post(saps(foreign), { data: content() }));
    const onGhost = await refusalOf(await investigator.api.post(saps(neverCreatedProjectId()), { data: content() }));
    const byViewer = await viewer.api.post(saps(viewerProject), { data: content() });

    // Assert
    expect(created.status(), JSON.stringify(createdBody)).toBe(201);
    expect(replan.status()).toBe(201);
    expect(onForeign.status).toBe(404);
    expect(onForeign).toEqual(onGhost);
    expect(byViewer.status()).toBe(403);
  });

  test('AC13 — AXI-2338.6: a Guided run-start records { mode: guided, templateId } — on the run status, the rule-run evidence read and the client report @SI-047 @SI-010 @SI-002 @SI-017', async () => {
    // Arrange — a project with its SAP; `value2` keeps this computation distinct
    // from §.3's (no kernel dedup onto another analysis' run).
    const project = await newProject('guided-mode');
    const datasetId = await linkFixture(project);
    const sap = await editor.api.post(saps(project), { data: content({ linkedMethods: [{ operationId: MWU }] }) });
    expect(sap.status(), await sap.text()).toBe(201);

    // Act
    const res = await submit(project, datasetId, mannWhitneyPlan('guided', 'value2'), { mode: 'guided', templateId: TEMPLATE_ID });
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
    const run = await settledGovernedRun(api, project, body.runId);
    const ruleRun = await ruleRunOf(run.ruleRunId);
    const report = await clientReportMarkdown(project, run.ruleRunId);

    // Assert
    expect(run).toMatchObject({ mode: 'guided', templateId: TEMPLATE_ID, sapBinding: 'bound', sapAnalysis: true });
    expect(run.sapVersionId).toBeTruthy();
    expect(ruleRun).toMatchObject({ mode: 'guided', templateId: TEMPLATE_ID, sapVersionId: run.sapVersionId });
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

  test('AC12 — AXI-2338.8: `sap: "skip"` on a project WITH a SAP runs unbound and records "skipped" — on the status, the analysis, the rule-run evidence read and the client report @SI-047 @SI-065 @SI-017 @SI-002', async () => {
    // Arrange — a project with its SAP; `value3` keeps this computation distinct
    // from every other scenario's, so the rule run read is this run's own.
    const project = await newProject('skip');
    const datasetId = await linkFixture(project);
    const sap = await editor.api.post(saps(project), { data: content({ linkedMethods: [{ operationId: MWU }] }) });
    expect(sap.status(), await sap.text()).toBe(201);

    // Act
    const res = await submit(project, datasetId, mannWhitneyPlan('skip', 'value3'), { sap: 'skip' });
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
    const run = await settledGovernedRun(api, project, body.runId);
    const analysis = await analysisSapOf(project, body.viewAnalysisId);
    const ruleRun = await ruleRunOf(run.ruleRunId);
    const report = await clientReportMarkdown(project, run.ruleRunId);

    // Assert — the SAP exists, the run declined it, and every surface says so
    expect(run).toMatchObject({ sapBinding: 'skipped', sapVersionId: null, sapAnalysis: false });
    expect(analysis.list).toMatchObject({ sapAnalysis: false, sapBinding: 'skipped', sapVersionId: null });
    expect(analysis.detail).toMatchObject({ sapAnalysis: false, sapBinding: 'skipped' });
    expect(ruleRun).toMatchObject({ sapBinding: 'skipped', sapVersionId: null, sapAnalysis: false });
    expect(report).toContain('- SAP version: skipped (the run declined the project SAP)');
  });

  test('AC13 — AXI-2338.9: the wizard call — the plan compiled by POST /opening-templates/compile, submitted with { mode: guided, templateId, sap } — runs and records the template; a templateId the compiled plan does not carry is 400 RUN_MODE_MISMATCH @SI-045 @SI-047 @SI-010', async () => {
    // Arrange — a project with its SAP and the fixture's schema for the compiler
    const project = await newProject('compiled');
    const datasetId = await linkFixture(project);
    const sap = await editor.api.post(saps(project), { data: content({ linkedMethods: [{ operationId: MWU }] }) });
    expect(sap.status(), await sap.text()).toBe(201);
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
    const mismatched = await submit(project, datasetId, plan, { planId: plan.planId, mode: 'guided', templateId: 'T2', sap: 'bind' });
    const mismatchedBody = await mismatched.json();
    const afterRefusal = await analysesOf(project);
    const res = await submit(project, datasetId, plan, { planId: plan.planId, mode: 'guided', templateId: 'T1', sap: 'bind' });
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
    const run = await settledGovernedRun(api, project, body.runId);

    // Assert
    expect(mismatched.status(), JSON.stringify(mismatchedBody)).toBe(400);
    expect(mismatchedBody.errorCode).toBe('RUN_MODE_MISMATCH');
    expect(afterRefusal).toBe(before);
    expect(body).toMatchObject({ runId: expect.any(String), viewAnalysisId: expect.any(String) });
    expect(run).toMatchObject({ mode: 'guided', templateId: 'T1', sapBinding: 'bound', sapAnalysis: true });
    expect(run.sapVersionId).toBeTruthy();
  });
});
