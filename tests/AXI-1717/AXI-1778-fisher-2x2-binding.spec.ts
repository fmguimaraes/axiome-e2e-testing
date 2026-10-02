import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, seedCutoffProposal, stepUrl, FISHER_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1778 — Fisher-exact 2x2 binds its full param set from the confirmed dataset
 * roles + the plan's declared positive level (epic AXI-1717, bug fix).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 36.
 * Tags: @SI-045 (guided-analysis: the resolver's `cutoff_choice` reader + domain-fill).
 *
 * Before this fix, `POST …/steps/outcome_association/resolve` with a `cutoff_choice`
 * selection returned `bindings: []` and `unresolved: [rowPositiveLevel,
 * columnPositiveLevel, rowColumn, columnColumn]` even on the DECLARED container, whose
 * plan already names the dataset roles and the positive outcome class — the reader
 * only ever bound `valueColumns`/`valueColumn`. REAL BACKEND, LLM-free: the cutoff
 * proposal is a template instantiation + a real screen/cutoff run, never a planner call.
 *
 * Review bounce #1 corrected an initial version of this fix that echoed the cutoff
 * node's own `positiveGroup` (the OUTCOME's positive class) into BOTH
 * `rowPositiveLevel` and `columnPositiveLevel`. `rowPositiveLevel` is a level of the
 * MARKER column (`rowColumn`) — a different column with a different vocabulary — so
 * it correctly stays `unresolved`, offered a domain over the marker's own levels;
 * only `columnPositiveLevel` (the outcome's own positive level) is bound.
 */

test.describe('AXI-1778 - Fisher 2x2 auto-bind (API, real backend)', { tag: ['@SI-045', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let cutoffRunId: string;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1778-api-${Date.now().toString(36)}`, `AXI-1778 Fisher 2x2 API ${Date.now().toString(36)}`);
    ({ cutoffRunId } = await seedCutoffProposal(s, s.declaredAnalysisId, 'CD8A_pre'));
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR8 FR9 - a cutoff_choice selection binds rowColumn/columnColumn/columnPositiveLevel, each tagged upstream:d7; rowPositiveLevel stays unresolved over the MARKER\'s own levels', async () => {
    const res = await s.api.post(stepUrl(s.declaredAnalysisId, 'outcome_association', 'resolve'), {
      operationId: FISHER_OP, datasetId: s.datasetId,
      selection: { kind: 'cutoff_choice', nodeId: 'd7', runId: cutoffRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.disabledReason).toBeNull();
    const byName = Object.fromEntries(res.body.bindings.map((x: any) => [x.name, x]));
    expect(byName.rowColumn).toMatchObject({ value: 'CD8A_pre', source: 'upstream:d7' });
    expect(byName.columnColumn).toMatchObject({ value: 'response', source: 'upstream:d7' });
    expect(byName.columnPositiveLevel).toMatchObject({ value: 'R', source: 'upstream:d7' });
    // Bounce fix: rowPositiveLevel must NEVER echo the outcome's 'R' — it is a level
    // of the MARKER column, not the outcome, and this node records no such level.
    expect(byName.rowPositiveLevel).toBeUndefined();
    const rowPositive = res.body.unresolved.find((u: any) => u.name === 'rowPositiveLevel');
    expect(rowPositive, JSON.stringify(res.body.unresolved)).toBeTruthy();
    expect(rowPositive.domain).toMatchObject({ kind: 'levels', column: 'CD8A_pre' });
    expect(rowPositive.domain.values).not.toContain('R');
    expect(res.body.fullyBound).toBe(false);
  });

  test('NFR5 - the same selection resolves to the same bindings on a second call', async () => {
    const body = {
      operationId: FISHER_OP, datasetId: s.datasetId,
      selection: { kind: 'cutoff_choice', nodeId: 'd7', runId: cutoffRunId, values: { marker: 'CD8A_pre' } },
    };
    const a = await s.api.post(stepUrl(s.declaredAnalysisId, 'outcome_association', 'resolve'), body, s.t.headers);
    const b = await s.api.post(stepUrl(s.declaredAnalysisId, 'outcome_association', 'resolve'), body, s.t.headers);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toEqual(b.body);
  });
});
