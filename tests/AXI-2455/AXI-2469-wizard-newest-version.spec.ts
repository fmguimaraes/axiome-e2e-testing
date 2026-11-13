import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { OPENING_TEMPLATES_PATH, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { registryApiAs, type RegistryApi } from '../AXI-2422/harness/registry-api';

/**
 * AXI-2469 (epic AXI-2455; TPL FR60, FR7, EC29, AC28; owner ruling 9; @SI-045 @SI-069).
 * The guided wizard compiles each opening template at the NEWEST registry version that is
 * published and neither archived nor invalidated, resolved at use — never at the hard-coded
 * `0.2`. The wizard catalog names that version, the Run records it, and a stored pin at `0.2`
 * still resolves exactly `0.2`.
 *
 * Fixture: `opening-templates-paul-header.csv` (reused from AXI-2308).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2469.
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2469-*`
 * Authored, NOT run against the demo stack — owner override (no e2e runs for epic AXI-2455).
 * AXI-2469.4 (EC29, archive / invalidate the newest) is `manual`: see the scenario doc.
 */

const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const QUESTION = `Does ${OUTCOME} differ between F and M?`;

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let registry: RegistryApi;

/** Segment-by-segment numeric version order (`0.10` > `0.9`), as the registry orders versions. */
function compareVersions(a: string, b: string): number {
  const [left, right] = [a.split('.'), b.split('.')];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const order = Number(left[i] ?? 0) - Number(right[i] ?? 0);
    if (order !== 0) return order;
  }
  return 0;
}

const newestOf = (versions: string[]) => [...versions].sort(compareVersions).at(-1);

async function catalog(): Promise<any[]> {
  const res = await api.get(OPENING_TEMPLATES_PATH, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as any[];
}

async function publishedVersions(): Promise<Record<string, string[]>> {
  const list = await registry.list();
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return Object.fromEntries((list.body as any[]).map((e) => [e.templateId, e.versions]));
}

function t1Run() {
  const at = new Date().toISOString();
  return {
    projectId: t.projectId,
    dataset,
    question: QUESTION,
    intent: 'compare_groups',
    intentSource: 'chosen',
    templateId: 'T1',
    slots: [
      { slot: 'groupingColumn', value: 'sexe', provenance: 'decided', answeredAt: at },
      { slot: 'groups', value: ['F', 'M'], provenance: 'decided', answeredAt: at },
      { slot: 'outcome', value: OUTCOME, provenance: 'decided', answeredAt: at },
    ],
  };
}

test.describe.serial('AXI-2469 wizard compiles at the newest registry version @SI-045 @SI-069', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    registry = await registryApiAs('user');
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
  });

  test.afterAll(async () => {
    await registry?.dispose();
    await api?.ctx.dispose();
  });

  test('AC28 FR60 AXI-2469.1 — the wizard catalog names each template at its newest published version, never the hard-coded 0.2', async () => {
    const [listed, published] = [await catalog(), await publishedVersions()];

    for (const descriptor of listed) {
      const versions = published[descriptor.templateId];
      expect(versions, descriptor.templateId).toBeDefined();
      expect(descriptor.version, descriptor.templateId).toBe(newestOf(versions));
    }
    const byId = Object.fromEntries(listed.map((d) => [d.templateId, d.version]));
    // AXI-2461/2462/2463 seeded T1/T3/T4/T5 at 0.4 and T2 at 0.3.
    expect(byId).toMatchObject({ T1: '0.4', T2: '0.3', T3: '0.4', T4: '0.4', T5: '0.4' });
  });

  test('AC28 FR60 AXI-2469.2 — a wizard Run compiles at that newest version and records it on the wizard record', async () => {
    const newest = (await catalog()).find((d) => d.templateId === 'T1').version;

    const res = await api.post(WIZARD_RUNS, t1Run(), t.headers);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.record).toMatchObject({ templateId: 'T1', templateVersion: newest });
    expect(newest).not.toBe('0.2');
  });

  test('AC28 FR7 AXI-2469.3 — a stored pin at 0.2 still resolves exactly 0.2 while a newer version is published', async () => {
    const pinned = await registry.resolve('T1', '0.2');

    expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
    expect(pinned.body).toMatchObject({ templateId: 'T1', templateVersion: '0.2', recipeKey: 'T1' });
    expect(newestOf((await publishedVersions()).T1)).not.toBe('0.2');
  });
});
