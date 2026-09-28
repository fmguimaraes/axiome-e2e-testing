import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, branchUrl, stepUrl, submitStepAndWait, SCREEN_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1785 - Branch identity on governed records, per-branch refusals (epic AXI-1775).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 3.
 * Tags: @SI-045 (guided-analysis: the step submit + branch guard), @SI-017 (cohort-splits),
 * @SI-015 (candidate/validation records), @SI-013 (Prisma migration).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call. Same seed as
 * AXI-1725 (Riaz 2017 immune). NFR1: `branchId` is OPTIONAL on the step submit; a submit that
 * omits it must behave exactly as before.
 */
test.describe('AXI-1785 - per-branch identity and refusal (API, real backend)', { tag: ['@SI-045', '@SI-017', '@SI-015', '@SI-013'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let branch2: string;
  const submit = (branchId?: string | null) =>
    s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'submit'), {
      operationId: SCREEN_OP, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash,
      ...(branchId === undefined ? {} : { branchId }),
    }, s.t.headers);

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1785-${tag}`, `AXI-1785 Branch identity ${tag}`);
    await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    const fork = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(fork.body.forked, JSON.stringify(fork.body)).toBe(true);
    branch2 = fork.body.branch.id;
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC1 FR1 - a screen submitted on Branch 2 is accepted and stamped with that branch', async () => {
    const res = await submit(branch2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
  });

  test('AC1 FR2 EC1 - the same screen rule run again on that branch is refused server-side with the reason', async () => {
    const res = await submit(branch2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/Branch 2 already has a screen run of .*\(FR2\)/);
  });

  test('FR2 - the refusal is per branch: the implicit Branch 1 may still run it once, then is refused too', async () => {
    const first = await submit(null);
    expect(first.body.submitted, `refused: ${JSON.stringify(first.body.reasons)}`).toBe(true);
    const second = await submit(null);
    expect(second.body.submitted).toBe(false);
    expect(second.body.reasons.join(' ')).toMatch(/Branch 1 already has a screen run/);
  });

  test('NFR4 - an unknown branch is refused with a reason, never recorded on Branch 1; a non-uuid is a 400', async () => {
    const unknown = await submit('00000000-0000-4000-8000-000000000000');
    expect(unknown.body.submitted).toBe(false);
    expect(unknown.body.reasons.join(' ')).toMatch(/does not exist on this question/);
    const bad = await submit('not-a-uuid');
    expect(bad.status).toBe(400);
  });

  test('NFR1 - a submit that names no branch is unchanged: repeated identical submits are all accepted', async () => {
    const a = await submit();
    const b = await submit();
    expect(a.body.submitted, JSON.stringify(a.body)).toBe(true);
    expect(b.body.submitted, JSON.stringify(b.body)).toBe(true);
  });

  test('NFR4 - a client cannot assert tenancy in the body (workspaceId is refused by the pipe)', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'submit'), {
      operationId: SCREEN_OP, datasetId: s.datasetId, projectId: s.projectId, branchId: branch2, workspaceId: s.t.workspaceId,
    }, s.t.headers);
    expect(res.status).toBe(400);
  });
});
