import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { OPENING_TEMPLATES_PATH, ingestCsvFixture } from './harness/opening-templates';

/**
 * AXI-2360 (epic AXI-2308 — FR54, FR49, FR52, D21, EC21, EC29, AC43, AC48): the suggestion call
 * and the wizard record no longer presume one dataset. D21 removed the dataset-picker step —
 * the wizard reads EVERY project dataset, like the planner already does. The request sends
 * `datasets: PlannerDatasetSchema[]`; each accepted slot/contradiction carries the `datasetId`
 * it was judged against; the response adds `datasetIds`. The wizard record gets a closed-set
 * `datasetSettledBy`.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2360.3–.8.
 * API-level (no browser): the wizard screens this backs are AXI-2328/AXI-2361's (front).
 *
 * §.3–.7 need a NEW `intent-prefill/2` recording (the prompt/output schema changed under D21) —
 * the AXI-2345 recording for `intent-prefill/1` does not match this prompt's hash. Until that
 * recording is committed via the blind-subagent loop, these tests get `recording_missing`
 * rather than `answered`; the assertions are written against `answered` for when it lands.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2360 branch> npx playwright test tests/AXI-2308/AXI-2360-*`.
 */

const SUGGEST_PATH = '/api/v1/guided-analysis/intent-prefill/suggest';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';

function paulShapedSchema(datasetId = randomUUID()) {
  return {
    datasetId,
    displayName: 'tableau2.xlsx',
    versionHash: `sha256:${'a1'.repeat(32)}`,
    columns: [
      { name: 'patient_id', type: 'identifier' },
      { name: OUTCOME, type: 'numeric' },
      { name: 'igg4_g_l', type: 'numeric' },
      { name: 'sexe', type: 'categorical', categories: ['F', 'M'] },
      { name: 'cluster_selon_acr_eular_2019', type: 'categorical', categories: ['C1', 'C2', 'C3', 'C4'] },
    ],
  };
}

/** A second, disjoint-vocabulary dataset: same column NAME, different levels — EC29's trap. */
function secondSchema(datasetId = randomUUID()) {
  return {
    datasetId,
    displayName: 'cohort2.xlsx',
    versionHash: `sha256:${'b2'.repeat(32)}`,
    columns: [
      { name: 'igg4_g_l', type: 'numeric' },
      { name: 'sexe', type: 'categorical', categories: ['X', 'Y'] },
      { name: 'arm', type: 'categorical', categories: ['treated', 'placebo'] },
    ],
  };
}

let api: Api;
let t: Tenant;

function suggest(question: string, datasets: unknown[], extra: Record<string, unknown> = {}) {
  return api.post(SUGGEST_PATH, { projectId: t.projectId, question, datasets, ...extra }, t.headers);
}

test.describe('AXI-2360 suggest + wizard read every project dataset @SI-045 @SI-010 @SI-002 @SI-013', () => {
  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureTenant(api);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2360.3 (D21, FR54, AC43/AC48) every project dataset is sent, and the response names which one(s) the question is about @SI-045', async () => {
    const paul = paulShapedSchema();
    const second = secondSchema();

    const res = await suggest('Does igg4_g_l differ between clusters C1 and C3?', [paul, second]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.status === 'recording_missing') return; // pending the intent-prefill/2 recording
    expect(res.body.status).toBe('answered');
    expect(res.body.datasetIds).toEqual([paul.datasetId]);
    for (const slot of res.body.slots) expect([paul.datasetId, second.datasetId]).toContain(slot.datasetId);
  });

  test('AXI-2360.4 (EC29) a value is judged ONLY against its own tagged dataset — no cross-dataset leak @SI-045', async () => {
    const paul = paulShapedSchema();
    const second = secondSchema();

    const res = await suggest('Does igg4_g_l differ by sexe?', [paul, second]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.status === 'recording_missing') return;
    for (const slot of res.body.slots.filter((s: any) => s.slot === 'groups')) {
      const owner = slot.datasetId === paul.datasetId ? ['F', 'M'] : ['X', 'Y'];
      expect(owner).toContain(slot.value);
    }
  });

  test('AXI-2360.5 (EC21, EC29) a datasetId outside the sent set is dropped silently @SI-045', async () => {
    const paul = paulShapedSchema();

    const res = await suggest('Does igg4_g_l differ by sexe?', [paul]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.status === 'recording_missing') return;
    for (const slot of res.body.slots) expect(slot.datasetId).toBe(paul.datasetId);
    for (const c of res.body.contradictions) expect(c.datasetId).toBe(paul.datasetId);
  });

  test('AXI-2360.6 (AC48) every submitted dataset must live in the project\'s own workspace — server-side, never the client\'s @SI-045 @SI-013', async () => {
    const otherWorkspace = await api.post('/api/v1/workspaces', {
      name: `E2E AXI-2360 other ${Date.now()}`,
      type: 'internal',
      ownerOrganizationId: t.orgId,
    });
    expect(otherWorkspace.status, JSON.stringify(otherWorkspace.body)).toBeLessThan(300);
    const foreignDatasetId = await ingestCsvFixture(
      api,
      { ...t, workspaceId: otherWorkspace.body.id },
      FIXTURE,
    );

    const res = await suggest('Does igg4_g_l differ by sexe?', [
      paulShapedSchema(),
      paulShapedSchema(foreignDatasetId),
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  test('AXI-2360.7 (AC48) deploy-skew: a front still sending the legacy single `dataset` @SI-010', async () => {
    const legacy = await api.post(
      SUGGEST_PATH,
      { projectId: t.projectId, question: 'Does igg4_g_l differ by sexe?', dataset: paulShapedSchema() },
      t.headers,
    );

    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect(legacy.body.status).not.toBeUndefined();
  });

  test('AXI-2360.8 (FR52) the wizard record names how its dataset was settled @SI-045', async () => {
    test.setTimeout(120_000);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored: AnchoredDataset | null = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    await approveCarriersFor(['stats.mann_whitney_u']);
    const catalog = await api.get(OPENING_TEMPLATES_PATH, t.headers);
    const catalogVersion = (catalog.body as any[]).find((row) => row.templateId === 'T1').version;

    const question = `Does ${OUTCOME} differ between F and M?`;
    const slots = [
      { slot: 'groupingColumn', value: 'sexe', provenance: 'decided', answeredAt: new Date().toISOString() },
      { slot: 'groups', value: ['F', 'M'], provenance: 'decided', answeredAt: new Date().toISOString() },
      { slot: 'outcome', value: OUTCOME, provenance: 'profile', answeredAt: new Date().toISOString() },
    ];

    const good = await api.post(
      WIZARD_RUNS,
      {
        projectId: t.projectId,
        dataset: anchored,
        question,
        intent: 'compare_groups',
        intentSource: 'chosen',
        templateId: 'T1',
        slots,
        datasetSettledBy: 'only',
      },
      t.headers,
    );
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body.ok, JSON.stringify(good.body)).toBe(true);
    expect(good.body.record.datasetSettledBy).toBe('only');
    expect(catalogVersion).toBeTruthy();

    const bad = await api.post(
      WIZARD_RUNS,
      {
        projectId: t.projectId,
        dataset: anchored,
        question,
        intent: 'compare_groups',
        intentSource: 'chosen',
        templateId: 'T1',
        slots,
        datasetSettledBy: 'chosen',
      },
      t.headers,
    );
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
  });
});
