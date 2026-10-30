import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminApi, asList, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { ingestCsvFixture } from './harness/opening-templates';
import { callLogRows, debugHolder, type DebugHolder } from './harness/automatic-mode';

/**
 * AXI-2352 (epic AXI-2308 — FR27, FR46, FR52, FR54, D17, NFR3, NFR11b): the Guided wizard's
 * suggestion call writes ONE FR27 call-log row per call and answers with its handle (`callId`);
 * the wizard Run cites the handle (`suggestionCallId`) and the server stores the model READ FROM
 * THE ROW on the wizard record. A client can no longer send a model.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2352.3–.6.
 * API-level (no browser).
 *
 * Transport: RECORDED only (labelled `claude-code`; the stack has every provider key empty and
 * never sets the live transport). The recorded arm names the logical default model
 * `claude-haiku-5-5`, which is therefore what the row and the record carry here. The live AWS
 * Bedrock arm's fail-closed behaviour is unit-proven (UT-GUIDED-6683–6685, 6687) — never here.
 *
 * Recording (blind Claude Code author on claude-haiku-5-5, 0 USD): the answer to QUESTION on the
 * anchored fixture's vocabulary, under `axiome-back/apps/organization-service/llm-debug/recordings/intent-prefill/`.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 *
 * STATUS: RUN headless, 4/4 green (2026-10-30), against an ISOLATED stack serving this story's
 * branch (own Postgres migrated from the branch's history, own RabbitMQ vhost and Mongo DB; demo
 * bio-compute). Never the shared demo DB.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2352 branch> npx playwright test tests/AXI-2308/AXI-2352-* --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const SUGGEST = '/api/v1/guided-analysis/intent-prefill/suggest';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const QUESTION = `Does ${OUTCOME} differ between F and M?`;
const SPAN = 'F and M';
const RECORDED_MODEL = 'claude-haiku-5-5';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let api: Api;
let t: Tenant;
let holder: DebugHolder;
let dataset: AnchoredDataset;
let callId: string;
let served: any;

const now = () => new Date().toISOString();

function suggest(question = QUESTION, ds: unknown = dataset, projectId = t.projectId) {
  return api.post(SUGGEST, { projectId, question, dataset: ds }, t.headers);
}

function t1Slots(question = QUESTION, at = now()) {
  const start = question.indexOf(SPAN);
  return [
    { slot: 'groupingColumn', value: 'sexe', provenance: 'decided', answeredAt: at },
    { slot: 'groups', value: ['F', 'M'], provenance: 'question', sourceSpan: { text: SPAN, start, end: start + SPAN.length }, answeredAt: at },
    { slot: 'outcome', value: OUTCOME, provenance: 'profile', answeredAt: at },
  ];
}

function body(patch: Record<string, unknown> = {}) {
  const question = (patch.question as string | undefined) ?? QUESTION;
  return { projectId: t.projectId, dataset, question, intent: 'compare_groups', intentSource: 'chosen', templateId: 'T1', slots: t1Slots(question), ...patch };
}

const launch = (b: unknown) => api.post(WIZARD_RUNS, b, t.headers);

async function recordsOf(): Promise<any[]> {
  const res = await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.records;
}

async function analysesOf(): Promise<number> {
  const res = await api.get(`/api/v1/view-analyses?projectId=${t.projectId}&limit=100`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body?.meta?.total ?? asList(res.body).length;
}

async function writesNothing(act: () => Promise<void>) {
  const [records, analyses] = [(await recordsOf()).length, await analysesOf()];
  await act();
  expect((await recordsOf()).length).toBe(records);
  expect(await analysesOf()).toBe(analyses);
}

async function refusedWith(b: unknown, ruleId: string) {
  const res = await launch(b);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ ok: false, code: 'ANSWERS_REFUSED' });
  expect(res.body.ruleIds).toEqual([ruleId]);
}

const intentPrefillRows = async () => (await callLogRows(holder, t)).filter((r) => r.callSite === 'intent-prefill');

test.describe.serial('AXI-2352 suggestion call log, model stored @SI-045 @SI-010 @SI-002', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
    holder = await debugHolder(api, t);
  });

  test.afterAll(async () => {
    await holder?.cleanup();
    await api?.ctx.dispose();
  });

  test('AXI-2352.3 (FR27, FR54, NFR3) an answered suggestion returns its call handle and writes ONE intent-prefill row @SI-045 @SI-010', async () => {
    const res = await suggest();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status, JSON.stringify(res.body)).toBe('answered');
    expect(res.body.intent).toBe('compare_groups');
    expect(res.body.callId).toMatch(UUID);
    callId = res.body.callId;
    served = res.body;

    const rows = (await intentPrefillRows()).filter((r) => r.correlationId === callId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      callSite: 'intent-prefill', entryMode: 'guided', transport: 'recorded', source: 'claude-code',
      model: RECORDED_MODEL, outcome: 'answered', suggestedIntent: 'compare_groups', attempt: 1,
    });
    expect(row.promptVersion).toMatch(/^intent-prefill\//);
    expect(row.source).not.toBe('live');
    expect(row.suggestedSlots).toEqual(
      served.slots.map((s: any) => ({ slot: s.slot, value: s.value, ...(s.column ? { column: s.column } : {}), start: s.sourceSpan.start, end: s.sourceSpan.end })),
    );
    expect(JSON.stringify(row)).not.toContain(QUESTION);
    expect(JSON.stringify(row)).not.toContain(SPAN);
  });

  test('AXI-2352.4 (FR52, D17) Run cites the call; the record stores the model read from its row @SI-045 @SI-010', async () => {
    const res = await launch(body({ intentSource: 'suggested', suggestionCallId: callId }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.record).toMatchObject({ intentSource: 'suggested', suggestionCallId: callId, suggestionModel: RECORDED_MODEL });
    const listed = await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${res.body.runId}`, t.headers);
    expect(listed.body.records).toEqual([res.body.record]);

    const plain = t1Slots().map((s) => (s.provenance === 'question' ? { slot: s.slot, value: s.value, provenance: 'decided', answeredAt: s.answeredAt } : s));
    const none = await launch(body({ slots: plain }));
    expect(none.body.ok, JSON.stringify(none.body)).toBe(true);
    expect(none.body.record).toMatchObject({ intentSource: 'chosen', suggestionCallId: null, suggestionModel: null });
  });

  test('AXI-2352.5 (D17, NFR5) a client cannot assert, forge or borrow a suggestion; nothing is written @SI-045 @SI-010', async () => {
    const other = await api.post('/api/v1/projects', { name: `E2E AXI-2352 other ${Date.now()}`, workspaceId: t.workspaceId }, workspaceHeader(t.workspaceId));
    expect(other.status, JSON.stringify(other.body)).toBeLessThan(300);
    const borrowed = await suggest(QUESTION, dataset, other.body.id);
    expect(borrowed.body.status, JSON.stringify(borrowed.body)).toBe('answered');
    expect(borrowed.body.callId).toMatch(UUID);
    const otherQuestion = `Does ${OUTCOME} really differ between F and M?`;

    await writesNothing(async () => {
      for (const b of [body({ suggestionCallId: callId, suggestionModel: 'eu.anthropic.claude-opus-forged' }), body({ suggestionCallId: 'not-a-uuid' })]) {
        const res = await launch(b);
        expect(res.status, JSON.stringify(res.body)).toBe(400);
      }
      await refusedWith(body({ intentSource: 'suggested' }), 'WIZ_SUGGESTION_UNVERIFIED');
      await refusedWith(body({ suggestionCallId: '00000000-0000-4000-8000-000000000000' }), 'WIZ_SUGGESTION_CALL_UNKNOWN');
      await refusedWith(body({ question: otherQuestion, suggestionCallId: callId }), 'WIZ_SUGGESTION_QUESTION_MISMATCH');
      await refusedWith(
        body({ intent: 'explore_dataset', intentSource: 'suggested', templateId: 'T1', suggestionCallId: callId }),
        'WIZ_SUGGESTION_INTENT_MISMATCH',
      );
      await refusedWith(body({ intentSource: 'suggested', suggestionCallId: borrowed.body.callId }), 'WIZ_SUGGESTION_CALL_UNKNOWN');
    });
  });

  test('AXI-2352.6 (FR27, NFR11b) a call that sent nothing is logged with no model and cannot be cited @SI-045', async () => {
    const identifying = {
      datasetId: randomUUID(),
      columns: [
        { name: 'ccl19', type: 'numeric' },
        { name: 'visit', type: 'categorical', categories: ['P001', 'P002'] },
      ],
    };
    const before = new Set((await intentPrefillRows()).map((r) => r.correlationId));

    const res = await suggest('Does ccl19 differ between P001 and P002?', identifying);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'skipped_identifying', intent: null, slots: [], contradictions: [], callId: null });
    const fresh = (await intentPrefillRows()).filter((r) => !before.has(r.correlationId));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      callSite: 'intent-prefill', entryMode: 'guided', outcome: 'skipped_identifying', model: 'not_called',
      transport: 'none', suggestedIntent: null, suggestedSlots: [], // a suggestion row's slot list is always a list; null is a non-suggestion row
    });
  });
});
