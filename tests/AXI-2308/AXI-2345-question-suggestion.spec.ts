import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';

/**
 * AXI-2345 (epic AXI-2308 — FR49, FR54, AC43, AC48, EC21, EC22, NFR11): the Guided setup
 * wizard's question → intent + slot suggestion. One cheap-LLM call, on the RECORDED transport
 * (call site `intent-prefill`); the server accepts only closed-set intents and values of the
 * dataset's own vocabulary, each tied to the exact words of the question.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2345.3–.8.
 * API-level (no browser): the wizard that consumes this is AXI-2328.
 *
 * The schema below has the same column names/types/levels as the unit fixture
 * `organization-service/…/templates/opening/__fixtures__/paul-shaped-schema.ts`, so the
 * vocabulary — and therefore the recording key — is the one UT-GUIDED-6236 replays. Names and
 * levels only; no patient value anywhere. The dataset id is a fresh UUID with no stored
 * declaration, so the server-side stamp adds nothing.
 *
 * Recordings (blind Claude Code author, 0 USD): `apps/organization-service/llm-debug/recordings/
 * intent-prefill/54f77aab….json` (§.4) and `83d17fbb….json` (§.5). §.7 deliberately has none.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2345 branch> npx playwright test tests/AXI-2308/AXI-2345-* --no-deps`.
 */

const CATALOG_PATH = '/api/v1/guided-analysis/intent-prefill/catalog';
const SUGGEST_PATH = '/api/v1/guided-analysis/intent-prefill/suggest';

const MICROBIOTE = [
  'microbiote_igg4_cer_228',
  'microbiote_igg4_mag4_27',
  'microbiote_igg4_mag4_22',
  'microbiote_igg4_mag4_13',
  'microbiote_igg4_cer_215_et_234',
  'microbiote_igg4_cer_229',
  'microbiote_igg4_ent_059',
];
const NUMERIC_TAIL = [
  'atteinte_pancreatique',
  'score_histo',
  'igg4_hpf',
  'rechutes',
  'igg4_rd_ri',
  'low_completement',
  'plasmablasts_cd19_cd38_cd27_mm3',
  'tfh_cxcr5_pd1_cd4',
];
const CLUSTER = 'cluster_selon_acr_eular_2019';

const numeric = (name: string) => ({ name, type: 'numeric' });

function paulShapedSchema(columns?: unknown[]) {
  return {
    datasetId: randomUUID(),
    displayName: 'tableau2.xlsx',
    versionHash: `sha256:${'a1'.repeat(32)}`,
    columns: columns ?? [
      { name: 'patient_id', type: 'identifier' },
      ...MICROBIOTE.map(numeric),
      numeric('igg4_g_l'),
      { name: 'sexe', type: 'categorical', categories: ['F', 'M'] },
      numeric('age'),
      { name: CLUSTER, type: 'categorical', categories: ['C1', 'C2', 'C3', 'C4'] },
      ...NUMERIC_TAIL.map(numeric),
    ],
  };
}

const VOCABULARY = new Set([
  ...MICROBIOTE,
  'igg4_g_l',
  'age',
  ...NUMERIC_TAIL,
  'sexe',
  'F',
  'M',
  CLUSTER,
  'C1',
  'C2',
  'C3',
  'C4',
]);

let api: Api;
let t: Tenant;

function suggest(question: string, dataset: unknown = paulShapedSchema(), extra: Record<string, unknown> = {}) {
  return api.post(SUGGEST_PATH, { projectId: t.projectId, question, dataset, ...extra }, t.headers);
}

/** Every span is the question's own words at its own offsets. */
function expectSpansAreTheQuestionsWords(question: string, entries: Array<{ sourceSpan: any }>) {
  for (const { sourceSpan } of entries) {
    expect(question.slice(sourceSpan.start, sourceSpan.end)).toBe(sourceSpan.text);
  }
}

test.describe('AXI-2345 question suggestion @SI-045 @SI-010 @SI-002', () => {
  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureTenant(api);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2345.3 (AC42) the intent catalogue lists the five intents in order @SI-045', async () => {
    const res = await api.get(CATALOG_PATH, t.headers);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((e: any) => e.id)).toEqual([
      'explore_dataset',
      'compare_groups',
      'find_validate_biomarkers',
      'follow_patients_over_time',
      'reproduce_published_analysis',
    ]);
    for (const entry of res.body) expect(entry.label.length).toBeGreaterThan(0);
  });

  test('AXI-2345.4 (AC43, AC48) a question yields a closed-set intent and vocabulary values with their spans @SI-045', async () => {
    const question = 'Does igg4_g_l differ between clusters C1 and C3?';

    const res = await suggest(question);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('answered');
    expect(res.body.intent).toBe('compare_groups');
    expect(res.body.slots.map((s: any) => [s.slot, s.value])).toEqual([
      ['groupingColumn', CLUSTER],
      ['outcome', 'igg4_g_l'],
      ['groups', 'C1'],
      ['groups', 'C3'],
    ]);
    for (const slot of res.body.slots) expect(VOCABULARY.has(slot.value)).toBe(true);
    for (const g of res.body.slots.filter((s: any) => s.slot === 'groups')) expect(g.column).toBe(CLUSTER);
    expectSpansAreTheQuestionsWords(question, res.body.slots);
    expect(res.body.contradictions).toEqual([]);
  });

  test('AXI-2345.5 (AC43, EC21, EC22) words the vocabulary lacks are never served as a value @SI-045', async () => {
    const question = 'Is igg4_g_l higher in cluster C2 patients than in healthy donors?';

    const res = await suggest(question);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('answered');
    for (const slot of res.body.slots) expect(VOCABULARY.has(slot.value)).toBe(true);
    expect(res.body.contradictions).toEqual([
      { slot: 'groups', sourceSpan: expect.objectContaining({ text: 'healthy donors' }), reason: 'not_in_vocabulary' },
    ]);
    for (const c of res.body.contradictions) expect(Object.keys(c).sort()).toEqual(['reason', 'slot', 'sourceSpan']);
    expectSpansAreTheQuestionsWords(question, [...res.body.slots, ...res.body.contradictions]);
  });

  test('AXI-2345.6 (AC48, NFR11b) subject codes as levels skip the call — nothing is sent @SI-045', async () => {
    const dataset = paulShapedSchema([
      numeric('ccl19'),
      { name: 'visit', type: 'categorical', categories: ['P001', 'P002'] },
    ]);

    const res = await suggest('Does ccl19 differ between P001 and P002?', dataset);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'skipped_identifying', intent: null, slots: [], contradictions: [] });
  });

  test('AXI-2345.7 (AC48, AC17) no answer available is an empty suggestion, never an error @SI-045 @SI-010', async () => {
    const started = Date.now();

    const res = await suggest(`An unrecorded question ${randomUUID()} about igg4_g_l?`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'recording_missing', intent: null, slots: [], contradictions: [] });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test('AXI-2345.8 (AC48) tenancy is the server’s: a body `caller` is refused and an unreachable project gets no suggestion @SI-010', async () => {
    const asserted = await suggest('Does igg4_g_l differ by sexe?', paulShapedSchema(), {
      caller: { userId: 'someone-else', workspaceId: randomUUID() },
    });
    const foreign = await api.post(
      SUGGEST_PATH,
      { projectId: randomUUID(), question: 'Does igg4_g_l differ by sexe?', dataset: paulShapedSchema() },
      t.headers,
    );

    expect(asserted.status, JSON.stringify(asserted.body)).toBe(400);
    expect(foreign.status, JSON.stringify(foreign.body)).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
    expect(foreign.body?.status).toBeUndefined();
  });
});
