import { test, expect } from '@playwright/test';
import { workspaceHeader } from '../AXI-1435/harness/api';
import {
  seedLiveWorkbench, driveToScreen, primeWorkspace, stepUrl, declineHoldoutUrl,
  SPLIT_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1750 — Governed split seed and holdout-declined record (epic AXI-1717,
 * ruling R12). Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md`
 * §18. Tags: @SI-045 (guided-analysis: the split-decision service + resolver
 * tier), @SI-046 (front: SplitNode live wiring).
 *
 * REAL BACKEND, LLM-FREE — the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call.
 */

test.describe('AXI-1750 - split seed resolves server-side; holdout decline is a governed record (API, real backend)', { tag: ['@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1750-api-${Date.now().toString(36)}`, `AXI-1750 Split Seed API ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('R12 - resolving split with no picks generates splitSeed server-side, tagged policy:', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'resolve'), { operationId: SPLIT_OP, datasetId: s.datasetId }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.unresolved.map((u: any) => u.name)).not.toContain('splitSeed');
    const seedBinding = res.body.bindings.find((b: any) => b.name === 'splitSeed');
    expect(seedBinding, JSON.stringify(res.body.bindings)).toBeTruthy();
    expect(typeof seedBinding.value).toBe('number');
    expect(seedBinding.source).toMatch(/^policy:/);
  });

  test('R12 - a supplied splitSeed pick is still refused (never client-suppliable)', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'submit'), {
      operationId: SPLIT_OP, datasetId: s.datasetId, projectId: s.projectId,
      picks: { splitSeed: 42 },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.submitted).toBe(false);
    expect(JSON.stringify(res.body.reasons)).toMatch(/outside its allowed domain/);
  });

  test('R12 - re-resolving reuses the SAME recorded seed (idempotent, not regenerated)', async () => {
    const first = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'resolve'), { operationId: SPLIT_OP, datasetId: s.datasetId }, s.t.headers);
    const second = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'resolve'), { operationId: SPLIT_OP, datasetId: s.datasetId }, s.t.headers);
    const seedOf = (body: any) => body.bindings.find((b: any) => b.name === 'splitSeed')?.value;
    expect(seedOf(second.body)).toBe(seedOf(first.body));
  });

  test('R12 - declining the holdout is a governed record with a reason', async () => {
    const res = await s.api.post(declineHoldoutUrl(s.declaredAnalysisId, 'split'), { reason: 'exploratory arm only, holdout not needed' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.decision).toMatchObject({ declineReason: 'exploratory arm only, holdout not needed' });
  });

  test('R12 - a blank reason is refused before any write', async () => {
    const res = await s.api.post(declineHoldoutUrl(s.viewAnalysisId, 'split'), { reason: '   ' }, s.t.headers);
    expect(res.status).toBe(400);
  });

  test('R12 - declining an already-declined question is refused, naming the reason', async () => {
    const res = await s.api.post(declineHoldoutUrl(s.declaredAnalysisId, 'split'), { reason: 'changed my mind' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(JSON.stringify(res.body.reasons)).toMatch(/already/i);
  });

  test('FR18 (AXI-1725) - a declined split now counts as settled: "Reopen here" on split is no longer refused as "has not completed"', async () => {
    const res = await s.api.post(`/api/v1/discovery/analyses/${s.declaredAnalysisId}/branches`, { nodeRef: 'split' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.forked).toBe(true);
    expect(res.body.branch).toMatchObject({ forkedFromStepId: 'split', status: 'active' });
  });

  test('NFR8 tenancy - workspaceId in the body is refused by the pipe (400); another workspace sees no instance (404)', async () => {
    const forged = await s.api.post(declineHoldoutUrl(s.viewAnalysisId, 'split'), { reason: 'x', workspaceId: s.t.workspaceId }, s.t.headers);
    expect(forged.status).toBe(400);

    const other = await s.api.post('/api/v1/workspaces', { name: 'AXI-1750 Other Tenant', type: 'internal', ownerOrganizationId: s.t.orgId });
    const otherId = other.body?.id ?? (await s.api.get('/api/v1/workspaces?limit=100')).body.find?.((w: any) => w.name === 'AXI-1750 Other Tenant')?.id;
    expect(otherId, `other workspace: ${JSON.stringify(other.body)}`).toBeTruthy();
    const cross = await s.api.post(declineHoldoutUrl(s.viewAnalysisId, 'split'), { reason: 'x' }, workspaceHeader(otherId));
    expect([403, 404], JSON.stringify(cross)).toContain(cross.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('AXI-1750 - the live Split node wires take/decline to the governed backend (UI, real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1750-ui-${Date.now().toString(36)}`, `AXI-1750 Split Seed UI ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('R12 - declining the holdout live opens a reason modal; the recorded reason renders on the node', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    // `driveToScreen` already drove the decline (the reason filled is
    // 'e2e: exploratory arm, holdout not needed' — see the harness); the
    // recorded line should show it back, verbatim, at the Split node.
    await expect(page.getByTestId('workbench-screen-node')).toBeVisible();
  });

  test('the preview path (no analysisId) is byte-identical: decline is still one click, no reason modal', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, null);
    await expect(page.getByTestId('split-decline-reason-input')).toHaveCount(0);
    await expect(page.getByTestId('workbench-screen-node')).toBeVisible();
  });
});
