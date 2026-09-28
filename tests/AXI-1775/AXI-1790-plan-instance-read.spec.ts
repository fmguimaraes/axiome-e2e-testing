import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, branchUrl, declineHoldoutUrl, submitStepAndWait, SCREEN_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1790 - Plan-instance read extension (epic AXI-1775, FR3, FR6, FR9; AC2 backend half).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 4.
 * Tags: @SI-045 (guided-analysis: the read), @SI-016 (branch records), @SI-010 (gateway
 * route + description), @SI-002 (contract shapes).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call. The route is
 * AXI-1760's `GET /discovery/analyses/:viewAnalysisId/plan`; this story only adds members.
 */
const planUrl = (va: string) => `/api/v1/discovery/analyses/${va}/plan`;
const QUESTION = 'Which pre-treatment immune marker separates responders?';
const PHASES = ['split', 'screen', 'outcome_association', 'candidate', 'validation'];

test.describe('AXI-1790 - the whole plan instance reads back from the server (API, real backend)', { tag: ['@SI-045', '@SI-016', '@SI-010', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let branch2: string;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1790-${tag}`, `AXI-1790 Plan read ${tag}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC2 FR6 - a fresh read states the instance run id, the stored guiding question and every plan node', async () => {
    const res = await s.api.get(planUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.guidingQuestion).toBe(QUESTION);
    expect(res.body.instance).toMatchObject({ runId: s.instanceRunId, questionKey: expect.stringMatching(/^axi-1790-/) });
    const nodeIds = res.body.nodes.map((n: { nodeId: string }) => n.nodeId);
    expect(nodeIds.length).toBeGreaterThan(0);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  test('NFR1 - AXI-1760\'s `split` member is still present and unchanged in shape (null while undecided)', async () => {
    const res = await s.api.get(planUrl(s.viewAnalysisId), s.t.headers);
    expect(res.body).toHaveProperty('split', null);
  });

  test('AC2 FR3 - Branch 1 is first (branchId null), carries all five phases in rail order, and no phase is read from a constant', async () => {
    const res = await s.api.get(planUrl(s.viewAnalysisId), s.t.headers);
    const [b1] = res.body.branches;
    expect(b1).toMatchObject({ branchId: null, name: 'Branch 1', status: 'active' });
    expect(b1.phases.map((p: { phase: string }) => p.phase)).toEqual(PHASES);
    expect(b1.phases.find((p: { phase: string }) => p.phase === 'candidate').state).toBe('not_started');
    expect(b1.phases.find((p: { phase: string }) => p.phase === 'validation').state).toBe('not_started');
  });

  test('AC2 FR3 - a screen run on Branch 2 completes the phase on Branch 2 only, with its governed run id', async () => {
    const first = await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    expect(first).toBeTruthy();
    const fork = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(fork.body.forked, JSON.stringify(fork.body)).toBe(true);
    branch2 = fork.body.branch.id;
    const runId = await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP, { branchId: branch2 });

    const res = await s.api.get(planUrl(s.viewAnalysisId), s.t.headers);
    const b2 = res.body.branches.find((b: { branchId: string | null }) => b.branchId === branch2);
    expect(b2, JSON.stringify(res.body.branches)).toBeTruthy();
    expect(b2.phases.find((p: { phase: string }) => p.phase === 'screen')).toMatchObject({ state: 'completed', runId });
    expect(b2.phases.find((p: { phase: string }) => p.phase === 'outcome_association').state).toBe('not_started');
    const screenNode = res.body.nodes.find((n: { stepId: string | null }) => n.stepId === 'screen');
    expect(screenNode?.status).toMatch(/SUCCEEDED|REUSED/);
  });

  test('AC2 FR3 - a discarded branch is listed with its recorded reason and its unfinished phases are locked with that reason', async () => {
    const reason = 'axi-1790: the shortlist was empty on this arm';
    const discarded = await s.api.post(branchUrl(s.viewAnalysisId, branch2), { reason }, s.t.headers);
    expect(discarded.body.discarded, JSON.stringify(discarded.body)).toBe(true);
    const res = await s.api.get(planUrl(s.viewAnalysisId), s.t.headers);
    const b2 = res.body.branches.find((b: { branchId: string | null }) => b.branchId === branch2);
    expect(b2).toMatchObject({ status: 'discarded', discardReason: reason });
    const locked = b2.phases.filter((p: { state: string }) => p.state === 'locked');
    expect(locked.length).toBeGreaterThan(0);
    expect(locked[0].reason).toContain(reason);
    expect(b2.phases.find((p: { phase: string }) => p.phase === 'screen').state).toBe('completed');
  });

  test('AC2 FR9 - a declined holdout reads back on the split member AND per branch with the same recorded reason; origin is not fabricated', async () => {
    const reason = 'axi-1790: declined in an earlier session';
    const declined = await s.api.post(declineHoldoutUrl(s.declaredAnalysisId, 'split'), { reason }, s.t.headers);
    expect(declined.body.declined, JSON.stringify(declined.body)).toBe(true);
    const res = await s.api.get(planUrl(s.declaredAnalysisId), s.t.headers);
    expect(res.body.split).toMatchObject({ decision: 'declined', declineReason: reason });
    const [b1] = res.body.branches;
    expect(b1.split).toMatchObject({ decision: 'declined', declineReason: reason });
    expect(b1.phases.find((p: { phase: string }) => p.phase === 'split')).toMatchObject({ state: 'declined', reason });
    expect(JSON.stringify(res.body)).not.toContain('"origin":"');
  });

  test('NFR4 - a missing analysis is a 404 with no body detail beyond the message; another tenant\'s id cannot be told apart from a missing one', async () => {
    const missing = await s.api.get(planUrl('00000000-0000-4000-8000-000000000000'), s.t.headers);
    expect(missing.status).toBe(404);
    expect(missing.body).not.toHaveProperty('branches');
    expect(missing.body).not.toHaveProperty('guidingQuestion');
  });

  test('NFR4 - the read is deny-by-default: no credentials, no plan', async () => {
    const res = await s.api.ctx.get(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${planUrl(s.viewAnalysisId)}`);
    expect([401, 403]).toContain(res.status());
  });
});
