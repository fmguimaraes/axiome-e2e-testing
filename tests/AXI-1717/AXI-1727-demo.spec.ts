import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, driveToScreen, runLiveScreen, publishedRuleCode, primeWorkspace, submitStepAndWait,
  SCREEN_OP, CUTOFF_OP, SPLIT_OP, stepUrl, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1727 — AC-DEMO on the reproduction dataset, run from roles to a declared
 * candidate, and the run-fingerprint/additive audit for the whole epic (epic
 * AXI-1717). Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md`
 * §17. Tags: @SI-046 (workbench), @SI-034 (judgement panels), @SI-045 (resolver).
 *
 * DATASET NOTE: no MIPP reproduction fixture/seed was found in this repo or in
 * `axiome-back`'s `scripts/ingest-retrospective-dataset.ts` pilot pipeline (that
 * script's fixture is not checked in here). This spec reuses the Riaz 2017
 * fixture already wired into every AXI-1717 sibling harness
 * (`./harness/live-workbench.ts`) — the same reproduction-shaped dataset (27
 * patients, a binary outcome, pre-treatment measurements) every other story's
 * live E2E already runs against. Reported as an open item, not silently
 * substituted (see the story handback).
 *
 * REAL BACKEND, LLM-FREE — the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call, exactly like every AXI-1717
 * sibling spec. The entry form's OWN typed-input surface (only `ga-question`
 * is fillable) is AXI-1718's concern, proven under its own E2E_LIVE_LLM gate —
 * re-deriving a second paid planner call here would violate the "never re-run a
 * paid bank" rule. NFR2 here is about the WORKBENCH surface downstream of Run:
 * every step from roles through to a declared candidate is driven with no typed
 * value but a rationale, on the DECLARED container (`outcomePositiveLevel: 'R'`)
 * so the cutoff step resolves fully bound with no pick either (AXI-1723
 * territory) — pure binding-precedence, no operation parameter typed.
 *
 * STATUS: authored 2026-09-27 against the AXI-1727 worktrees; NOT run this
 * session — the lead's ruling for this pass forbids launching any sidecar/
 * container or touching the shared demo stack. Run before e2e-pass:
 *   npx playwright test tests/AXI-1717/AXI-1727-demo.spec.ts
 * against a worktree stack carrying every AXI-1718..1726 commit (see this
 * story's handback for the exact base/head SHAs the audit was run against).
 */

test.describe('AXI-1727 - AC-DEMO: roles to a declared candidate, no typed parameter but rationale (real backend)', { tag: ['@SI-046', '@SI-034', '@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  const MARKER = 'CD8A_pre';

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1727-demo-${Date.now().toString(36)}`, `AXI-1727 AC-DEMO ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC-DEMO, NFR2 - roles through Screen: population confirm, stratify and split-decline are all clicks/selections, no free text', async ({ page }) => {
    // AXI-1720's dataset roles are declared once via the harness seed (the SAME
    // (workspace, dataset) confirmation AXI-1720's own spec exercises through the
    // UI panel) — re-driving that one-time declaration here would duplicate that
    // story's own scenario rather than add coverage.
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    // Everything driveToScreen did was a click/selection: population-confirm,
    // population-continue, a stratify radio + "select all levels", "Run rule",
    // "decline the holdout" (AXI-1750: the ONE typed field on this leg is the
    // governed decline's reason, FR15's rationale exception — not an operation
    // parameter; see `split-decline-reason-input` in `workbenchNoFreeText.test.ts`).
    await expect(page.getByTestId('workbench-screen-node')).toBeVisible();
  });

  test('AC-DEMO, NFR2 - Screen runs one click; choosing the marker types only a rationale', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);

    await page.getByTestId('screen-result-expand').click();
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    // The ONE typed field on this step: the choice rationale (FR15's mandatory
    // rationale doctrine), never the marker itself (that is a row CLICK, FR12).
    const rationale = `${MARKER} separates responders most clearly on this cohort`;
    await page.getByTestId('screen-choice-rationale').fill(rationale);
    await page.getByTestId('screen-choose-marker').click();
    await expect(page.getByTestId('marker-chosen')).toBeVisible({ timeout: 15_000 });
  });

  test('AC-DEMO, NFR2 - Cutoff resolves fully bound with no pick (declared positive level) and Association is chosen, not typed', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);
    await page.getByTestId('screen-result-expand').click();
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    await page.getByTestId('screen-choice-rationale').fill('same reason, this pass');
    await page.getByTestId('screen-choose-marker').click();

    // AXI-1723 (FR8): the declared container's cutoff already binds `positiveGroup`
    // from `upstream:d7` — no picker renders, so nothing new is typed here either.
    await page.getByTestId('association-expand').click();
    await page.getByTestId('assoc-outcomes').getByRole('button').first().click();
    await page.getByTestId('assoc-rules').getByRole('button').first().click();
    await page.getByTestId('assoc-run').click();
    await page.locator('input[name="assoc-choose"]').first().check();
    await page.getByTestId('assoc-choose').click();
    await expect(page.getByTestId('candidate-expand')).toBeVisible({ timeout: 15_000 });
  });

  test('AC-DEMO, NFR2 - the Candidate is declared with no typed parameter but the rationale, through the EXISTING AXI-1598/1630 write', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);
    await page.getByTestId('screen-result-expand').click();
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    await page.getByTestId('screen-choice-rationale').fill('same reason, third pass');
    await page.getByTestId('screen-choose-marker').click();
    await page.getByTestId('association-expand').click();
    await page.getByTestId('assoc-outcomes').getByRole('button').first().click();
    await page.getByTestId('assoc-rules').getByRole('button').first().click();
    await page.getByTestId('assoc-run').click();
    await page.locator('input[name="assoc-choose"]').first().check();
    await page.getByTestId('assoc-choose').click();

    await page.getByTestId('candidate-expand').click();
    const panel = page.getByTestId('workbench-live-candidate-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cutoff-measurement-select')).toHaveValue(MARKER); // pre-bound, not typed (FR15)

    const proposalRadios = page.locator('input[data-testid^="cutoff-proposal-"]');
    await expect(proposalRadios.first()).toBeVisible({ timeout: 15_000 });
    await proposalRadios.first().click(); // a choice, not a typed value
    const rationale = 'Chosen because it separates the two arms most cleanly on this cohort.';
    await page.getByTestId('cutoff-rationale').fill(rationale); // the ONE typed field
    await page.getByTestId('cutoff-submit').click();
    await expect(page.getByTestId('cutoff-record')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('cutoff-record')).toContainText(rationale);
  });

  // --- Blocked legs, both filed on AXI-1728 --------------------------------

  // Re-enabled by AXI-1750 (R12): splitSeed is no longer an unresolvable open
  // domain — the resolver's `generatedPolicy` tier generates and records it on
  // first resolve (a system-generated fact, not a client-suppliable value).
  test('AC-DEMO - taking the Split (a governed holdout) resolves splitSeed with no pick, generated server-side', async () => {
    const res = await s.api.post(stepUrl(s.declaredAnalysisId, 'split', 'resolve'), { operationId: SPLIT_OP, datasetId: s.datasetId }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // splitSeed itself is never in `unresolved` any more (the ONE thing this
    // AC's original gap named) — whatever else the container leaves open
    // (e.g. holdoutRatio, out of this story's scope) is not this test's concern.
    expect(res.body.unresolved.map((u: any) => u.name)).not.toContain('splitSeed');
    const seedBinding = res.body.bindings.find((b: any) => b.name === 'splitSeed');
    expect(seedBinding, JSON.stringify(res.body.bindings)).toBeTruthy();
    expect(typeof seedBinding.value).toBe('number');
    expect(seedBinding.source).toMatch(/^policy:/);
  });

  test('AC-DEMO, NFR2 - the Validation act (Apply/Compare/Pool) reaching a verdict', async ({ page }) => {
    // NEW FINDING (not previously filed): `ActPanel` (`candidateValidation/ActPanel.tsx`,
    // wrapped unmodified per AXI-1724's "wrap, never fork" ruling) requires TYPING a
    // target snapshot id, a 2x2 count set and/or a Fisher p — none of those are a
    // rationale field. NFR2 as literally worded ("no parameter typed except
    // rationales") is not met by the existing, signed-off Validation surface this
    // story wraps — a real gap distinct from splitSeed, filed on AXI-1728 for a
    // ruling (pre-bind the 2x2/target from the live run, or scope NFR2 to stop at
    // a declared candidate). `workbenchNoFreeText.test.ts` structurally does not
    // cover this directory (`components/candidateValidation/**`), which is why
    // this was never caught by the AC5 static scan either.
    test.fixme(true, 'ActPanel (Apply/Compare/Pool) requires typed target/2x2/Fisher-p fields, not rationale-only — NFR2 gap, AXI-1728');
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    await page.getByTestId('validation-expand').click();
    const panel = page.getByTestId('workbench-live-validation-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByTestId('act-apply-submit').click();
  });
});
