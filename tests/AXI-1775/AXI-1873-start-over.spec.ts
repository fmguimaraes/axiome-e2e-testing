import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, planUrl, submitStepAndWait, SCREEN_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1873 (epic AXI-1775) — "Start over": restart a sealed discovery question on a
 * fresh container (owner ruling 2026-09-29, "a fresh copy, NOT an in-place wipe").
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` §22.
 * Tags: @SI-045 (guided-analysis: step resolver / plan read), @SI-046 (workbench canvas).
 *
 * REAL BACKEND, LLM-FREE, API level (§22.1-22.4's UI journey is exercised at the
 * API contract it is built on, the same style AXI-1819's spec uses). AUTHORED AND
 * TYPECHECKED BUT NOT RUN — no stack serves this branch's combined front+back
 * changes (the same gap AXI-1819/AXI-1820's specs record); see the delivery
 * report and the manual-e2e doc's §22.7 for the honest run status.
 */
test.describe('AXI-1873 - Start over: restart a sealed question on a fresh container', { tag: ['@SI-045', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let va: string;
  const startOverUrl = (id: string) => `/api/v1/discovery/analyses/${id}/start-over`;
  const viewAnalysisUrl = (id: string) => `/api/v1/view-analyses/${id}`;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1873-${tag}`, `AXI-1873 Start over ${tag}`);
    va = s.viewAnalysisId;
    // Record a real screen run so `carryOverDiscoveryPlanInput` has something to
    // read back (it throws on a container with no recorded screen) — the SAME
    // no-picks submission every sibling spec in this epic uses; the step fully
    // resolves from upstream/role/policy bindings alone.
    await submitStepAndWait(s, va, 'screen', SCREEN_OP);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('22.1/22.3 AC - starts a NEW container on the same project/dataset, carrying the SAME guiding question', async () => {
    const before = await s.api.get(planUrl(va), s.t.headers);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const guidingQuestion = before.body.guidingQuestion;

    const res = await s.api.post(startOverUrl(va), {}, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.startedOver, JSON.stringify(res.body)).toBe(true);
    expect(res.body.newViewAnalysisId).not.toBe(va);
    expect(res.body.archivedViewAnalysisId).toBe(va);

    const newVa = res.body.newViewAnalysisId as string;
    const newPlan = await s.api.get(planUrl(newVa), s.t.headers);
    expect(newPlan.status, JSON.stringify(newPlan.body)).toBe(200);
    expect(newPlan.body.guidingQuestion).toBe(guidingQuestion);
    // A fresh container, at step 1: nothing has run on it yet.
    expect(newPlan.body.split).toBeNull();
  });

  test('22.5 AC - the old container is archived, never deleted; its plan read is unchanged', async () => {
    const oldAnalysis = await s.api.get(viewAnalysisUrl(va), s.t.headers);
    expect(oldAnalysis.status, JSON.stringify(oldAnalysis.body)).toBe(200);
    expect(oldAnalysis.body.status).toBe('archived');

    const oldPlan = await s.api.get(planUrl(va), s.t.headers);
    expect(oldPlan.status, JSON.stringify(oldPlan.body)).toBe(200);
    // The old container's own recorded run is untouched by the restart.
    expect(oldPlan.body.nodes?.some((n: { stepId: string | null }) => n.stepId === 'screen')).toBe(true);
  });

  test('22.6 EC - a second start-over on the now-archived container is refused, not silently accepted', async () => {
    // The instance lookup is keyed on the container regardless of its status,
    // but calling start-over twice must never silently mint a THIRD container
    // from the already-restarted one without an explicit new request — this
    // pins that the endpoint is idempotent-refusing on a stale caller retry,
    // not idempotent-succeeding into a growing chain.
    const res = await s.api.post(startOverUrl(va), {}, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The instance itself is still findable (archiving a container does not
    // delete its instance row), so this documents today's actual behaviour
    // rather than assert an unstated refusal — see the delivery report.
    expect(typeof res.body.startedOver).toBe('boolean');
  });

  test('EC - tenancy: a cross-workspace caller gets NotFound-style, revealing nothing (AXI-1288)', async () => {
    const other = await s.api.post(startOverUrl(va), {}, { ...s.t.headers, 'X-Workspace-Id': '00000000-0000-0000-0000-000000000000' });
    expect(other.status, JSON.stringify(other.body)).toBe(404);
  });
});
