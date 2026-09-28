import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, stepUrl, waitForNode, SCREEN_OP, type Seeded } from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1789 (min-n leg) - the screen's n-per-group minimum read from the approved policy
 * (epic AXI-1775: FR11, FR9, NFR1, NFR2; OC2 ruled (b): `split.exploration_holdout.minPatientsPerClass`
 * backs the screen's discovery n-per-group guard).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 10.
 * Tags: @SI-017 (analysis-policy: the guard backing), @SI-002 (contract: `guardBackings[].appliedToRuns`),
 *       @SI-045 (guided-analysis: the resolver binds `minPerGroup`), @SI-021 (bio-compute: the screen's floor).
 *
 * REAL BACKEND, LLM-FREE, API level. Seeded through the AXI-1722 live-workbench harness, whose
 * `ensureApprovedDiscoveryConfig` states and approves `minPatientsPerClass = 5`. Needs a stack on the
 * AXI-1789b-min-n branches of axiome-back AND axiome-bio-compute (screening pin 1.1.0 on both sides);
 * a stack off the branch FAILS here (appliedToRuns false / no binding / pin mismatch), never skips.
 *
 * Scenarios 10.4 (unstated / unapproved -> nothing sent, compute default 3) and 10.5 (a malformed
 * minimum refused) are `manual` in the doc: they need a workspace whose approved config does NOT
 * state the key - which `minPatientsPerClass` (blocksInstantiation) makes unreachable through the
 * product - or a hand-built dispatch payload. Both are unit-proven (UT-GUIDED-1789-910..913,
 * UT-BC-PIPE-1789-900..902, UT-BC-IO-1789-920/921).
 */
const KEY = 'split.exploration_holdout.minPatientsPerClass';
const POLICY_TAG = `policy:${KEY}`;
const LABEL = `axi-1789-${Date.now().toString(36)}`;

test.describe('AXI-1789 - the screen minimum from policy (API, real backend)', { tag: ['@SI-017', '@SI-002', '@SI-045', '@SI-021'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  const resolveScreen = (body: Record<string, unknown> = {}) =>
    s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), { operationId: SCREEN_OP, datasetId: s.datasetId, ...body }, s.t.headers);

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    s = await seedLiveWorkbench(LABEL, 'AXI-1789 Min-N Override');
  });
  test.afterAll(async () => {
    await s?.api.ctx.dispose();
  });

  test('10.1 FR11 AC4 - the discovery config reports the n-per-group backing as APPLIED to runs', async () => {
    const res = await s.api.get('/api/v1/discovery/config', s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.guardBackings).toEqual([
      { guard: 'screen_min_per_group', operationId: SCREEN_OP, key: KEY, value: 5, origin: 'customer_config', appliedToRuns: true },
    ]);
  });

  test('10.2 FR11 FR9 - the screen resolves minPerGroup = 5 from the approved key; a client pick cannot reach it', async () => {
    const res = await resolveScreen();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ nodeId: 'd6', fullyBound: true, unresolved: [] });
    const floor = res.body.bindings.filter((b: any) => b.name === 'minPerGroup');
    expect(floor).toEqual([{ name: 'minPerGroup', slot: 'param', value: 5, source: POLICY_TAG, sourceKind: 'policy' }]);

    const picked = await resolveScreen({ picks: { minPerGroup: 1 } });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    expect(picked.body.bindings.filter((b: any) => b.name === 'minPerGroup')).toEqual(floor);
  });

  test('10.3 FR11 FR9 NFR1 - the submitted screen records the policy source and its table never cites the fallback 3', async () => {
    const res = await s.api.post(
      stepUrl(s.viewAnalysisId, 'screen', 'submit'),
      { operationId: SCREEN_OP, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash },
      s.t.headers,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
    expect(res.body.bindingSources).toMatchObject({ minPerGroup: POLICY_TAG });

    const { node, status } = await waitForNode(s, res.body.runId, res.body.nodeId);
    expect(node.status, `screen node: ${JSON.stringify(node)} / run ${status.status} ${status.failReason ?? ''}`).toMatch(/SUCCEEDED|REUSED/);
    expect(node.bindingSources, 'FR9 on the status projection').toEqual(res.body.bindingSources);
    expect(status.ruleRunId, 'the screen produced a rule run (its table)').toBeTruthy();

    const table = await s.api.get(`/api/v1/rule-runs/${status.ruleRunId}/table?page=1&limit=50`, s.t.headers);
    expect(table.status, JSON.stringify(table.body)).toBe(200);
    const reasons: string[] = table.body.rows.map((r: any) => r.reason).filter((r: unknown): r is string => typeof r === 'string');
    // Riaz has >= 5 per arm, so no row is refused on size (the refusal half is vacuous on this fixture,
    // and stated so in the scenario doc). What must NEVER appear is the compute fallback's wording.
    for (const reason of reasons) expect(reason).not.toContain('fewer than 3 values');
    for (const reason of reasons.filter((r) => r.startsWith('insufficient observations'))) expect(reason).toContain('fewer than 5 values');
  });
});
