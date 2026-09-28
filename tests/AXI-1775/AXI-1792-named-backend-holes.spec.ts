import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, stepUrl, SCREEN_OP, type Seeded } from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1792 - Named backend holes: qc_check in the dependency scan, analysis-scoped Validation lock,
 * datasetVersionHash (epic AXI-1775, FR33-FR35, AC10, EC9, EC10).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 4.
 * Tags: @SI-045 (guided-analysis: step resolver, cutoff-choice read), @SI-002 (additive contract: the
 * optional `viewAnalysisId` list filter).
 *
 * REAL BACKEND, LLM-FREE, API level. Two analyses of ONE project (`s.viewAnalysisId`, `s.declaredAnalysisId`)
 * stand in for "this analysis" and "a sibling guided analysis in the same project" (EC9). A cutoff choice
 * of source `expert` needs no cited run (the AXI-1725 EC6 spec's own seed), so the only thing under test
 * is WHICH analysis the choice belongs to (`snapshotId` -> the analysis that owns that snapshot).
 */
test.describe('AXI-1792 - analysis-scoped Validation lock read (EC9, FR34)', { tag: ['@SI-045', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let siblingSnapshotId: string;
  let ownSnapshotId: string;
  const choicesUrl = (query: string) => `/api/v1/workspaces/${s.t.workspaceId}/cutoff-choices?${query}`;
  const tag = Date.now().toString(36);

  const snapshotOf = async (viewAnalysisId: string): Promise<string> => {
    const res = await s.api.get(`/api/v1/view-analyses/${viewAnalysisId}/snapshots?limit=200`, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows: { id: string }[] = Array.isArray(res.body) ? res.body : res.body?.data ?? [];
    expect(rows.length, `analysis ${viewAnalysisId} must own at least one snapshot`).toBeGreaterThan(0);
    return rows[0].id;
  };

  const capture = async (snapshotId: string, measurement: string) => {
    const res = await s.api.post(choicesUrl(''), {
      measurement, projectId: s.projectId, snapshotId,
      presentedProposals: [{ proposalId: `expert:axi-1792-${tag}`, sourceType: 'expert', label: 'Entered for AXI-1792 e2e', operator: 'gte', valueLow: 5 }],
      chosenProposalId: `expert:axi-1792-${tag}`,
      rationale: 'AXI-1792 e2e: an entered cut-point; the test is about which analysis owns the choice.',
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  const listFor = async (viewAnalysisId: string, measurement: string) => {
    const res = await s.api.get(choicesUrl(`projectId=${s.projectId}&measurement=${measurement}&viewAnalysisId=${viewAnalysisId}&limit=50`), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1792-${tag}`, `AXI-1792 Named holes ${tag}`);
    siblingSnapshotId = await snapshotOf(s.declaredAnalysisId);
    ownSnapshotId = await snapshotOf(s.viewAnalysisId);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC10 EC9 FR34 - a sibling analysis\'s declared choice does not appear for this analysis (Validation stays locked)', async () => {
    const measurement = `CD8A_pre_${tag}`;
    const choiceId = await capture(siblingSnapshotId, measurement);
    const mine = await listFor(s.viewAnalysisId, measurement);
    expect(mine.data, 'this analysis has no choice of its own').toEqual([]);
    const sibling = await listFor(s.declaredAnalysisId, measurement);
    expect(sibling.data.map((c: { id: string }) => c.id)).toEqual([choiceId]);
    // The pre-existing project-scoped read still sees it (NFR1: additive, unchanged).
    const projectWide = await s.api.get(choicesUrl(`projectId=${s.projectId}&measurement=${measurement}&limit=50`), s.t.headers);
    expect(projectWide.body.data.map((c: { id: string }) => c.id)).toContain(choiceId);
  });

  test('AC10 FR34 - once THIS analysis holds its own choice its read is non-empty (Validation unlocks for it)', async () => {
    const measurement = `PDCD1_pre_${tag}`;
    const choiceId = await capture(ownSnapshotId, measurement);
    const mine = await listFor(s.viewAnalysisId, measurement);
    expect(mine.data.map((c: { id: string }) => c.id)).toEqual([choiceId]);
    const sibling = await listFor(s.declaredAnalysisId, measurement);
    expect(sibling.data).toEqual([]);
  });

  test('FR34 NFR4 - an unknown analysis answers like an analysis with no choices; a non-uuid is a 400', async () => {
    const unknown = await s.api.get(choicesUrl('viewAnalysisId=00000000-0000-4000-8000-000000000000&limit=5'), s.t.headers);
    expect(unknown.status).toBe(200);
    expect(unknown.body.data).toEqual([]);
    const bad = await s.api.get(choicesUrl('viewAnalysisId=not-a-uuid'), s.t.headers);
    expect(bad.status).toBe(400);
  });
});

test.describe('AXI-1792 - qc_check ancestors in the dependency scan (EC10, FR33)', { tag: ['@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  test.beforeAll(async () => { s = await seedLiveWorkbench(`axi-1792-qc-${Date.now().toString(36)}`, 'AXI-1792 QC ancestors'); });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC10 EC10 FR33 - the screen step is disabled with a QC reason exactly when a QC ancestor of the instance failed; otherwise unchanged (NFR1)', async () => {
    const status = (await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${s.instanceRunId}`, s.t.headers)).body;
    const qcNodes = (status?.nodes ?? []).filter((n: { nodeId: string }) => /__d[234]$/.test(n.nodeId));
    expect(qcNodes.length, 'the template instantiates three qc_check nodes (d2..d4)').toBe(3);
    const stopped = qcNodes.some((n: { status: string }) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(n.status));
    const resolved = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), { operationId: SCREEN_OP, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash }, s.t.headers);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
    if (stopped) expect(resolved.body.disabledReason).toMatch(/QC check .* (failed|blocked): /);
    else expect(resolved.body.disabledReason ?? '').not.toMatch(/QC check/);
  });
});
