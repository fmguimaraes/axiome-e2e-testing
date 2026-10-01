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
 * (`GET /view-analyses/:id/snapshots`) so every id the test asserts against
 * is one the backend actually recorded, and reads the run's REAL contingency
 * table (`GET /rule-runs/:id/table`) so the asserted counts/p are the numbers
 * the kernel actually computed, not fixture literals.
 *
 * REVIEW FIX (bounce 1, H1): the cutoff choice is captured through the SAME
 * API the UI uses (`POST .../cutoff-choices`), citing the REAL cutoff run via
 * `presentedProposals[0].ruleRunId` — never a hand-set `snapshotId` bypassing
 * `resolveDiscoverySnapshot`. `choice.snapshotId` is the cutoff run's OWN
 * `fittedOnSnapshotId` (the discovery/screen snapshot every proposal reads
 * against — what `resolveDiscoverySnapshot` resolves in production); the
 * choice's `proposedByRuleRunId` (server-stamped from the cited proposal, per
 * `CutoffChoiceService.capture()`) is the anchor `actDerivation.ts#fisherRunsForChoice`
 * actually matches on — the CITED cutoff run's own `producedSnapshotId`, one
 * lineage level past the discovery snapshot.
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

interface CutoffRow { measurement?: string; cutoff?: number }

/** The cutoff-proposal run's OWN result row for `MARKER` — the exact cut-point it proposed. */
async function cutoffRowFor(s: Seeded, cutoffRunId: string): Promise<CutoffRow> {
  const res = await s.api.get(`/api/v1/rule-runs/${cutoffRunId}/table?page=1&limit=50`, s.t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows: CutoffRow[] = res.body?.rows ?? [];
  const row = rows.find((r) => r.measurement === MARKER);
  expect(row, `the cutoff run must have proposed a cut-point for ${MARKER}`).toBeTruthy();
  return row as CutoffRow;
}

test.describe('AXI-1751 - validation act inputs derived from a real Fisher-exact run', { tag: ['@SI-034', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let fisherRunId: string;
  /** The discovery/screen snapshot every cutoff-proposal run was fitted on (renamed from the
   *  review's flagged `discoverySnapshotId`, which had been hand-set to the WRONG lineage
   *  level — the Fisher run's own snapshot, one level past this one). */
  let cutoffFittedOnSnapshotId: string;
  let fisherProducedSnapshotId: string;
  let cutoffChoiceId: string;
  let decisionDraftId: string;
  let table: { columns: string[]; rows: Record<string, unknown>[] };

  const decisionsUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/decisions`;
  const cutoffChoicesUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/cutoff-choices`;
  const declareUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/candidate-validations/declare`;
  const QUESTION_KEY = `axi-1751-${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1751-${Date.now().toString(36)}`, `AXI-1751 Validation Prefill ${Date.now().toString(36)}`);

    // Real Screen -> Cutoff -> Association, through the step resolver's own submit
    // route (DECLARED container: its cutoff node already binds `positiveGroup`).
    const screenRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'screen', SCREEN_OP);
    const cutoffRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'cutoff', CUTOFF_OP, {
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: MARKER } },
    });
    fisherRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'outcome_association', FISHER_OP, {
      selection: { kind: 'cutoff_choice', nodeId: 'd7', runId: cutoffRunId, values: { marker: MARKER } },
    });

    // Read the Fisher run's OWN produced snapshot — never assumed — for the
    // AC1 assertions below (the value the derivation must show as the target).
    const fisherSnapshot = await snapshotFor(s, s.declaredAnalysisId, fisherRunId);
    fisherProducedSnapshotId = fisherSnapshot.id;

    // The cutoff run's OWN recorded lineage: the discovery/screen snapshot every
    // cutoff-proposal run was fitted on (what `resolveDiscoverySnapshot` resolves
    // in production — never the Fisher run's own snapshot, a different lineage
    // level; that conflation was review bounce 1's H1).
    const cutoffSnapshot = await snapshotFor(s, s.declaredAnalysisId, cutoffRunId);
    cutoffFittedOnSnapshotId = cutoffSnapshot.parentSnapshotId as string;
    expect(cutoffFittedOnSnapshotId, 'the cutoff run must record a fitted-on anchor').toBeTruthy();

    // The run's OWN result row — the exact numbers the derivation must show.
    const tableRes = await s.api.get(`/api/v1/rule-runs/${fisherRunId}/table?page=1&limit=10`, s.t.headers);
    expect(tableRes.status, JSON.stringify(tableRes.body)).toBe(200);
    table = tableRes.body;
    expect(table.rows.length, 'the Fisher-exact run must have produced a result row').toBeGreaterThan(0);

    // The cutoff run's OWN proposed cut-point for MARKER — the choice below must
    // cite EXACTLY this number, or the server's own provenance verification
    // (`cutoff-proposal-verification.ts`) refuses the capture (FR12/FR13/FR14).
    const cutoffRow = await cutoffRowFor(s, cutoffRunId);

    // A captured cutoff choice through the SAME API the UI uses (AXI-1598),
    // citing the REAL cutoff-proposal run via `presentedProposals[0].ruleRunId`
    // — the server stamps `proposedByRuleRunId` from THIS (`CutoffChoiceService
    // .capture()`), which is what `actDerivation.ts#fisherRunsForChoice` anchors
    // on. `snapshotId` is the discovery/screen snapshot (FR12's own field, kept
    // for the record), never hand-set to the Fisher run's own snapshot.
    const choiceRes = await s.api.post(cutoffChoicesUrl(), {
      measurement: MARKER,
      projectId: s.projectId,
      snapshotId: cutoffFittedOnSnapshotId,
      presentedProposals: [{
        proposalId: `data:${MARKER}`, sourceType: 'data_derived', label: 'ROC/Youden', operator: 'gte',
        valueLow: cutoffRow.cutoff, ruleRunId: cutoffRunId,
      }],
      chosenProposalId: `data:${MARKER}`,
      rationale: 'AXI-1751 e2e: the ROC/Youden proposal on this run.',
    }, s.t.headers);
    expect(choiceRes.status, JSON.stringify(choiceRes.body)).toBe(201);
    cutoffChoiceId = choiceRes.body.id as string;
    expect(choiceRes.body.proposedByRuleRunId, 'the server must stamp the cited cutoff run').toBe(cutoffRunId);

    // A decision to hang the candidate on (AXI-1725's own seed shape).
    const decisionRes = await s.api.post(decisionsUrl(), {
      label: 'AXI-1751 e2e decision', type: 'biomarker_threshold', projectId: s.projectId,
      context: { intendedUse: 'RUO' }, evidenceLinks: [],
      evidenceValues: [{ metric: 'axi_1751_e2e_placeholder', value: 1, unit: 'count', sourceSnapshotId: 'axi-1751-e2e-placeholder-snapshot' }],
    }, s.t.headers);
    expect(decisionRes.status, JSON.stringify(decisionRes.body)).toBe(201);
    decisionDraftId = decisionRes.body.id as string;

    const declareRes = await s.api.post(declareUrl(), {
      decisionDraftId, cutoffChoiceId, citedAssociationRunId: fisherRunId, discoverySnapshotId: cutoffFittedOnSnapshotId, questionKey: QUESTION_KEY,
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

    // Read-only counts, matching the run's OWN row exactly — the ORIENTATION
    // (which side is the biomarker) is read off the run's own recorded
    // `operandRoles`, never assumed row=biomarker (review A1).
    const row = table.rows[0] as Record<string, unknown>;
    const runDetailRes = await s.api.get(`/api/v1/rule-runs/${fisherRunId}`, s.t.headers);
    expect(runDetailRes.status, JSON.stringify(runDetailRes.body)).toBe(200);
    const operandRoles = runDetailRes.body?.operandRoles as Record<string, string> | null;
    expect(operandRoles, 'the Fisher run must record its own rowColumn/columnColumn bindings').toBeTruthy();
    const markerIsColumn = operandRoles?.columnColumn === MARKER;
    expect(markerIsColumn || operandRoles?.rowColumn === MARKER, 'the run must bind MARKER on one side of its 2x2').toBe(true);
    const expectedFalsePositive = markerIsColumn ? row.nColumnOnly : row.nRowOnly;
    const expectedFalseNegative = markerIsColumn ? row.nRowOnly : row.nColumnOnly;
    const counts = apply.getByTestId('act-apply-derived-counts');
    await expect(counts).toContainText(`True positives: ${row.nBoth}`);
    await expect(counts).toContainText(`False positives: ${expectedFalsePositive}`);
    await expect(counts).toContainText(`True negatives: ${row.nNeither}`);
    await expect(counts).toContainText(`False negatives: ${expectedFalseNegative}`);
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

  test('AC2 - a captured choice citing no cutoff-proposal run disables every act with the stated reason; no input box appears', async ({ page }) => {
    // A DECLARED choice (expert-entered, not computed) cites no run at all —
    // `proposedByRuleRunId` is null (H1), so there is nothing to anchor a
    // derivation on. The ambiguity / no-Fisher-fitted-on-the-real-anchor cases
    // are covered by the unit suite (`actDerivation.test.ts`,
    // UT-FE-GUIDED-1751-03/04), which does not need a second live run.
    const orphanChoice = await s.api.post(cutoffChoicesUrl(), {
      measurement: MARKER, projectId: s.projectId, snapshotId: cutoffFittedOnSnapshotId,
      presentedProposals: [{ proposalId: 'expert:orphan', sourceType: 'expert', label: 'Expert-entered, no run cited', operator: 'gte', valueLow: 1 }],
      chosenProposalId: 'expert:orphan', rationale: 'AXI-1751 e2e: deliberately no cutoff-proposal run cited.',
    }, s.t.headers);
    expect(orphanChoice.status, JSON.stringify(orphanChoice.body)).toBe(201);
    expect(orphanChoice.body.proposedByRuleRunId, 'an expert choice cites no run').toBeNull();

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
    await expect(apply.getByTestId('act-apply-derivation-blocked')).toContainText('does not cite the specific cutoff-proposal run');
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
