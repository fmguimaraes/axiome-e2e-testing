import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, submitStepAndWait, primeWorkspace, driveToScreen, runLiveScreen, publishedRuleCode, stepUrl,
  SCREEN_OP, CUTOFF_OP, FISHER_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1751 — Pre-fill validation inputs from earlier runs (epic AXI-1717, ruling R13).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 22.
 * Tags: @SI-034 (candidateValidation — `ActPanel`'s derived mode), @SI-046 (the
 * workbench's Validation side panel, `LiveValidationPanel`).
 *
 * REAL BACKEND, LLM-FREE. `ActPanel`'s target/2x2/Fisher-p are derived from the
 * cutoff choice's OWN Fisher-exact association run — this spec seeds that run
 * through the SAME step-resolver submit route AXI-1721/1722/1724 already
 * exercise (never a canvas-only fixture), reads the run's REAL lineage
 * (`GET /view-analyses/:id/snapshots`) so the captured cutoff choice's
 * `snapshotId` is set to the run's ACTUAL `fittedOnSnapshotId` — never assumed
 * — and reads the run's REAL contingency table
 * (`GET /rule-runs/:id/table`) so the asserted counts/p are the numbers the
 * kernel actually computed, not fixture literals.
 */

const MARKER = 'CD8A_pre';

interface SnapshotRow { id: string; ruleRunId?: string | null; parentSnapshotId?: string | null }

async function snapshotFor(s: Seeded, viewAnalysisId: string, ruleRunId: string): Promise<SnapshotRow> {
  const res = await s.api.get(`/api/v1/view-analyses/${viewAnalysisId}/snapshots?limit=200`, s.t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows: SnapshotRow[] = Array.isArray(res.body) ? res.body : res.body?.data ?? [];
  const row = rows.find((r) => r.ruleRunId === ruleRunId);
  expect(row, `no snapshot recorded for run ${ruleRunId}`).toBeTruthy();
  return row as SnapshotRow;
}

test.describe('AXI-1751 - validation act inputs derived from a real Fisher-exact run', { tag: ['@SI-034', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let fisherRunId: string;
  let discoverySnapshotId: string;
  let fisherProducedSnapshotId: string;
  let cutoffChoiceId: string;
  let decisionDraftId: string;
  let table: { columns: string[]; rows: Record<string, unknown>[] };

  const decisionsUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/decisions`;
  const cutoffChoicesUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/cutoff-choices`;
  const declareUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/candidate-validations/declare`;
  const QUESTION_KEY = `axi-1751-${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1751-${Date.now().toString(36)}`, 'AXI-1751 Validation Prefill');

    // Real Screen -> Cutoff -> Association, through the step resolver's own submit
    // route (DECLARED container: its cutoff node already binds `positiveGroup`).
    const screenRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'screen', SCREEN_OP);
    const cutoffRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'cutoff', CUTOFF_OP, {
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: MARKER } },
    });
    fisherRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'outcome_association', FISHER_OP, {
      selection: { kind: 'cutoff_choice', nodeId: 'd7', runId: cutoffRunId, values: { marker: MARKER } },
    });

    // Read the Fisher run's OWN recorded lineage — never assumed — so the
    // captured choice below cites the snapshot the run ACTUALLY reports fitting
    // on (`actDerivation.ts#fisherRunsForChoice` matches on this exact field).
    const fisherSnapshot = await snapshotFor(s, s.declaredAnalysisId, fisherRunId);
    fisherProducedSnapshotId = fisherSnapshot.id;
    discoverySnapshotId = fisherSnapshot.parentSnapshotId as string;
    expect(discoverySnapshotId, 'the Fisher run must record a fitted-on anchor').toBeTruthy();

    // The run's OWN result row — the exact numbers the derivation must show.
    const tableRes = await s.api.get(`/api/v1/rule-runs/${fisherRunId}/table?page=1&limit=10`, s.t.headers);
    expect(tableRes.status, JSON.stringify(tableRes.body)).toBe(200);
    table = tableRes.body;
    expect(table.rows.length, 'the Fisher-exact run must have produced a result row').toBeGreaterThan(0);

    // A captured cutoff choice CITING that exact snapshot (real API route, AXI-1598).
    const choiceRes = await s.api.post(cutoffChoicesUrl(), {
      measurement: MARKER,
      projectId: s.projectId,
      snapshotId: discoverySnapshotId,
      presentedProposals: [{ proposalId: `data:${MARKER}`, sourceType: 'data_derived', label: 'ROC/Youden', operator: 'gte', valueLow: 3 }],
      chosenProposalId: `data:${MARKER}`,
      rationale: 'AXI-1751 e2e: the ROC/Youden proposal on this run.',
    }, s.t.headers);
    expect(choiceRes.status, JSON.stringify(choiceRes.body)).toBe(201);
    cutoffChoiceId = choiceRes.body.id as string;

    // A decision to hang the candidate on (AXI-1725's own seed shape).
    const decisionRes = await s.api.post(decisionsUrl(), {
      label: 'AXI-1751 e2e decision', type: 'biomarker_threshold', projectId: s.projectId,
      context: { intendedUse: 'RUO' }, evidenceLinks: [],
      evidenceValues: [{ metric: 'axi_1751_e2e_placeholder', value: 1, unit: 'count', sourceSnapshotId: 'axi-1751-e2e-placeholder-snapshot' }],
    }, s.t.headers);
    expect(decisionRes.status, JSON.stringify(decisionRes.body)).toBe(201);
    decisionDraftId = decisionRes.body.id as string;

    const declareRes = await s.api.post(declareUrl(), {
      decisionDraftId, cutoffChoiceId, citedAssociationRunId: fisherRunId, discoverySnapshotId, questionKey: QUESTION_KEY,
    }, s.t.headers);
    expect(declareRes.status, JSON.stringify(declareRes.body)).toBe(201);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC1 AC3 - target snapshot, 2x2 counts and Fisher p are pre-filled, read-only and cited from the real run; no free-text input renders', async ({ page }) => {
    await primeWorkspace(page, s);
    // Drive the canvas far enough to unlock Validation (AXI-1726: project-scoped, a real declared cutoff choice unlocks it).
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);
    await expect(page.getByTestId('validation-expand')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('validation-expand').click();
    const panel = page.getByTestId('workbench-live-validation-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });

    // Pick the decision and the captured choice — the ONLY selection this
    // story leaves as-is (SubjectPicker's own two `<select>` choice controls,
    // AXI-1599, unchanged); everything after is derived.
    await panel.getByTestId('validation-decision-select').selectOption(decisionDraftId);
    await panel.getByTestId('validation-choice-select').selectOption(cutoffChoiceId);

    const apply = panel.getByTestId('act-apply');
    await expect(apply.getByTestId('act-apply-derivation-blocked')).toHaveCount(0);

    // Read-only, cited target snapshot — the run's OWN produced snapshot, never typed.
    await expect(apply.getByTestId('act-apply-derived-target')).toContainText(fisherProducedSnapshotId);
    await expect(apply.getByTestId('act-apply-derived-target')).toContainText(fisherRunId);
    // No typed target-snapshot input renders at all (AC2's "no input box" also holds on the happy path).
    await expect(apply.getByTestId('act-apply-target')).toHaveCount(0);

    // Read-only counts, matching the run's OWN row exactly.
    const row = table.rows[0] as Record<string, unknown>;
    const counts = apply.getByTestId('act-apply-derived-counts');
    await expect(counts).toContainText(`True positives: ${row.nBoth}`);
    await expect(counts).toContainText(`False positives: ${row.nRowOnly}`);
    await expect(counts).toContainText(`True negatives: ${row.nNeither}`);
    await expect(counts).toContainText(`False negatives: ${row.nColumnOnly}`);
    for (const f of ['truePositive', 'falsePositive', 'trueNegative', 'falseNegative']) await expect(apply.getByTestId(`act-apply-${f}`)).toHaveCount(0);

    // Read-only Fisher p and the cited run id.
    const fisherAndRun = apply.getByTestId('act-apply-derived-fisher-and-run');
    if (typeof row.pValue === 'number') await expect(fisherAndRun).toContainText(String(row.pValue));
    await expect(fisherAndRun).toContainText(fisherRunId);
    await expect(apply.getByTestId('act-apply-fisher')).toHaveCount(0);
    await expect(apply.getByTestId('act-apply-run')).toHaveCount(0);

    // Compare and Pool derive the SAME way (one derivation, three acts).
    for (const kind of ['compare', 'pool']) {
      const act = panel.getByTestId(`act-${kind}`);
      await expect(act.getByTestId(`act-${kind}-derived-target`)).toContainText(fisherProducedSnapshotId);
    }

    // Only the target-kind radios are gone too (derived mode always targets the cited run's own snapshot).
    await expect(apply.getByTestId('act-apply-target-holdout')).toHaveCount(0);
    await expect(apply.getByTestId('act-apply-target-cohort')).toHaveCount(0);
  });

  test('AC2 - a captured choice with no matching Fisher-exact run disables every act with the stated reason; no input box appears', async ({ page }) => {
    // A second choice on a snapshot no association run was ever fitted on.
    const orphanChoice = await s.api.post(cutoffChoicesUrl(), {
      measurement: MARKER, projectId: s.projectId, snapshotId: 'axi-1751-e2e-orphan-snapshot',
      presentedProposals: [{ proposalId: 'expert:orphan', sourceType: 'expert', label: 'No association run cites this snapshot', operator: 'gte', valueLow: 1 }],
      chosenProposalId: 'expert:orphan', rationale: 'AXI-1751 e2e: deliberately no Fisher-exact run fitted on this snapshot.',
    }, s.t.headers);
    expect(orphanChoice.status, JSON.stringify(orphanChoice.body)).toBe(201);

    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);
    await page.getByTestId('validation-expand').click();
    const panel = page.getByTestId('workbench-live-validation-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });

    await panel.getByTestId('validation-decision-select').selectOption(decisionDraftId);
    await panel.getByTestId('validation-choice-select').selectOption(orphanChoice.body.id);

    const apply = panel.getByTestId('act-apply');
    await expect(apply.getByTestId('act-apply-derivation-blocked')).toContainText('No finished Fisher-exact association run was found');
    // No input box appears for any of the four values.
    await expect(apply.getByTestId('act-apply-target')).toHaveCount(0);
    for (const f of ['truePositive', 'falsePositive', 'trueNegative', 'falseNegative']) await expect(apply.getByTestId(`act-apply-${f}`)).toHaveCount(0);
    await expect(apply.getByTestId('act-apply-fisher')).toHaveCount(0);
    await expect(apply.getByTestId('act-apply-run')).toHaveCount(0);
    await expect(apply.getByTestId('act-apply-submit')).toBeDisabled();
  });

  // Static corroboration (already run under vitest, cited here for the E2E audit trail):
  // `workbenchNoFreeText.test.ts`'s new candidateValidation describe block
  // (UT-FE-GUIDED-1751-10..12) scans `components/candidateValidation/**` the same
  // way UT-FE-GUIDED-1727-01 scans the workbench directory (AC3).
});
