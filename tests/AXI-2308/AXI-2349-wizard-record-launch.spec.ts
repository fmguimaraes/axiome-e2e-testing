import { test, expect } from '@playwright/test';
import { adminApi, asList, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { OPENING_TEMPLATES_PATH, compileTemplate, drainGoverned, ingestCsvFixture } from './harness/opening-templates';

/**
 * AXI-2349 (epic AXI-2308 — FR23, FR52, FR54/D17, AC16, AC17, AC46, AC50, EC19, EC25, EC26):
 * the Guided setup wizard's RUN. `POST /api/v1/guided-analysis/wizard-runs` re-checks every
 * answer against the template's clarificationSlots and the dataset's own vocabulary, compiles
 * the template server-side (no client plan, no LLM), declares the governed run, writes ONE
 * immutable wizard record linked to it, and only then starts it. A refusal writes nothing.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2349.3–.8.
 * API-level (no browser): the wizard screens are AXI-2328's.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic,
 * 24 rows, the investigator's header shape; no patient value).
 *
 * No LLM provider is reachable: the stack runs `GUIDED_ANALYSIS_LLM_TRANSPORT=recorded` with
 * every provider key EMPTY, so the green Run of §.3/.4 is itself the proof that the path calls
 * none (AC17, EC19).
 *
 * STATUS: RUN headless, 6/6 green (2026-10-30), against an ISOLATED stack serving this story's
 * branch: a throwaway Postgres migrated from the branch's own history, an own RabbitMQ vhost and
 * Mongo DB, gateway + user/event/organization/control-plane from the AXI-2349 worktree; the demo
 * bio-compute computed the Mann–Whitney steps. Never the shared demo DB.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2349 branch> npx playwright test tests/AXI-2308/AXI-2349-*`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const QUESTION = `Does ${OUTCOME} differ between F and M?`;
const SPAN = 'F and M';
const MODEL = 'eu.anthropic.claude-haiku-5-5-v1:0';
const PL_ID = /^PL-[0-9a-f]{8}$/;

let api: Api;
let t: Tenant;
let datasetId: string;
let dataset: AnchoredDataset;
let callerId: string;
let catalogVersion: string;

const now = () => new Date().toISOString();

function t1Slots(at = now()) {
  const start = QUESTION.indexOf(SPAN);
  return [
    { slot: 'groupingColumn', value: 'sexe', provenance: 'decided', answeredAt: at },
    { slot: 'groups', value: ['F', 'M'], provenance: 'question', sourceSpan: { text: SPAN, start, end: start + SPAN.length }, answeredAt: at },
    { slot: 'outcome', value: OUTCOME, provenance: 'profile', answeredAt: at },
  ];
}

function body(patch: Record<string, unknown> = {}, projectId = t.projectId) {
  return { projectId, dataset, question: QUESTION, intent: 'compare_groups', intentSource: 'chosen', templateId: 'T1', slots: t1Slots(), ...patch };
}

const launch = (b: unknown, headers = t.headers) => api.post(WIZARD_RUNS, b, headers);

async function recordsOf(projectId = t.projectId, headers = t.headers): Promise<any[]> {
  const res = await api.get(`${WIZARD_RUNS}?projectId=${projectId}`, headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.records;
}

async function analysesOf(projectId = t.projectId): Promise<number> {
  const res = await api.get(`/api/v1/view-analyses?projectId=${projectId}&limit=100`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body?.meta?.total ?? asList(res.body).length;
}

async function newProject(name: string, workspaceId = t.workspaceId): Promise<string> {
  const res = await api.post('/api/v1/projects', { name: `E2E AXI-2349 ${name} ${Date.now()}`, workspaceId }, workspaceHeader(workspaceId));
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.id;
}

/** Every operation node SUCCEEDED/REUSED; the interpretation gate waits for the human; nothing failed. */
async function drainsGreen(runId: string, projectId = t.projectId) {
  const status: any = await drainGoverned(api, { ...t, projectId }, runId);
  for (const node of status.nodes) expect(node.status, JSON.stringify(node)).toMatch(/^(SUCCEEDED|REUSED|AWAITING_APPROVAL)$/);
  expect(status.nodes.some((n: any) => /^(SUCCEEDED|REUSED)$/.test(n.status)), JSON.stringify(status.nodes)).toBe(true);
  return status;
}

/** Nothing written: same records, same analyses, before and after `act`. */
async function writesNothing(act: () => Promise<void>) {
  const [records, analyses] = [(await recordsOf()).length, await analysesOf()];
  await act();
  expect((await recordsOf()).length).toBe(records);
  expect(await analysesOf()).toBe(analyses);
}

async function refused(b: unknown) {
  const res = await launch(b);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok, JSON.stringify(res.body)).toBe(false);
  return res.body;
}

test.describe.serial('AXI-2349 setup wizard — wizard record & run launch @SI-045 @SI-010 @SI-002 @SI-013 @SI-047', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
    const me = await api.get('/api/v1/auth/me');
    callerId = me.body?.id ?? me.body?.user?.id ?? me.body?.data?.id;
    expect(callerId, JSON.stringify(me.body)).toBeTruthy();
    const catalog = await api.get(OPENING_TEMPLATES_PATH, t.headers);
    catalogVersion = (catalog.body as any[]).find((row) => row.templateId === 'T1').version;
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2349.5 AC46 EC25 — nothing is persisted before Run: match and compile write no wizard record', async () => {
    const project = await newProject('before-run');
    await ingestCsvFixture(api, { ...t, projectId: project }, FIXTURE);

    const match = await api.post(`${OPENING_TEMPLATES_PATH}/match`, { projectId: project, dataset }, t.headers);
    const compile = await compileTemplate(api, { ...t, projectId: project }, dataset, 'T1', { datasetId, groupingColumn: 'sexe', groups: ['F', 'M'], outcome: OUTCOME });

    expect(match.status, JSON.stringify(match.body)).toBeLessThan(300);
    expect(compile.body.ok, JSON.stringify(compile.body)).toBe(true);
    expect(await recordsOf(project)).toEqual([]);
  });

  test('AXI-2349.3 AC16 AC46 — Run stores ONE wizard record and starts a guided governed run under it', async () => {
    const slots = t1Slots().map((s) => ({ ...s, answeredBy: 'attacker' }));

    // AXI-2352: a `suggested` intent now needs a cited call-log row (AXI-2352-suggestion-call-log.spec.ts);
    // this Run keeps the question-read value with a chosen intent, so no suggestion is cited.
    const res = await launch(body({ slots }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { ok, record, runId, viewAnalysisId, planId } = res.body;
    expect(ok, JSON.stringify(res.body)).toBe(true);
    expect(planId).toMatch(PL_ID);
    expect(record).toMatchObject({
      projectId: t.projectId, datasetId, runId, viewAnalysisId, planId,
      question: QUESTION, intent: 'compare_groups', intentSource: 'chosen', suggestionModel: null, suggestionCallId: null,
      sapChoice: null, templateId: 'T1', templateVersion: catalogVersion, createdBy: callerId,
    });
    expect(record.slots.map((s: any) => [s.slot, s.value, s.provenance])).toEqual([
      ['groupingColumn', 'sexe', 'decided'], ['groups', ['F', 'M'], 'question'], ['outcome', OUTCOME, 'profile'],
    ]);
    const span = record.slots[1].sourceSpan;
    expect(QUESTION.slice(span.start, span.end)).toBe(span.text);
    for (const s of record.slots) expect(s.answeredBy).toBe(callerId);

    const listed = await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${runId}`, t.headers);
    expect(listed.body.records).toEqual([record]);

    const status = await drainsGreen(runId);
    expect(status).toMatchObject({ mode: 'guided', templateId: 'T1', sapBinding: 'none' });
  });

  test('AXI-2349.4 AC17 EC19 — with no LLM provider reachable a run with no suggestion completes and records suggestionModel null', async () => {
    const slots = t1Slots().map((s) => (s.provenance === 'question' ? { slot: s.slot, value: s.value, provenance: 'decided', answeredAt: s.answeredAt } : s));

    const res = await launch(body({ intentSource: 'chosen', slots }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.record).toMatchObject({ intentSource: 'chosen', suggestionModel: null, sapChoice: null });
    expect(res.body.record.slots.every((s: any) => s.sourceSpan === undefined)).toBe(true);
    await drainsGreen(res.body.runId);
  });

  test('AXI-2349.6 AC50 EC26 — a compile refusal (T2 on a two-level grouping) names the step and writes nothing', async () => {
    await writesNothing(async () => {
      const at = now();
      const r = await refused(body({
        templateId: 'T2',
        slots: [
          { slot: 'groupingColumn', value: 'sexe', provenance: 'decided', answeredAt: at },
          { slot: 'outcome', value: OUTCOME, provenance: 'decided', answeredAt: at },
        ],
      }));
      expect(r.code).toBe('GUARD_UNMET');
      expect(r.ruleIds).toContain('T2.grouping');
      expect(r.slots).toContain('groupingColumn');
      expect(r.messages.length).toBeGreaterThan(0);
    });
  });

  test('AXI-2349.7 AC46 AC50 — answers are re-checked server-side: a foreign outcome, a forged span, an unasked slot are refused and write nothing', async () => {
    await writesNothing(async () => {
      const slots = t1Slots();
      const foreign = await refused(body({ slots: slots.map((s) => (s.slot === 'outcome' ? { ...s, value: 'not_a_column' } : s)) }));
      const forged = await refused(body({ slots: slots.map((s) => (s.slot === 'groups' ? { ...s, sourceSpan: { text: SPAN, start: 0, end: SPAN.length } } : s)) }));
      const unasked = await refused(body({ slots: [...slots, { slot: 'adjustFor', value: 'age', provenance: 'decided', answeredAt: now() }] }));

      expect(foreign).toMatchObject({ code: 'ANSWERS_REFUSED', ruleIds: ['WIZ_VALUE_NOT_IN_VOCABULARY'], slots: ['outcome'] });
      expect(forged).toMatchObject({ code: 'ANSWERS_REFUSED', ruleIds: ['WIZ_SPAN_MISMATCH'], slots: ['groups'] });
      expect(unasked).toMatchObject({ code: 'ANSWERS_REFUSED', ruleIds: ['WIZ_SLOT_NOT_ASKED'] });
    });
  });

  test('AXI-2349.8 AC16 — the plan, the model id and the tenancy are bounded server-side: 400 on a client plan or a bad model id, 404 on an unknown project or another workspace\'s dataset', async () => {
    const otherWorkspace = await api.post('/api/v1/workspaces', { name: `E2E AXI-2349 other ${Date.now()}`, type: 'internal', ownerOrganizationId: t.orgId });
    expect(otherWorkspace.status, JSON.stringify(otherWorkspace.body)).toBeLessThan(300);
    const otherProject = await newProject('other-ws', otherWorkspace.body.id);

    await writesNothing(async () => {
      const statuses = await Promise.all([
        launch({ ...body(), plan: { nodes: [] } }),
        launch({ ...body(), caller: { userId: 'attacker' } }),
        launch(body({ suggestionModel: MODEL })), // AXI-2352: the model is read server-side, never sent
        launch(body({ suggestionCallId: 'model <script>' })),
      ]);
      for (const res of statuses) expect(res.status, JSON.stringify(res.body)).toBe(400);

      const unknownProject = await launch(body({}, '00000000-0000-4000-8000-000000000000'));
      expect(unknownProject.status, JSON.stringify(unknownProject.body)).toBe(404);
    });

    const crossTenant = await launch(body({}, otherProject), workspaceHeader(otherWorkspace.body.id));
    expect(crossTenant.status, JSON.stringify(crossTenant.body)).toBe(404);
    expect(JSON.stringify(crossTenant.body)).toContain('Dataset not found');
    expect(await recordsOf(otherProject, workspaceHeader(otherWorkspace.body.id))).toEqual([]);
  });
});
