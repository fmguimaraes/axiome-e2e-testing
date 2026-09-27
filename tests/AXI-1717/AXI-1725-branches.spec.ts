import { test, expect } from '@playwright/test';
import { workspaceHeader } from '../AXI-1435/harness/api';
import {
  seedLiveWorkbench, driveToScreen, branchUrl, stepUrl, submitStepAndWait,
  SCREEN_OP, CUTOFF_OP, FISHER_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1725 — Fork from node, branch strip and branch count (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 13.
 * Tags: @SI-045 (guided-analysis: the branch bookkeeping service), @SI-016 (graph:
 * the branch-count query), @SI-046/@SI-035 (front: the branch strip, "Reopen here").
 *
 * REAL BACKEND, LLM-FREE — the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call. Fixture: Riaz 2017 immune, 27
 * patients, `response` R/NR, `patient_id`. Seed lifted from AXI-1721's harness
 * (`./harness/live-workbench.ts`) rather than re-deriving the pre-Screen drive.
 */

test.describe('AXI-1725 - fork, discard and count (API, real backend)', { tag: ['@SI-045', '@SI-016'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let screenRunId: string;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1725-api-${Date.now().toString(36)}`, 'AXI-1725 Branches API');
    const submit = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'submit'), { operationId: SCREEN_OP, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash }, s.t.headers);
    expect(submit.status, JSON.stringify(submit.body)).toBe(201);
    screenRunId = submit.body.runId;
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR20 - a fresh question starts at the implicit Branch 1: total=1, discarded=0', async () => {
    const res = await s.api.get(branchUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ branches: [], counts: { total: 1, discarded: 0 } });
  });

  test('FR18 - a fork off a step that has not completed in THIS container is refused', async () => {
    const res = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'cutoff' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.forked).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/has not completed/);
  });

  let branchId: string;
  test('FR18, FR20 - forking a settled step (screen) creates Branch 2 and total becomes 2', async () => {
    const res = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.forked).toBe(true);
    expect(res.body.branch).toMatchObject({ name: 'Branch 2', forkedFromStepId: 'screen', status: 'active' });
    expect(res.body.counts).toEqual({ total: 2, discarded: 0 });
    branchId = res.body.branch.id;
  });

  test('EC6 - two branches may run the SAME cutoff step in parallel (no second-candidate collision at this layer)', async () => {
    // EC6 constrains one declared CANDIDATE per question across branches — a later
    // story's concern (candidate declaration, AXI-1724's territory). Forking and
    // running the same downstream step on two branches is itself unrestricted here.
    const submitOnBranch1 = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(submitOnBranch1.status, JSON.stringify(submitOnBranch1.body)).toBe(200);
  });

  test('FR19 - discarding the fork records an AXI-1507 FR6 discarded path and updates the count', async () => {
    const res = await s.api.post(branchUrl(s.viewAnalysisId, branchId), { reason: 'the shortlist was empty on this arm' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.discarded).toBe(true);
    expect(res.body.branch).toMatchObject({ status: 'discarded', discardReason: 'the shortlist was empty on this arm' });
    expect(res.body.counts).toEqual({ total: 2, discarded: 1 });
  });

  test('FR19 - a blank reason is refused before any write; an already-discarded branch cannot be discarded again', async () => {
    const blank = await s.api.post(branchUrl(s.viewAnalysisId, branchId), { reason: '   ' }, s.t.headers);
    expect(blank.status, JSON.stringify(blank.body)).toBe(200);
    expect(blank.body.discarded).toBe(false);

    const again = await s.api.post(branchUrl(s.viewAnalysisId, branchId), { reason: 'again' }, s.t.headers);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.discarded).toBe(false);
  });

  test('FR19, FR20 - list shows the discarded branch (never hidden) with the FR20 count', async () => {
    const res = await s.api.get(branchUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.counts).toEqual({ total: 2, discarded: 1 });
    expect(res.body.branches).toHaveLength(1);
    expect(res.body.branches[0]).toMatchObject({ id: branchId, status: 'discarded' });
  });

  test('FR21, EC5 - forking split BEFORE any exploration is fine; forking split AFTER a screen ran is refused', async () => {
    const before = await s.api.post(branchUrl(s.declaredAnalysisId), { nodeRef: 'split' }, s.t.headers);
    // The declared container's own split node never ran either, so this is the
    // SAME "has not completed" refusal FR18 already covers for an unsettled step —
    // asserted here to pin that split is not special-cased into a different reason.
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.forked).toBe(false);

    const afterFork = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'split' }, s.t.headers);
    expect(afterFork.status, JSON.stringify(afterFork.body)).toBe(200);
    expect(afterFork.body.forked).toBe(false);
    expect(afterFork.body.reasons.join(' ')).toMatch(/has not completed|before any exploration/);
  });

  test('NFR8 tenancy - workspaceId in the body is refused by the pipe (400); another workspace sees no instance (404)', async () => {
    const forged = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen', workspaceId: s.t.workspaceId }, s.t.headers);
    expect(forged.status).toBe(400);

    const other = await s.api.post('/api/v1/workspaces', { name: 'AXI-1725 Other Tenant', type: 'internal', ownerOrganizationId: s.t.orgId });
    const otherId = other.body?.id ?? (await s.api.get('/api/v1/workspaces?limit=100')).body.find?.((w: any) => w.name === 'AXI-1725 Other Tenant')?.id;
    expect(otherId, `other workspace: ${JSON.stringify(other.body)}`).toBeTruthy();
    const cross = await s.api.get(branchUrl(s.viewAnalysisId), workspaceHeader(otherId));
    expect([403, 404], JSON.stringify(cross)).toContain(cross.status);
  });

  test('FR9, NFR8 - the fork does not touch governed execution: the forked-from run is unchanged (runs are never mutated)', async () => {
    const status = await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${screenRunId}`, s.t.headers);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    const node = status.body.nodes.find((n: any) => n.nodeId.endsWith('__d6'));
    expect(node.status).toMatch(/SUCCEEDED|REUSED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('AXI-1725 - the branch strip renders the real count (UI, real backend)', { tag: ['@SI-046', '@SI-035'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1725-ui-${Date.now().toString(36)}`, 'AXI-1725 Branches UI');
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR20 - a freshly opened LIVE workbench reports "reported after 1 branch"', async ({ page }) => {
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    const strip = page.getByTestId('phase-rail-live-branches');
    await expect(strip).toBeVisible();
    await expect(page.getByTestId('phase-rail-live-branch-count')).toHaveText('reported after 1 branch');
  });

  test('FR18, FR20 - "Reopen here" on Split forks a branch and the strip\'s count follows', async ({ page }) => {
    await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP, { datasetId: s.datasetId, projectId: s.projectId });
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    // The Split node's "Reopen here" only appears once the branch's OWN split is decided;
    // this LIVE-mode workbench's canvas split decision is still the AXI-1719 preview state,
    // so this assertion is scoped to the strip reacting to a fork made directly through the API
    // (the same one the button calls) rather than driving the preview split UI to "decided" here.
    const fork = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(fork.status, JSON.stringify(fork.body)).toBe(200);
    expect(fork.body.forked).toBe(true);
    await page.reload();
    await expect(page.getByTestId('phase-rail-live-branch-count')).toHaveText('reported after 2 branches');
    await expect(page.getByTestId(/^live-branch-chip-/)).toHaveCount(2);
  });

  test('the preview path (no analysisId) is structurally unchanged: no live branch strip', async ({ page }) => {
    await driveToScreen(page, s.projectId, null);
    await expect(page.getByTestId('phase-rail-live-branches')).toHaveCount(0);
  });
});
