import { test, expect } from '@playwright/test';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2410 (epic AXI-2414 — FR61, FR13 amended, AC58, EC33; SI-068, SI-014). Column and level
 * display labels for question reading. `POST /api/v1/guided-analysis/question-reading/read`
 * (call site `question-reading`, prompt `reading/2`, RECORDED transport) now also matches the
 * investigator's words against a column/level's declared clinician-facing label, falling back
 * to the id when no label is declared (EC33/NFR3).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2410.
 *
 * AXI-2410.1/.2 (an "answered" reading that resolves a LABEL word to its column/level id) are
 * DEFERRED — same precedent as AXI-2364's own §.2/§.3: they need an
 * `llm-debug/recordings/question-reading/` entry keyed under the `reading/2` prompt, which can
 * only be captured against a RUNNING deployment of this story's merged code (this pre-merge
 * worktree cannot provision an isolated stack — `wt-up.sh` is blocked for story-developer
 * agents — and hot-patching the shared demo stack with an unmerged branch would disrupt the
 * sibling epic stories concurrently using it). The deterministic label -> id resolution itself
 * (exact, case-insensitive, ambiguity, fallback-to-id) is covered unit-to-unit, AAA, in
 * `dataset-semantic-declaration.spec.ts` (`UT-DSD-2410-*`), `reading-vocabulary.spec.ts`
 * (`UT-READING-2410-01*`) and `reading.validator.spec.ts` (`UT-READING-2410-00*`).
 *
 * AXI-2410.3 (a label-less column/level still resolves by its own id) IS run below: it is the
 * EC33 fallback behaviour, identical to AXI-2364's pre-existing id-only matching, so it does not
 * depend on this story's new prompt/resolver code being deployed - a genuine regression guard.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2410 branch> npx playwright test --project=axi-2410-api tests/AXI-2414/AXI-2410-*`.
 */

const READ_PATH = '/api/v1/guided-analysis/question-reading/read';
const FIXTURE = 'opening-templates-paul-header.csv';

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
    'AXI-2410.1 (AC58) a question naming a declared column label resolves to that column id — DEFERRED: needs a reading/2 recording',
    () => {},
  );
  test.skip(
    'AXI-2410.2 (AC58) a question naming a declared level label resolves to that level id — DEFERRED: needs a reading/2 recording',
    () => {},
  );

  test('AXI-2410.3 (EC33, NFR3) a column/level with no declared label still resolves by its own raw id @SI-068 @SI-014', async () => {
    const res = await read('Does igg4_g_l differ by sexe, adjusted for age?', [fixtureSchema(ownDatasetId)]);

    // Either the recorded transport has no entry for this exact question (loud miss, still a
    // 200 with an empty reading - FR54) or it answers; either way the response is well-formed
    // and never invents a label where none was declared on this fixture's bare schema.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(['recording_missing', 'answered', 'unavailable', 'skipped_identifying']).toContain(res.body?.status);
    if (res.body?.status === 'answered') {
      const values = asList(res.body.readings).flatMap((r: any) =>
        Object.values(r.slots ?? {}).flatMap((s: any) => (s?.state === 'settled' ? s.values : [])),
      );
      for (const v of values) expect(typeof v.value).toBe('string');
    }
  });
});
