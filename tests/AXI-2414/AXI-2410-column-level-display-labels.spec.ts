import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2410 (epic AXI-2414 — FR61, FR13 amended, AC58, EC33; SI-068, SI-014). Column and level
 * display labels for question reading. `POST /api/v1/guided-analysis/question-reading/read`
 * (call site `question-reading`, prompt `reading/1` — B5 review fix: the system prompt text is
 * UNCHANGED by this story, RECORDED transport) now also matches the investigator's words against
 * a column/level's declared clinician-facing label, falling back to the id when no label is
 * declared (EC33/NFR3).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2410.
 *
 * AXI-2410.1/.2 (an "answered" reading that resolves a LABEL word to its column/level id) are
 * DEFERRED — same precedent as AXI-2364's own §.2/§.3, for the SAME reason AXI-2364 itself never
 * built an "answered" assertion either: every dataset here is freshly ingested per run
 * (`ingestCsvFixture`), so its `datasetId` — and therefore the request hash the recorded
 * transport looks up by — differs on every run and can never match a committed recording. A
 * genuine "answered, label resolved" assertion needs a FIXED seeded dataset id (e.g. the MAG4
 * demo project's own datasets, `reading/__fixtures__/mag4-demo-vocabularies.ts`) with a
 * real persisted `displayLabels` declaration and an offline-authored recording keyed to that
 * exact request — real follow-up work, not done here. The deterministic label -> id resolution
 * itself (exact, case-insensitive, ambiguity, fallback-to-id) IS covered unit-to-unit, AAA, in
 * `dataset-semantic-declaration.spec.ts` (`UT-DSD-2410-*`), `reading-vocabulary.spec.ts`
 * (`UT-READING-2410-01*`) and `reading.validator.spec.ts` (`UT-READING-2410-00*`).
 *
 * AXI-2410.3 (review fix B4) pins the EXACT deterministic outcome — `recording_missing` with an
 * empty reading (the AXI-2364.4 shape) — rather than accepting any of several statuses, so a
 * regression that silently changed the no-recording contract (an invented label leaking into
 * the empty reading, a non-empty `readings` array, a different status) fails this test. A real
 * HTTP round-trip that PERSISTS a `displayLabels` declaration via `PUT
 * /datasets/:id/semantic-declaration` and then reads it back through `question-reading/read` was
 * attempted and withdrawn: the shared demo backend this worktree runs against serves the
 * PRE-MERGE org-service (its declaration validator does not know `displayLabels` yet — `400
 * DECL_UNKNOWN_KEY`), so that round-trip can only be run after this story's backend change is
 * deployed — the SAME deployment dependency AXI-2410.1/.2 are deferred for. Tracked as the same
 * follow-up: author it on a fixed seeded dataset once this branch (or a later one) is live.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2410 branch> npx playwright test --project=axi-2410-api tests/AXI-2414/AXI-2410-*`.
 */

const READ_PATH = '/api/v1/guided-analysis/question-reading/read';
const FIXTURE = 'opening-templates-paul-header.csv';
const NO_READING = { type: null, readings: [], clarifyingQuestion: null, callId: null };

function fixtureSchema(datasetId: string) {
  const numeric = (name: string) => ({ name, type: 'numeric' });
  return {
    datasetId,
    displayName: FIXTURE,
    versionHash: `sha256:${'d4'.repeat(32)}`,
    columns: [
      { name: 'patient_id', type: 'identifier' },
      ...['microbiote_igg4_cer_228', 'igg4_g_l', 'age'].map(numeric),
      { name: 'sexe', type: 'categorical', categories: ['F', 'M'] },
    ],
  };
}

let api: Api;
let t: Tenant;
let ownDatasetId: string;

function read(question: string, datasets: unknown[]) {
  return api.post(READ_PATH, { projectId: t.projectId, question, datasets }, t.headers);
}

test.describe('AXI-2410 column/level display labels @SI-068 @SI-014', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    api = await adminApi();
    t = await ensureTenant(api);
    ownDatasetId = await ingestCsvFixture(api, t, FIXTURE);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test.skip(
    'AXI-2410.1 (AC58) a question naming a declared column label resolves to that column id — DEFERRED: needs a fixed-dataset reading/1 recording',
    () => {},
  );
  test.skip(
    'AXI-2410.2 (AC58) a question naming a declared level label resolves to that level id — DEFERRED: needs a fixed-dataset reading/1 recording',
    () => {},
  );

  test('AXI-2410.3 (EC33, NFR3) a recording miss is loud — pinned recording_missing with an empty reading, never a label fallback or a status drift @SI-068 @SI-014', async () => {
    const res = await read(`An unrecorded AXI-2410 question ${randomUUID()} about igg4_g_l and age?`, [
      fixtureSchema(ownDatasetId),
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'recording_missing', ...NO_READING });
  });
});
