import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { OPENING_TEMPLATES_PATH } from '../AXI-2308/harness/opening-templates';
import { registryApiAs, type RegistryApi } from '../AXI-2422/harness/registry-api';

/**
 * AXI-2455 W5 step 3 — cross-story flow no single story owns (Workflow 5, 2026-11-26).
 *
 * The three surfaces that AXI-2455 changed in separate stories must agree on the SAME newest
 * version of every opening template, and that version must carry the main-result declaration the
 * SAP consumers read:
 *   registry (AXI-2457/2459/2461/2462/2463) -> wizard catalog (AXI-2469) -> SAP template catalog
 *   (AXI-2466/2467/2468, `isNewest`, `mainResult`, one-cell -> whole-matrix pointer).
 *
 * TPL FR58 FR60 AC26 AC28 AC25 AC22 · SAP FR72 FR73 FR74 AC39 AC40 · @SI-069 @SI-045 @SI-065 @SI-071
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § Epic (W5 cross-story).
 * Run: `npx playwright test tests/AXI-2455/epic-template-sap-wizard-seam.spec.ts --project=chromium`
 */

const EPIC_TAGS = { tag: ['@SI-069', '@SI-045', '@SI-065', '@SI-071'] };

let api: Api;
let t: Tenant;
let registry: RegistryApi;

function compareVersions(a: string, b: string): number {
  const [l, r] = [a.split('.'), b.split('.')];
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    const d = Number(l[i] ?? 0) - Number(r[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function publishedVersions(): Promise<Record<string, string[]>> {
  const list = await registry.list();
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return Object.fromEntries((list.body as any[]).map((e) => [e.templateId, e.versions]));
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  api = await adminApi();
  t = await ensureTenant(api);
  registry = await registryApiAs('user');
});

test.afterAll(async () => {
  await registry?.dispose();
  await api?.ctx.dispose();
});

test.describe('AXI-2455 epic — registry, wizard and SAP catalog agree on the newest template versions', EPIC_TAGS, () => {
  test('FR60 AC28 FR58 AC26 — epic-1: the wizard version, the registry newest and the SAP catalog `isNewest` are one version per template, and it declares a main result', async () => {
    const published = await publishedVersions();
    const wizard = await api.get(OPENING_TEMPLATES_PATH, t.headers);
    expect(wizard.status, JSON.stringify(wizard.body)).toBe(200);
    const sap = await api.get(`/api/v1/projects/${t.projectId}/sap-templates`, t.headers);
    expect(sap.status, JSON.stringify(sap.body)).toBe(200);

    for (const descriptor of wizard.body as any[]) {
      const id: string = descriptor.templateId;
      const newest = [...published[id]].sort(compareVersions).at(-1)!;
      expect(descriptor.version, `${id} wizard vs registry`).toBe(newest);
      const flagged = (sap.body as any[]).filter((e) => e.templateId === id && e.isNewest);
      expect(flagged.map((e) => e.templateVersion), `${id} SAP catalog isNewest`).toEqual([newest]);
      const resolved = await registry.resolve(id, newest);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.mainResult, `${id}@${newest} declares its main result`).toBeTruthy();
    }
  });

  test('FR58 FR59 EC28 — epic-2: the immutable older versions still resolve and declare no main result, while T2 has no one-sided newest', async () => {
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) {
      const old = await registry.resolve(id, '0.2');
      expect(old.status, `${id}@0.2 ${JSON.stringify(old.body)}`).toBe(200);
      expect(old.body, `${id}@0.2`).not.toHaveProperty('mainResult');
    }
    const published = await publishedVersions();
    expect(published.T2.includes('0.4'), 'T2 never gets a 0.4 (it takes no alternative)').toBe(false);
  });

  test('AC25 AC40 FR73 — epic-3: T3 and T5 newest declare a whole-matrix global_p main result and the SAP catalog points the one-cell pins at it', async () => {
    const sap = await api.get(`/api/v1/projects/${t.projectId}/sap-templates`, t.headers);
    expect(sap.status, JSON.stringify(sap.body)).toBe(200);
    for (const id of ['T3', 'T5']) {
      const entries = (sap.body as any[]).filter((e) => e.templateId === id);
      const whole = entries.find((e) => e.isNewest);
      expect(whole?.mainResult, `${id} newest`).toMatchObject({ pValueField: 'global_p', cellBound: false, source: 'declared' });
      const oneCell = entries.filter((e) => e.wholeMatrixMainResultVersion);
      expect(oneCell.length, `${id} has a one-cell pin naming the whole-matrix version`).toBeGreaterThan(0);
      for (const e of oneCell) expect(e.wholeMatrixMainResultVersion).toBe(whole.templateVersion);
    }
  });

  // Converted from `manual` (AXI-2484.2, W5 2026-11-26): its stated reason ("API-level probe with no UI") is not a
  // reason a Playwright API spec cannot run it; the wire behaviour is asserted here.
  test('AXI-2484.2 NFR1 — epic-4: a forged body key is refused at the wire (400 on an unlisted property, 403 on a foreign workspaceId)', async () => {
    const forged = '00000000-0000-4000-8000-0000000000aa';
    const patched = await api.patch(`/api/v1/view-analyses/${forged}`, { workspaceId: forged }, t.headers);
    expect(patched.status, JSON.stringify(patched.body)).toBe(400);
    expect(JSON.stringify(patched.body)).toContain('property workspaceId should not exist');

    const created = await api.post('/api/v1/dashboards', { name: 'AXI-2484 forged', purpose: 'probe', projectId: t.projectId, workspaceId: forged }, t.headers);
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    expect(JSON.stringify(created.body)).toContain('workspaceId does not match the verified workspace');
  });
});
