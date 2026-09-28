import { test, expect } from '@playwright/test';
import { adminApi, asList, workspaceHeader, type Api } from '../AXI-1400/harness/api';

/**
 * AXI-1788 - Screening policy keys in AnalysisPolicy (epic AXI-1775: FR11, NFR1, AC4, EC4; OC2 ruled (b)).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 9.
 * Tags: @SI-017 (analysis-policy catalogue, stale listing, write validation), @SI-002 (additive
 * `guardBackings` on the discovery config read).
 *
 * REAL BACKEND, LLM-FREE, API level. Runs in a DEDICATED workspace so that authoring a policy never moves
 * the approval hash of the shared validation workspace the other discovery specs instantiate plans in.
 * Every policy version is a whole-entries replacement (append-only); the afterAll re-states split-only.
 */
const SCREEN = 'stats.screen_shortlist';
const SPLIT = 'split.exploration_holdout';
const ORG = 'Axiome Validation Org';
const WORKSPACE = 'AXI-1788 Screening Policy Validation';
const entry = (value: unknown) => ({ value, locked: false });
const SPLIT_ONLY = {
  [SPLIT]: { holdoutRatio: entry(0.3), minPatientsPerArm: entry(20), minPatientsPerClass: entry(5) },
};

async function idByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: { name?: string }) => x.name === name)?.id;
}

async function ensureWorkspace(api: Api): Promise<string> {
  const orgId =
    (await idByName(api, '/api/v1/organizations', ORG)) ??
    (await api.post('/api/v1/organizations', { name: ORG, type: 'biotech' })).body.id;
  const existing = await idByName(api, '/api/v1/workspaces', WORKSPACE);
  if (existing) return existing;
  const res = await api.post('/api/v1/workspaces', { name: WORKSPACE, type: 'internal', ownerOrganizationId: orgId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

test.describe('AXI-1788 - screening policy keys (API, real backend)', { tag: ['@SI-017', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let api: Api;
  let ws: string;
  let headers: Record<string, string>;
  const policyUrl = () => `/api/v1/workspaces/${ws}/analysis-policy`;
  const author = async (entries: unknown) => {
    const res = await api.post(policyUrl(), { entries }, headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const config = async () => {
    const res = await api.get('/api/v1/discovery/config', headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const entryOf = (cfg: any, key: string) => cfg.entries.find((e: any) => e.key === key);

  test.beforeAll(async () => {
    api = await adminApi();
    ws = await ensureWorkspace(api);
    headers = workspaceHeader(ws);
  });
  test.afterAll(async () => {
    if (api && ws) await api.post(policyUrl(), { entries: SPLIT_ONLY }, headers);
    await api?.ctx.dispose();
  });

  test('AC4 EC4 FR11 - unstated screening keys read undeclared (awaiting approval), never the registry default', async () => {
    await author(SPLIT_ONLY);
    const cfg = await config();
    for (const param of ['defaultProcedure', 'correctionMethod', 'alpha']) {
      expect(entryOf(cfg, `${SCREEN}.${param}`), param).toMatchObject({
        origin: 'undeclared',
        value: null,
        awaitingConfirmation: false,
      });
    }
    expect(cfg.guardBackings).toEqual([
      {
        guard: 'screen_min_per_group',
        operationId: SCREEN,
        key: `${SPLIT}.minPatientsPerClass`,
        value: 5,
        origin: 'customer_config',
        appliedToRuns: true,
      },
    ]);
  });

  test('AC4 FR11 - authored screening keys and the per-class minimum read from the policy', async () => {
    await author({
      [SPLIT]: { ...SPLIT_ONLY[SPLIT], minPatientsPerClass: entry(6) },
      [SCREEN]: {
        defaultProcedure: entry(SCREEN),
        correctionMethod: entry('benjamini_hochberg'),
        alpha: entry(0.1),
      },
    });
    const cfg = await config();
    expect(entryOf(cfg, `${SCREEN}.defaultProcedure`)).toMatchObject({ origin: 'customer_config', value: SCREEN });
    expect(entryOf(cfg, `${SCREEN}.correctionMethod`)).toMatchObject({
      origin: 'customer_config',
      value: 'benjamini_hochberg',
    });
    expect(entryOf(cfg, `${SCREEN}.alpha`)).toMatchObject({ origin: 'customer_config', value: 0.1 });
    expect(cfg.guardBackings[0]).toMatchObject({ value: 6, origin: 'customer_config', appliedToRuns: true });
  });

  test('FR11 - an out-of-vocabulary correction or procedure is refused and the policy does not advance', async () => {
    const before = (await api.get(policyUrl(), headers)).body?.version ?? null;
    const bad = await api.post(
      policyUrl(),
      { entries: { ...SPLIT_ONLY, [SCREEN]: { correctionMethod: entry('bonferroni'), defaultProcedure: entry('x') } } },
      headers,
    );
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(JSON.stringify(bad.body)).toContain(`${SCREEN}.correctionMethod`);
    expect(JSON.stringify(bad.body)).toContain(`${SCREEN}.defaultProcedure`);
    const after = (await api.get(policyUrl(), headers)).body?.version ?? null;
    expect(after).toBe(before);
  });

  test('FR11 PF9 (AXI-1787 A1) - catalogue entries are not listed as stale; a genuine unknown parameter still is', async () => {
    await author({
      ...SPLIT_ONLY,
      [SCREEN]: { defaultProcedure: entry(SCREEN), correctionMethod: entry('benjamini_hochberg') },
      candidate_application: { sensitivityMin: entry(0.5), retiredBound: entry(1) },
      'cutoff.declared_value': { literature: entry(3) },
    });
    const res = await api.get(`${policyUrl()}/stale-entries`, headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([
      { operationId: 'candidate_application', parameterKey: 'retiredBound', reason: 'unknown_parameter' },
    ]);
  });

  test('NFR1 AC11 - the approval hash is unchanged by unstated keys and by alpha; a stated correction moves it', async () => {
    await author(SPLIT_ONLY);
    const base = (await config()).configHash;
    await author({ ...SPLIT_ONLY, [SCREEN]: { alpha: entry(0.1) } });
    expect((await config()).configHash).toBe(base);
    await author({ ...SPLIT_ONLY, [SCREEN]: { alpha: entry(0.01) } });
    expect((await config()).configHash).toBe(base);
    await author({ ...SPLIT_ONLY, [SCREEN]: { correctionMethod: entry('benjamini_hochberg') } });
    expect((await config()).configHash).not.toBe(base);
  });
});
