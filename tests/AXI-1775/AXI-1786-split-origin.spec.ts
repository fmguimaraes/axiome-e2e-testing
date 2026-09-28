import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, declineHoldoutUrl, type Seeded } from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1786 - Split origin and source recording (epic AXI-1775, FR4, NFR1; AC3 origin half;
 * ruling OC1(b)).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 8.
 * Tags: @SI-017 (cohort-splits: the recorded origin), @SI-002 (the additive read members).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call.
 *
 * What is automated here is what the harness can reach TODAY: the additive members never
 * leak onto a split that has no taken holdout (undecided, declined), and AXI-1760's `split`
 * member is unchanged (NFR1). A TAKEN split cannot be produced by the Riaz fixture under the
 * governed minimums the harness declares (5 per class, 30 % holdout -> REFUSED, the AXI-1507
 * spec's own assertion), and an IMPORTED split has no ingestion surface (OC1, out of scope):
 * scenarios 8.1, 8.2 and 8.5 are `manual` with the reason stated in the scenario file.
 */
const planUrl = (va: string) => `/api/v1/discovery/analyses/${va}/plan`;
const ADDED = ['origin', 'sourceReference', 'stratumColumn'];

test.describe('AXI-1786 - split origin on the plan read (API, real backend)', { tag: ['@SI-017', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1786-${tag}`, `AXI-1786 Split origin ${tag}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC3 NFR1 (8.4) - an undecided question states no split and no origin on any branch', async () => {
    const res = await s.api.get(planUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveProperty('split', null);
    for (const branch of res.body.branches) expect(branch.split, JSON.stringify(branch)).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('"sourceReference"');
    expect(JSON.stringify(res.body)).not.toContain('"stratumColumn"');
  });

  test('AC3 NFR1 (8.3) - a declined holdout carries no origin, source or stratum, and AXI-1760\'s split member is unchanged', async () => {
    const reason = 'axi-1786: declined, nothing drawn or imported';
    const declined = await s.api.post(declineHoldoutUrl(s.declaredAnalysisId, 'split'), { reason }, s.t.headers);
    expect(declined.body.declined, JSON.stringify(declined.body)).toBe(true);
    const res = await s.api.get(planUrl(s.declaredAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.split).toMatchObject({ decision: 'declined', declineReason: reason });
    const [b1] = res.body.branches;
    expect(b1.split).toMatchObject({ decision: 'declined', declineReason: reason });
    for (const member of ADDED) {
      expect(res.body.split, `AXI-1760 split gains no ${member}`).not.toHaveProperty(member);
      expect(b1.split, `a declined split states no ${member}`).not.toHaveProperty(member);
    }
  });
});
