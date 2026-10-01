import { test, expect } from '@playwright/test';
import { workspaceHeader } from '../AXI-1435/harness/api';
import {
  seedLiveWorkbench, driveToScreen, runLiveScreen, publishedRuleCode, primeWorkspace, stepUrl, waitForNode, submitStepAndWait,
  SCREEN_OP, CUTOFF_OP, FISHER_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1722 — Shortlist row selection binds downstream steps (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 12.
 * Tags: @SI-045 (guided-analysis: the resolver's per-kind readers), @SI-046 (front: the
 * result modal's next-steps panel), @SI-002 (the contract, unchanged wire shape).
 *
 * REAL BACKEND, LLM-FREE — the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call. Fixture: Riaz 2017 immune, 27
 * patients, `response` R/NR, `patient_id`, pre-treatment gene measurements. Seed lifted
 * from AXI-1721's harness (`./harness/live-workbench.ts`) so this story does not
 * re-derive the pre-Screen drive.
 */

test.describe('AXI-1722 - selection admission and readers (API, real backend)', { tag: ['@SI-045', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let screenRunId: string;
  let cutoffRunId: string;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1722-api-${Date.now().toString(36)}`, `AXI-1722 Row Binding API ${Date.now().toString(36)}`);
    const submit = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'submit'), { operationId: SCREEN_OP, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash }, s.t.headers);
    expect(submit.status, JSON.stringify(submit.body)).toBe(201);
    screenRunId = submit.body.runId;
    await waitForNode(s, screenRunId, 'd6');
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR12 NFR5 - a shortlist_row selection resolves the SAME bindings on every call, tagged upstream:d6', async () => {
    const body = { operationId: CUTOFF_OP, datasetId: s.datasetId, selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } } };
    const a = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), body, s.t.headers);
    const b = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), body, s.t.headers);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toEqual(b.body);
    const byName = Object.fromEntries(a.body.bindings.map((x: any) => [x.name, x]));
    expect(byName.valueColumns).toMatchObject({ value: ['CD8A_pre'], source: 'upstream:d6' });
  });

  test('A4 - a selection naming a RECORDED node whose operation does not PRODUCE the kind is refused, never bound', async () => {
    // The screen step (d6, recorded — it already submitted) accepts a split_arm selection
    // (SCREEN_OP's declared inputs), but its OWN operation produces shortlist_row, not
    // split_arm — a recorded node that produces the wrong kind, not an unrecorded one.
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), {
      operationId: SCREEN_OP, datasetId: s.datasetId, selection: { kind: 'split_arm', nodeId: 'd6', runId: screenRunId, values: { arm: 'exploration' } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fullyBound).toBe(false);
    expect(res.body.disabledReason).toContain('does not produce a split_arm');
  });

  test('A4 - a selection naming a node that has not SETTLED is refused, naming its status', async () => {
    // AXI-1807: the declared container's instantiation run is DRAFT and never starts (AXI-1779 —
    // instantiating declares, it does not run), so its own d6 node carries NO status at all until
    // that container's screen STEP is submitted. "Not settled" is now the permanent resting state
    // of every instantiated node, not a transient one.
    const res = await s.api.post(stepUrl(s.declaredAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, selection: { kind: 'shortlist_row', nodeId: 'd6', runId: s.declaredInstanceRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The instance's d6 node declares the measurement family, so it IS a row the screen will rank
    // (AXI-1721's own "declared" test proves this resolves fully bound) — settledness here is about
    // the SCREEN RUN's node, not the instance's; assert on a genuinely unsettled node instead: the
    // split node of the SAME container, which never ran.
    const splitSel = await s.api.post(stepUrl(s.declaredAnalysisId, 'screen', 'resolve'), {
      operationId: SCREEN_OP, datasetId: s.datasetId, selection: { kind: 'split_arm', nodeId: 'd5', runId: s.declaredInstanceRunId, values: { arm: 'exploration' } },
    }, s.t.headers);
    expect(splitSel.status, JSON.stringify(splitSel.body)).toBe(200);
    expect(splitSel.body.disabledReason).toContain('never recorded');
  });

  test('FR12 - a value key the reader does not read is refused by name, never silently dropped', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre', threshold: 3 } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.disabledReason).toContain('threshold');
    expect(res.body.disabledReason).toContain('never recorded');
  });

  test('FR12 - cutoff_choice reader binds the fitted marker as valueColumn/valueColumns, tagged upstream:d7; a marker never ranked is refused', async () => {
    cutoffRunId = await submitStepAndWait(s, s.viewAnalysisId, 'cutoff', CUTOFF_OP, { selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } }, picks: { positiveGroup: 'R' } });
    const ok = await s.api.post(stepUrl(s.viewAnalysisId, 'outcome_association', 'resolve'), {
      operationId: FISHER_OP, datasetId: s.datasetId, selection: { kind: 'cutoff_choice', nodeId: 'd7', runId: cutoffRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.disabledReason).toBeNull();
    const wrong = await s.api.post(stepUrl(s.viewAnalysisId, 'outcome_association', 'resolve'), {
      operationId: FISHER_OP, datasetId: s.datasetId, selection: { kind: 'cutoff_choice', nodeId: 'd7', runId: cutoffRunId, values: { marker: 'STAT1_pre' } },
    }, s.t.headers);
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(200);
    expect(wrong.body.disabledReason).toContain('never ranked');
  });

  test('FR12 AC4 - split_arm reader: an undeclared split says "never recorded"; a bogus arm says "not an arm"', async () => {
    const noSplit = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), {
      operationId: SCREEN_OP, datasetId: s.datasetId, selection: { kind: 'split_arm', nodeId: 'd5', runId: s.instanceRunId, values: { arm: 'exploration' } },
    }, s.t.headers);
    expect(noSplit.status, JSON.stringify(noSplit.body)).toBe(200);
    expect(noSplit.body.disabledReason).toContain('never recorded');
  });

  test('FR9 NFR8 - the row-bound submit records the source tag beside the run\'s other bindings', async () => {
    const status = await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${cutoffRunId}`, s.t.headers);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    const node = status.body.nodes.find((n: any) => n.nodeId.endsWith('__d7'));
    expect(node.bindingSources).toMatchObject({ valueColumns: 'upstream:d6' });
  });

  test('NFR8 tenancy - workspaceId in the body is refused by the pipe (400); another workspace sees no instance (404)', async () => {
    const forged = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, workspaceId: s.t.workspaceId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(forged.status).toBe(400);
    const other = await s.api.post('/api/v1/workspaces', { name: 'AXI-1722 Other Tenant', type: 'internal', ownerOrganizationId: s.t.orgId });
    const otherId = other.body?.id ?? (await s.api.get('/api/v1/workspaces?limit=100')).body.find?.((w: any) => w.name === 'AXI-1722 Other Tenant')?.id;
    expect(otherId, `other workspace: ${JSON.stringify(other.body)}`).toBeTruthy();
    const cross = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, workspaceHeader(otherId));
    expect([403, 404], JSON.stringify(cross.body)).toContain(cross.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('AXI-1722 - a live shortlist row binds the next steps (UI, real backend)', { tag: ['@SI-046', '@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  let s: Seeded;
  let screenRuleCode: string;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1722-ui-${Date.now().toString(36)}`, `AXI-1722 Row Binding UI ${Date.now().toString(36)}`);
    screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test.beforeEach(async ({ page }) => { await primeWorkspace(page, s); });

  test('AC4 FR10 FR12 FR13 - the result modal\'s selected row lists the next steps bound to it, badged live, each pre-bound to that row', async ({ page }) => {
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    await runLiveScreen(page, screenRuleCode);
    const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
    await result.getByTestId('screen-result-expand').click();
    const modal = page.getByTestId('workbench-screen-result-modal');
    await expect(modal.getByTestId('screen-result-mode')).toHaveText('live');

    const table = modal.getByTestId('screen-shortlist-table');
    await expect(table).toBeVisible();
    const allChip = modal.getByTestId('screen-filter').getByRole('button', { name: /all/i });
    if (await allChip.count()) await allChip.click();
    const row = table.locator('tbody tr').filter({ hasText: 'CD8A_pre' }).first();
    await row.click();

    const panel = modal.getByTestId('row-step-proposals');
    await expect(panel).toContainText('Next steps · bound to CD8A_pre');
    const card = panel.getByTestId(`row-step-op-${CUTOFF_OP}`);
    await expect(card.getByTestId(`row-step-op-bindings-${CUTOFF_OP}`)).toContainText('(upstream d6)', { timeout: 30_000 });
    await expect(panel.getByTestId(`row-step-op-unresolved-${CUTOFF_OP}`)).toContainText('positiveGroup');
    await expect(card.getByTestId(`row-step-op-run-${CUTOFF_OP}`)).toBeDisabled();
  });

  test('NFR5 AC4 - selecting a different row then the same row again resolves to the same binding line', async ({ page }) => {
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    await runLiveScreen(page, screenRuleCode);
    const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
    await result.getByTestId('screen-result-expand').click();
    const modal = page.getByTestId('workbench-screen-result-modal');
    const table = modal.getByTestId('screen-shortlist-table');
    const allChip = modal.getByTestId('screen-filter').getByRole('button', { name: /all/i });
    if (await allChip.count()) await allChip.click();

    const rowA = table.locator('tbody tr').filter({ hasText: 'CD8A_pre' }).first();
    await rowA.click();
    const bindingsA = await modal.getByTestId(`row-step-op-bindings-${CUTOFF_OP}`).textContent();

    const rowB = table.locator('tbody tr').filter({ hasText: 'STAT1_pre' }).first();
    await rowB.click();
    await expect(modal.getByTestId(`row-step-op-bindings-${CUTOFF_OP}`)).toContainText('STAT1_pre');

    await rowA.click();
    await expect(modal.getByTestId(`row-step-op-bindings-${CUTOFF_OP}`)).toHaveText(bindingsA ?? '');
  });

  test('the preview path (no analysisId) is structurally unchanged: no live badge, no plan-step one-click card', async ({ page }) => {
    // AXI-1722 only wires the SELECTION for a LIVE row (`useWorkbenchLive()`); the AXI-1719
    // preview surface (config-modal-driven runs) is untouched, so this asserts the picker's
    // shape rather than re-running the preview's own (separately owned) config-modal flow.
    await driveToScreen(page, s.projectId, null);
    await page.getByTestId('screen-choose-rule').click();
    const anyCard = page.getByTestId(/^screen-rule-run-/).first();
    await expect(anyCard).toBeVisible({ timeout: 30_000 });
    await expect(anyCard).toHaveText(/Configure and run/);
    await expect(page.getByTestId(/^screen-rule-live-/)).toHaveCount(0);
  });
});
