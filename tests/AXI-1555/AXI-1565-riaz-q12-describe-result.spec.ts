import { test, expect } from '@playwright/test';
import { readTrace, resolveQ12Target, type Q12Target } from '../../capture/masters/m13DescribeResultQ12';
import { Q12_SENTENCE } from '../../staging/steps/riazDescribeExpectations';

/**
 * AXI-1565 — Riaz Q12 describe result, end to end in the browser (@SI-044),
 * covering AC2/AC11/AC14 of feature
 * IN-PROGRESS-Executable-Describe-Connector-Rules (FR21, FR32, FR37).
 *
 * The epic's objective, stated by the user, is "make a question and see a
 * chart + answer" — so this spec asserts the ANSWER SURFACE, not a run row:
 * on one screen, the deterministic sentence (byte-for-byte the golden Q12
 * sentence — the renderer is deterministic, so an approximate match would
 * hide exactly the drift it exists to prevent), the `SUM-RANK-01 · match`
 * connector chip, the rule link the chip's citation resolves to, and the
 * platform's OWN recommended chart; then the Decision the sentence was minted
 * onto, typed `Descriptive Summary`.
 *
 * The subject is the staged Riaz 2017 project, so every id comes from
 * `stage:riaz-questions`' trace (`riaz-questions-trace.json`) — never
 * hard-coded. Without that trace, or with a Q12 that produced no describe
 * result, the spec SKIPS rather than fails: an unstaged stack is not a
 * regression. Locators are scoped to `describe-result-summary` so a sentence
 * rendered anywhere else on the page cannot satisfy them.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const trace = readTrace();
const target = typeof trace === 'string' ? trace : resolveQ12Target(trace);
const staged = typeof target !== 'string';
const q12 = target as Q12Target;

test.beforeEach(async ({ context }) => {
  test.skip(!staged, `Riaz Q12 not staged: ${staged ? '' : (target as string)}`);
  // The active org/workspace/project is client state every internal page reads
  // (`topMenuStore`); without it the analysis route renders "Access denied"
  // regardless of the account's real backend permissions.
  await context.addInitScript(
    ([org, ws, proj]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', proj);
    },
    [q12.orgId, q12.workspaceId, q12.projectId],
  );
});

test('AC2/AC11 (FR21, FR32) — the Q12 result view shows the deterministic sentence, the SUM-RANK-01 match chip and the recommended chart on one screen @SI-044', async ({ page }) => {
  await page.goto(`/projects/${q12.projectId}/view-analyses/${q12.analysisId}?snapshotId=${q12.snapshotId}`);

  const summary = page.getByTestId('describe-result-summary');
  await expect(summary).toBeVisible();

  await expect(summary.getByTestId('describe-sentence-text')).toHaveText(Q12_SENTENCE);

  const chip = summary.getByTestId('describe-binding-chip');
  await expect(chip).toHaveAttribute('data-verdict', 'match');
  await expect(chip).toHaveText(`${q12.connectorCode} · match`);

  // The sentence cites the connector VERSION it was rendered from — the link
  // is the audit trail from the sentence back to the governed rule.
  const ruleLink = summary.getByTestId('describe-sentence-rule-link');
  await expect(ruleLink).toBeVisible();
  await expect(ruleLink).toHaveAttribute('href', /^\/rules\/[0-9a-f-]{36}/);

  // AXI-1553's rule: the recommended spec is SELECTED, never hand-built —
  // so what must render is the platform's own recommended chart.
  await expect(page.getByTestId('ga-recommended-chart')).toBeVisible();
});

test('AC11 (FR32) — the sentence is carried by a Descriptive Summary Decision, not only by the result view @SI-044', async ({ page }) => {
  test.skip(!q12.decisionId, 'Q12 produced no descriptive_summary decision draft');
  await page.goto(`/projects/${q12.projectId}/view-analyses/${q12.analysisId}/decisions/${q12.decisionId}`);

  const sentence = page.getByTestId('decision-result-sentence');
  await expect(sentence).toBeVisible();
  await expect(sentence).toContainText(Q12_SENTENCE);
  await expect(page.getByText('Descriptive Summary', { exact: false }).first()).toBeVisible();
});
