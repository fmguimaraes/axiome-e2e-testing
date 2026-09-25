import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, openSession, type Arranged } from './harness/session';
import { seedFinalizedEvidence, supersedeEvidence, uniq } from './harness/seed';

/**
 * AXI-1650 (FR23, AC11) automating AXI-1649 (Audit view: canonical scope.action +
 * per-type alias, on /audit-logs) — replaces the SQL reads of
 * `de_evidence_reference_audit_logs` in AXI-886 Part C step 4.
 * Scenarios E2E-1640-G1..G3.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;

test.beforeAll(async () => {
  ctx = await arrange();
});
test.afterAll(async () => {
  await disposeArranged(ctx);
});

async function loadEvents(page: import('@playwright/test').Page, evidenceId: string, event?: string) {
  await page.getByTestId('evidence-audit-evidence-id').fill(evidenceId);
  await page.getByTestId('evidence-audit-project-id').fill(ctx.t.projectId);
  await page.getByTestId('evidence-audit-event-filter').fill(event ?? '');
  await page.getByTestId('evidence-audit-submit').click();
}

const rowFor = (page: import('@playwright/test').Page, canonical: string) =>
  page.getByTestId('evidence-audit-row').filter({ has: page.getByTestId('evidence-audit-canonical').getByText(canonical, { exact: true }) });

test('AC9 @SI-031 — E2E-1640-G1: audit rows show the canonical scope.action with the per-type alias beside it', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await supersedeEvidence(ctx.api, ctx.t, v1.evidence_id, `audit chain ${uniq()}`);
  await openSession(page, 'owner', ctx.t);
  await page.goto('/audit-logs');
  await expect(page.getByTestId('evidence-audit-panel')).toBeVisible();
  await expect(page.getByTestId('evidence-audit-submit')).toBeDisabled(); // ids required first

  await loadEvents(page, v1.evidence_id);
  await expect(page.getByTestId('evidence-audit-table')).toBeVisible();
  const finalized = rowFor(page, 'evidence.finalized');
  await expect(finalized).toHaveCount(1);
  await expect(finalized.getByTestId('evidence-audit-alias')).toHaveText('de_evidence.finalized');
  const superseded = rowFor(page, 'evidence.superseded');
  await expect(superseded).toHaveCount(1);
  await expect(superseded.getByTestId('evidence-audit-alias')).toHaveText('de_evidence.superseded_by_new_version');
});

test('AC9 @SI-031 — E2E-1640-G2: filtering by the canonical name and by the alias returns the same rows', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await openSession(page, 'owner', ctx.t);
  await page.goto('/audit-logs');

  await loadEvents(page, v1.evidence_id, 'evidence.finalized');
  await expect(page.getByTestId('evidence-audit-row')).toHaveCount(1);
  const canonicalHit = await page.getByTestId('evidence-audit-row').first().innerText();
  await expect(page.getByTestId('evidence-audit-canonical')).toHaveText('evidence.finalized');

  await loadEvents(page, v1.evidence_id, 'de_evidence.finalized');
  await expect(page.getByTestId('evidence-audit-row')).toHaveCount(1);
  await expect(page.getByTestId('evidence-audit-canonical')).toHaveText('evidence.finalized');
  expect(await page.getByTestId('evidence-audit-row').first().innerText()).toBe(canonicalHit);
});

test('AC9 @SI-031 — E2E-1640-G3: an unknown event name is a visible error, not an empty list', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await openSession(page, 'owner', ctx.t);
  await page.goto('/audit-logs');

  await loadEvents(page, v1.evidence_id, 'bogus.name');
  const err = page.getByTestId('evidence-audit-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText(/unknown audit event/i);
  await expect(page.getByTestId('evidence-audit-empty')).toHaveCount(0);
});
