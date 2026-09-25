import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, openSession, type Arranged } from './harness/session';
import { registerDraftEvidence, getEvidence, evidenceUrl } from './harness/seed';

/**
 * AXI-1665 (bug, epic AXI-1640) — the draft evidence detail page had no Finalize
 * action, so a draft could never reach Supersede from the UI. Scenario
 * E2E-1640-F1: draft -> Finalize via the confirm dialog -> status finalized and
 * Supersede enabled.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;

test.beforeAll(async () => {
  ctx = await arrange();
});
test.afterAll(async () => {
  await disposeArranged(ctx);
});

test('AC4 AC5 @SI-034 — E2E-1640-F1: a draft is finalized from the UI and Supersede becomes enabled', async ({ page }) => {
  const draft = await registerDraftEvidence(ctx.api, ctx.t);
  await openSession(page, 'owner', ctx.t);
  await page.goto(evidenceUrl(ctx.t, draft.evidence_id));

  await expect(page.getByTestId('evidence-status')).toHaveAttribute('data-status', 'draft');
  await expect(page.getByTestId('supersede-action')).toBeDisabled();
  await expect(page.getByTestId('finalize-action')).toBeEnabled();

  // Cancel leaves the draft untouched.
  await page.getByTestId('finalize-action').click();
  await expect(page.getByTestId('finalize-dialog')).toBeVisible();
  await page.getByTestId('finalize-cancel').click();
  await expect(page.getByTestId('finalize-dialog')).toHaveCount(0);
  await expect(page.getByTestId('evidence-status')).toHaveAttribute('data-status', 'draft');

  // Confirm finalizes.
  await page.getByTestId('finalize-action').click();
  await page.getByTestId('finalize-confirm').click();
  await expect(page.getByTestId('finalize-dialog')).toHaveCount(0);
  await expect(page.getByTestId('evidence-status')).toHaveAttribute('data-status', 'finalized');
  await expect(page.getByTestId('finalize-action')).toBeDisabled();
  await expect(page.getByTestId('finalize-disabled-reason')).toContainText(/already finalized/i);
  await expect(page.getByTestId('supersede-action')).toBeEnabled();

  const stored = await getEvidence(ctx.api, ctx.t, draft.evidence_id);
  expect(stored.status).toBe('finalized');
});
