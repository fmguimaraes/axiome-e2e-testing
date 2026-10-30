import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { compileTemplate, drainGoverned, ingestCsvFixture, submitGoverned } from './harness/opening-templates';
import { automaticDataFlow, automaticPlan, callLogRows, debugHolder, type DebugHolder } from './harness/automatic-mode';

/**
 * AXI-2341 (epic AXI-2308 — FR25, FR26, FR27, FR46, NFR3, NFR11; AC19, AC20, AC21, AC37;
 * EC14, EC15): Automatic mode. One model call per question picks an opening template and
 * its flat parameters; the server compiles it through the Guided chain (AXI-2339), logs
 * the call, and runs nothing — or refuses and offers the Guided list with the question kept.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2341.3–.8. API-level (no browser): the question-screen switch is AXI-2328's.
 * .9 (AC40, live Bedrock acceptance) is `manual` — deferred to the owner's written live go.
 *
 * ZERO SPEND BY CONSTRUCTION. The stack runs `GUIDED_ANALYSIS_LLM_TRANSPORT=recorded`
 * with no provider key and no AWS credential: every model answer is a committed
 * recording under `axiome-back/apps/organization-service/llm-debug/recordings/compiled-planner/`,
 * each authored by a blind headless `claude -p` session (empty dir, no tools, no settings,
 * key stripped) from the pending payload alone (system, messages,
 * outputSchema), never by the developer. A recording miss is a loud `RECORDING_MISSING`.
 *
 * Fixtures (synthetic, no patient value): `opening-templates-paul-header.csv` (AXI-2339,
 * the investigator's header shape) and `automatic-identifying-levels.csv` (a `visite`
 * column whose levels are dates — the "identifiers leaked as levels" regression).
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2341 branch> npx playwright test tests/AXI-2308/AXI-2341-*`.
 */

const PAUL = 'opening-templates-paul-header.csv';
const IDENTIFYING = 'automatic-identifying-levels.csv';
const MAG4_27 = 'microbiote_igg4_mag4_27';
const Q_T1 = `Does ${MAG4_27} differ between F and M of sexe?`;
const Q_NONE = 'How long do patients survive after diagnosis, and does survival differ by sexe?';
const Q_REFUSED = 'Do igg4_g_l and age move together once sexe is accounted for?';
const Q_IDENTIFYING = 'Does igg4_g_l differ between F and M of sexe?';

let api: Api;
let t: Tenant;
let paulId: string;
let paul: AnchoredDataset;
let holder: DebugHolder;
const callIds: Record<string, string> = {};

async function plan(dataset: unknown, question: string) {
  const res = await automaticPlan(api, t, dataset, question);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

function expectGuidedFallback(body: any, question: string) {
  expect(body.ok, JSON.stringify(body)).toBe(false);
  expect(body.offerGuided).toBe(true);
  expect(body.question).toBe(question);
  expect(body).not.toHaveProperty('compiled');
  expect(body.messages.length).toBeGreaterThan(0);
}

test.describe.serial('AXI-2341 Automatic mode — one call, compiled by the Guided chain, logged @SI-045 @SI-002 @SI-010', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    expect(process.env.E2E_LIVE_LLM).toBeUndefined();
    expect(process.env.GUIDED_ANALYSIS_LIVE_SPEND_GO).toBeUndefined();
    api = await adminApi();
    t = await ensureTenant(api);
    paulId = await ingestCsvFixture(api, t, PAUL);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId: paulId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    paul = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
    holder = await debugHolder(api, t);
  });

  test.afterAll(async () => {
    await holder?.cleanup();
    await api?.ctx.dispose();
  });

  test('AXI-2341.3 AC19 AC20 — a question becomes T1 + flat parameters, compiled, and the plan runs green', async () => {
    test.setTimeout(240_000);
    const body = await plan(paul, Q_T1);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body).toMatchObject({ mode: 'automatic', templateId: 'T1', question: Q_T1 });
    expect(body.promptVersion).toMatch(/^GA-AUTO-\d+$/);
    expect(body.parameters).toEqual({ datasetId: paulId, outcome: MAG4_27, groupingColumn: 'sexe', groups: expect.arrayContaining(['F', 'M']) });
    expect(body.parameters.groups).toHaveLength(2);
    const ops = (body.compiled.plan.nodes as any[]).filter((n) => n.operation).map((n) => n.operation.operationId);
    expect(ops).toEqual(['stats.mann_whitney_u']);
    callIds.accepted = body.callId;
    const runId = await submitGoverned(api, t, body.compiled.plan, paulId);
    const status = await drainGoverned(api, t, runId);
    for (const node of status.nodes) expect(node.status, JSON.stringify(node)).toMatch(/^(SUCCEEDED|REUSED|AWAITING_APPROVAL)$/);
  });

  test('AXI-2341.4 AC19 EC14 — a none answer runs nothing, keeps the question and offers the Guided list', async () => {
    const body = await plan(paul, Q_NONE);
    expectGuidedFallback(body, Q_NONE);
    expect(body.code).toBe('NONE');
    callIds.none = body.callId;
  });

  // A template could answer this only by STRETCHING (T4 adjusting for a grouping column). Either
  // refusal is correct: the model declines (`NONE`, the reinforced prompt's "never stretch" rule)
  // or the Guided chain refuses its stretched choice (`GUARD_UNMET`). The compile-refusal path
  // itself is pinned deterministically by UT-GUIDED-6627; this scenario proves nothing runs.
  test('AXI-2341.5 AC19 EC14 — a question a template could only answer by stretching runs nothing', async () => {
    const body = await plan(paul, Q_REFUSED);
    expectGuidedFallback(body, Q_REFUSED);
    expect(['NONE', 'GUARD_UNMET']).toContain(body.code);
    callIds.refused = body.callId;
  });

  test('AXI-2341.7 AC37 EC15 — an identifying level refuses before any model request; Guided compiles the same dataset', async () => {
    const id = await ingestCsvFixture(api, t, IDENTIFYING);
    const dataset = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId: id });
    if (!dataset) throw new Error('identifying fixture could not be anchored');
    const visite = dataset.columns.findIndex((c) => c.name === 'visite');
    const body = await plan(dataset, Q_IDENTIFYING);
    expectGuidedFallback(body, Q_IDENTIFYING);
    expect(body.code).toBe('IDENTIFYING_DATA');
    expect(body.findings).toContainEqual({ columnIndex: visite, kind: 'level', ruleId: 'NFR11-L1' });
    expect(JSON.stringify(body)).not.toMatch(/2024-0\d-0\d/);
    callIds.identifying = body.callId;
    const guided = await compileTemplate(api, t, dataset, 'T1', { datasetId: id, outcome: 'igg4_g_l', groupingColumn: 'sexe', groups: ['F', 'M'] });
    expect(guided.body.ok, JSON.stringify(guided.body)).toBe(true);
  });

  test('AXI-2341.6 AC21 — every call has one automatic call-log row with prompt version, model, template, outcome and plan link', async () => {
    const rows = await callLogRows(holder, t);
    const byCall = (id: string) => rows.filter((r) => r.correlationId === id);
    for (const id of Object.values(callIds)) expect(byCall(id), id).toHaveLength(1);
    const [accepted] = byCall(callIds.accepted);
    expect(accepted).toMatchObject({ entryMode: 'automatic', source: 'claude-code', outcome: 'accepted', templateId: 'T1', refusalCodes: [] });
    expect(accepted.promptVersion).toMatch(/^GA-AUTO-\d+$/);
    expect(accepted.planId).toMatch(/^PL-/);
    expect(accepted.model).toBe('bedrock-model-unset');
    expect(accepted.templateParameters).toMatchObject({ datasetId: paulId, outcome: MAG4_27 });
    expect(byCall(callIds.none)[0]).toMatchObject({ outcome: 'none', templateId: 'none', refusalCodes: ['NONE'], planId: null });
    const refused = byCall(callIds.refused)[0];
    expect(refused).toMatchObject({ planId: null });
    expect(refused.refusalCodes).toEqual([refused.outcome.toUpperCase()]);
    expect(byCall(callIds.identifying)[0]).toMatchObject({ outcome: 'identifying_data', model: 'not_called', templateId: null });
    for (const row of rows.filter((r) => r.entryMode === 'automatic')) {
      expect(row.source).not.toBe('live');
      expect(JSON.stringify(row)).not.toContain(Q_T1);
    }
  });

  test('AXI-2341.8 AC37 — the data-flow statement names AWS Bedrock and the EU region', async () => {
    const res = await automaticDataFlow(api, t);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transport: 'aws-bedrock', region: 'eu-west-3' });
    expect(res.body.statement).toContain('AWS Bedrock');
    expect(res.body.statement).toContain('eu-west-3');
    expect(res.body.statement).toContain('no patient-level values');
    expect(res.body.statement).toContain('the analysis itself runs without any external call.');
  });
});
