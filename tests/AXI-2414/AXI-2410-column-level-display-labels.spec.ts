import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { apiUrl } from '../../config/env';

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
 * REVIEW BOUNCE 2 (B4): the previous version of `AXI-2410.3` pinned the exact `recording_missing`
 * contract on a FRESH, label-less dataset with a random question — the pre-existing AXI-2364.4
 * shape, unchanged by this story, so the spec went green whether or not AXI-2410's own code was
 * deployed (it never declared a label at all). This version instead drives the real HTTP contract
 * this story actually adds, end to end, against a gateway serving THIS branch:
 *   `PUT /api/v1/discovery/datasets/:datasetId/semantic-declaration` to PERSIST a `displayLabels`
 *   declaration, then `POST question-reading/read` to observe its effect. Four scenarios (AC58,
 *   EC33, EC7, NFR11b/B2):
 *     3a — a persisted `displayLabels` declaration reads back unchanged (the write path exists).
 *     3b — a label naming a column that is not a column of the dataset is refused at the
 *          declaration gate itself: `400 DECL_COLUMN_UNKNOWN` (EC7) — never silently dropped.
 *     3c — an IDENTIFYING label (a personal name as a level label) makes the identifying-data
 *          screen fire on the LABEL text, not only on the id/level it stands for (review fix B2):
 *          `{status:'skipped_identifying', ...NO_READING}`, exactly. This is B2 checked end to
 *          end, not merely unit-to-unit.
 *     3d — a NON-identifying label still reaches the call: on the recorded transport's exact-match
 *          miss, the EXACT deterministic `recording_missing` empty-reading contract (never an
 *          invented label fallback, never a status drift) — proving the label path is reached and
 *          does not crash, and that the no-recording contract is unchanged by this story (EC33/NFR3).
 *
 * Confirmed live (2026-11-04) that 3a/3b/3c discriminate: run against the PRE-MERGE org-service
 * (the shared demo backend on :3000) and 3a/3b fail with `400 DECL_UNKNOWN_KEY` (the declaration
 * validator does not know `displayLabels` yet) and 3c reports `recording_missing` instead of
 * `skipped_identifying` (no label screen exists yet) — so a regression in this story's own code
 * (B2's screen, B3's lookup, the `displayLabels` declaration member) fails this spec, not just an
 * absent deployment.
 *
 * AXI-2410.1/.2 (an "answered" reading that resolves a LABEL word to its column/level id) stay
 * DEFERRED — same precedent as AXI-2364's own §.2/§.3, for the SAME reason: every dataset here is
 * freshly ingested per run (`ingestCsvFixture`), so its `datasetId` — and therefore the request
 * hash the recorded transport looks up by — differs on every run and can never match a committed
 * recording. A genuine "answered, label resolved" assertion needs a FIXED seeded dataset id (e.g.
 * the MAG4 demo project's own datasets, `reading/__fixtures__/mag4-demo-vocabularies.ts`) with a
 * real persisted `displayLabels` declaration and an offline-authored recording keyed to that exact
 * request. No Jira follow-up key has been minted for this gap yet (flagged to the engineering
 * manager rather than guessed — see the W4 handoff report). The deterministic label -> id
 * resolution itself (exact, case-insensitive, ambiguity, fallback-to-id) IS covered unit-to-unit,
 * AAA, in `dataset-semantic-declaration.spec.ts` (`UT-DSD-2410-*`), `reading-vocabulary.spec.ts`
 * (`UT-READING-2410-01*`) and `reading.validator.spec.ts` (`UT-READING-2410-00*`).
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2410 branch> npx playwright test --project=axi-2410-api tests/AXI-2414/AXI-2410-*`.
 */

const READ_PATH = '/api/v1/guided-analysis/question-reading/read';
const DECLARE_PATH = (datasetId: string) => `/api/v1/discovery/datasets/${datasetId}/semantic-declaration`;
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

/**
 * `Api` (AXI-1400 harness) carries no `put`; the gateway's semantic-declaration route is the
 * one PUT this spec needs, so it is issued directly through the same `APIRequestContext` the
 * harness already exposes as `api.ctx`, at the SAME base URL every other call in this file uses.
 */
async function declareSemanticDeclaration(datasetId: string, declaration: unknown) {
  const res = await api.ctx.put(apiUrl(DECLARE_PATH(datasetId)), {
    data: { declaration },
    headers: t.headers,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length ? JSON.parse(text) : undefined;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status(), body: body as any };
}

test.describe('AXI-2410 column/level display labels @SI-068 @SI-014', () => {
  test.describe.configure({ timeout: 180_000, mode: 'serial' });

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

  test('AXI-2410.3a (AC58) a persisted displayLabels declaration reads back unchanged @SI-068 @SI-014', async () => {
    const declaration = {
      scopeRoles: [],
      displayLabels: {
        columns: { igg4_g_l: 'IgG4 (g/L)' },
        levels: { sexe: { F: 'Female', M: 'Male' } },
      },
    };
    const put = await declareSemanticDeclaration(ownDatasetId, declaration);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.record.declaration.displayLabels).toEqual(declaration.displayLabels);

    const get = await api.get(DECLARE_PATH(ownDatasetId), t.headers);
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    expect(get.body.declaration.displayLabels).toEqual(declaration.displayLabels);
  });

  test('AXI-2410.3b (EC7) a label naming a column that is not in the dataset is refused DECL_COLUMN_UNKNOWN @SI-068 @SI-014', async () => {
    const put = await declareSemanticDeclaration(ownDatasetId, {
      scopeRoles: [],
      displayLabels: { columns: { not_a_real_column: 'Whatever' } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(400);
    expect(put.body.errors).toContainEqual(
      expect.objectContaining({ field: 'displayLabels.columns', code: 'DECL_COLUMN_UNKNOWN' }),
    );
  });

  test('AXI-2410.3c (NFR11b, B2) an identifying level label skips the reading call: pinned skipped_identifying @SI-068 @SI-014', async () => {
    const put = await declareSemanticDeclaration(ownDatasetId, {
      scopeRoles: [],
      displayLabels: { levels: { sexe: { F: 'Jean Dupont', M: 'Male' } } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const res = await read(`Does igg4_g_l differ by sexe? ${randomUUID()}`, [fixtureSchema(ownDatasetId)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'skipped_identifying', ...NO_READING });
  });

  test('AXI-2410.3d (EC33, NFR3) a non-identifying label still reaches the call — pinned recording_missing, never a label fallback or a status drift @SI-068 @SI-014', async () => {
    const put = await declareSemanticDeclaration(ownDatasetId, {
      scopeRoles: [],
      displayLabels: {
        columns: { igg4_g_l: 'IgG4 (g/L)' },
        levels: { sexe: { F: 'Female', M: 'Male' } },
      },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const res = await read(`An unrecorded AXI-2410 question ${randomUUID()} about igg4_g_l and age?`, [
      fixtureSchema(ownDatasetId),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'recording_missing', ...NO_READING });
  });
});
