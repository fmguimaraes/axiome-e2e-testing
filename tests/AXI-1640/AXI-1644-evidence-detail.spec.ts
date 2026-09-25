import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, openSession, type Arranged } from './harness/session';
import {
  seedFinalizedEvidence, supersedeEvidence, getEvidence, evidenceUrl, nullDeclaredMetadata, uniq,
} from './harness/seed';

/**
 * AXI-1650 (FR23, AC11) automating AXI-1644 + AXI-1651 (Evidence detail page and
 * the declared_metadata read contract) — replaces AXI-886 Part B (SQL inspection of
 * storage_region / chain columns) and Part D (badge "playground") with the real page.
 * Scenarios E2E-1640-C1..C5. Fixtures are made through the gateway (register-existing
 * + finalize): the front end has no Finalize action.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;

test.beforeAll(async () => {
  ctx = await arrange();
});
test.afterAll(async () => {
  await disposeArranged(ctx);
});

test('AC4 @SI-034 — E2E-1640-C1: a finalized evidence shows version, immutability, and its storage-region badge', async ({ page }) => {
  const ev = await seedFinalizedEvidence(ctx.api, ctx.t);
  const persisted = await getEvidence(ctx.api, ctx.t, ev.evidence_id);
  await openSession(page, 'owner', ctx.t);
  await page.goto(evidenceUrl(ctx.t, ev.evidence_id));

  await expect(page.getByTestId('evidence-reference-detail')).toBeVisible();
  await expect(page.getByTestId('evidence-version')).toHaveText('v1');
  await expect(page.getByTestId('evidence-status')).toHaveAttribute('data-status', 'finalized');
  await expect(page.getByTestId('evidence-status')).toContainText('immutable');
  const badge = page.getByTestId('storage-region-badge');
  await expect(badge).toBeVisible();
  // The badge renders the region the backend persisted (no SQL needed to read it).
  await expect(badge).toContainText(persisted.storage_region);
  await expect(badge).toHaveAttribute('aria-label', new RegExp(persisted.storage_region));
  // Finalized evidence is read-only: no edit control on the declared block.
  await expect(page.getByTestId('declared-metadata-block').getByRole('textbox')).toHaveCount(0);
});

test('AC4 @SI-034 — E2E-1640-C2: declared values carry REAL per-value provenance (source chip, confirmation) for a new evidence', async ({ page }) => {
  const contrast = `IFN vs untreated ${uniq()}`;
  const ev = await seedFinalizedEvidence(ctx.api, ctx.t, { contrast });
  await openSession(page, 'owner', ctx.t);
  await page.goto(evidenceUrl(ctx.t, ev.evidence_id));

  for (const field of ['declared_tool', 'declared_contrast', 'declared_direction']) {
    const row = page.getByTestId(`declared-field-${field}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('source-badge-chip')).toHaveAttribute('data-scope', 'user_input');
    await expect(page.getByTestId(`declared-confirmed-${field}`)).toContainText('confirmed');
    // Persisted provenance, NOT the synthesized fallback (AXI-1651 exposes declared_metadata).
    await expect(page.getByTestId(`declared-legacy-${field}`)).toHaveCount(0);
  }
  await expect(page.getByTestId('declared-value-declared_tool')).toHaveText('DESeq2');
  await expect(page.getByTestId('declared-value-declared_contrast')).toHaveText(contrast);
  await expect(page.getByTestId('declared-value-declared_direction')).toContainText('treated');
});

test('AC4 @SI-034 — E2E-1640-C3: a legacy record (no persisted declared_metadata) shows the synthesized "legacy record" tag', async ({ page }) => {
  const ev = await seedFinalizedEvidence(ctx.api, ctx.t);
  expect(nullDeclaredMetadata(ev.evidence_id), 'legacy fixture needs the local Postgres container').toBe(true);
  // Precondition through the contract: the read now carries no declared_metadata.
  const persisted = await getEvidence(ctx.api, ctx.t, ev.evidence_id);
  expect(persisted.declared_metadata ?? null).toBeNull();

  await openSession(page, 'owner', ctx.t);
  await page.goto(evidenceUrl(ctx.t, ev.evidence_id));
  for (const field of ['declared_tool', 'declared_contrast', 'declared_direction']) {
    await expect(page.getByTestId(`declared-legacy-${field}`)).toHaveText('legacy record');
    // Legacy values are credited to user_input.
    await expect(page.getByTestId(`declared-field-${field}`).getByTestId('source-badge-chip')).toHaveAttribute('data-scope', 'user_input');
  }
  await expect(page.getByTestId('declared-value-declared_tool')).toHaveText('DESeq2');
});

test('AC4 @SI-034 — E2E-1640-C4: QC flags show blocking corruption distinctly from advisory findings', async ({ page }) => {
  const ev = await seedFinalizedEvidence(ctx.api, ctx.t, { flags: ['xlsx_date_corruption_detected', 'low_row_count'] });
  await openSession(page, 'owner', ctx.t);
  await page.goto(evidenceUrl(ctx.t, ev.evidence_id));

  const blocking = page.getByTestId('qc-flag-xlsx_date_corruption_detected');
  await expect(blocking).toHaveAttribute('data-severity', 'blocking');
  await expect(blocking).toContainText(/acknowledged before finalization/i);
  const advisory = page.getByTestId('qc-flag-low_row_count');
  await expect(advisory).toHaveAttribute('data-severity', 'advisory');
  await expect(advisory).toContainText(/advisory/i);

  const clean = await seedFinalizedEvidence(ctx.api, ctx.t);
  await page.goto(evidenceUrl(ctx.t, clean.evidence_id));
  await expect(page.getByTestId('qc-flags-none')).toBeVisible();
});

test('AC4 @SI-034 — E2E-1640-C5: a superseded version shows "updated version available" linking to the latest; the latest does not', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  const { new_evidence: v2 } = await supersedeEvidence(ctx.api, ctx.t, v1.evidence_id, `corrected ${uniq()}`);
  await openSession(page, 'owner', ctx.t);

  await page.goto(evidenceUrl(ctx.t, v1.evidence_id));
  const indicator = page.getByTestId('superseded-version-indicator');
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText('Updated version available');
  await indicator.getByRole('link', { name: 'v2' }).click();
  await expect(page).toHaveURL(new RegExp(`/evidence-references/${v2.evidence_id}$`));
  await expect(page.getByTestId('evidence-version')).toHaveText('v2');
  await expect(page.getByTestId('superseded-version-indicator')).toHaveCount(0);
});
