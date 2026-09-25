import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, openSession, type Arranged } from './harness/session';
import {
  seedFinalizedEvidence, registerDraftEvidence, supersedeEvidence, getEvidence, evidenceUrl, uniq,
} from './harness/seed';

/**
 * AXI-1650 (FR23, AC11) automating AXI-1645 (Supersede action + version chain) —
 * replaces AXI-886 Part C (hand-sent `de_evidence_reference.supersede` message +
 * SQL chain/audit verification) with the real dialog and chain list.
 * Scenarios E2E-1640-D1..D5. A new supersede always yields a DRAFT v(N+1) — the
 * front end has no Finalize action, so the chain is asserted at that boundary.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;

test.beforeAll(async () => {
  ctx = await arrange();
});
test.afterAll(async () => {
  await disposeArranged(ctx);
});

test('AC4 AC5 @SI-034 — E2E-1640-D1: supersede is disabled with a reason on a draft and on a non-latest version, enabled on a finalized latest', async ({ page }) => {
  await openSession(page, 'owner', ctx.t);

  // Draft -> disabled, "finalize first".
  const draft = await registerDraftEvidence(ctx.api, ctx.t);
  await page.goto(evidenceUrl(ctx.t, draft.evidence_id));
  await expect(page.getByTestId('evidence-status')).toHaveAttribute('data-status', 'draft');
  await expect(page.getByTestId('supersede-action')).toBeDisabled();
  await expect(page.getByTestId('supersede-disabled-reason')).toContainText(/finalize/i);

  // Finalized latest -> enabled.
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await page.goto(evidenceUrl(ctx.t, v1.evidence_id));
  await expect(page.getByTestId('supersede-action')).toBeEnabled();
  await expect(page.getByTestId('supersede-disabled-reason')).toHaveCount(0);

  // After a supersede, v1 is no longer latest -> disabled, with a working link to the latest.
  const { new_evidence: v2 } = await supersedeEvidence(ctx.api, ctx.t, v1.evidence_id, `corrected ${uniq()}`);
  await page.goto(evidenceUrl(ctx.t, v1.evidence_id));
  await expect(page.getByTestId('supersede-action')).toBeDisabled();
  await expect(page.getByTestId('supersede-disabled-reason')).toContainText(/already superseded/i);
  await page.getByTestId('supersede-latest-link').click();
  await expect(page).toHaveURL(new RegExp(`/evidence-references/${v2.evidence_id}$`));
});

test('AC4 AC5 @SI-034 — E2E-1640-D2: dialog is prefilled; success navigates to the new draft v2 and the chain shows v1 Superseded', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t, { contrast: `original ${uniq()}` });
  await openSession(page, 'owner', ctx.t);
  await page.goto(evidenceUrl(ctx.t, v1.evidence_id));

  await page.getByTestId('supersede-action').click();
  const dialog = page.getByTestId('supersede-dialog');
  await expect(dialog).toBeVisible();
  // Prefill from the version being superseded.
  await expect(page.getByTestId('supersede-tool')).toHaveValue('DESeq2');
  await expect(page.getByTestId('supersede-contrast')).toHaveValue(v1.declared_contrast);
  await expect(page.getByTestId('supersede-numerator')).toHaveValue('treated');
  await expect(page.getByTestId('supersede-denominator')).toHaveValue('control');
  await expect(page.getByTestId('supersede-dataset-version')).toHaveValue(v1.dataset_version_id);

  const corrected = `corrected after QC re-review ${uniq()}`;
  await page.getByTestId('supersede-contrast').fill(corrected);
  await page.getByTestId('supersede-submit').click();

  // Lands on the new version's page: a DRAFT v2.
  await expect(page.getByTestId('supersede-dialog')).toHaveCount(0);
  await expect(page.getByTestId('evidence-version')).toHaveText('v2');
  await expect(page.getByTestId('evidence-status')).toHaveAttribute('data-status', 'draft');
  await expect(page.getByTestId('declared-value-declared_contrast')).toHaveText(corrected);

  // Chain: v1 Superseded (immutable, still linked), v2 Current.
  await expect(page.getByTestId('version-chain-row-1')).toBeVisible();
  await expect(page.getByTestId('version-chain-superseded-1')).toBeVisible();
  await expect(page.getByTestId('version-chain-current-2')).toBeVisible();
  await expect(page.getByTestId('version-chain-superseded-2')).toHaveCount(0);

  // Server truth (replaces the SQL check): v1 wired to v2 and untouched.
  const v2Id = page.url().split('/').pop()!;
  const v1After = await getEvidence(ctx.api, ctx.t, v1.evidence_id);
  const v2After = await getEvidence(ctx.api, ctx.t, v2Id);
  expect(v1After.superseded_by_evidence_id).toBe(v2Id);
  expect(v1After.declared_contrast).toBe(v1.declared_contrast);
  expect(v2After.supersedes_evidence_id).toBe(v1.evidence_id);
  expect(v2After.evidence_version).toBe(2);
  expect(v2After.content_chain_root_id).toBe(v1.content_chain_root_id);

  // The chain link navigates back to the immutable v1.
  await page.getByTestId('version-chain-link-1').click();
  await expect(page.getByTestId('evidence-version')).toHaveText('v1');
});

test('AC5 @SI-034 — E2E-1640-D3: a stale page gets the 409 conflict message with a working "latest" link', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await openSession(page, 'owner', ctx.t);
  await page.goto(evidenceUrl(ctx.t, v1.evidence_id));
  await expect(page.getByTestId('supersede-action')).toBeEnabled();
  await page.getByTestId('supersede-action').click();
  await expect(page.getByTestId('supersede-dialog')).toBeVisible();

  // Someone else supersedes v1 while this page is open (page state is now stale).
  const { new_evidence: v2 } = await supersedeEvidence(ctx.api, ctx.t, v1.evidence_id, `raced ${uniq()}`);

  await page.getByTestId('supersede-contrast').fill(`my late correction ${uniq()}`);
  await page.getByTestId('supersede-submit').click();
  const err = page.getByTestId('supersede-error');
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute('data-error-kind', 'conflict');
  await expect(err).toContainText(/already superseded/i);
  await page.getByTestId('supersede-error-latest-link').click();
  await expect(page).toHaveURL(new RegExp(`/evidence-references/${v2.evidence_id}$`));
  await expect(page.getByTestId('evidence-version')).toHaveText('v2');
});

test('AC5 @SI-034 — E2E-1640-D4: client-side validation blocks a bad correction with per-field errors and sends nothing', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await openSession(page, 'owner', ctx.t);
  let posts = 0;
  await page.route('**/de-evidence-references/*/supersede', async (route) => {
    posts += 1;
    await route.continue();
  });
  await page.goto(evidenceUrl(ctx.t, v1.evidence_id));
  await page.getByTestId('supersede-action').click();

  await page.getByTestId('supersede-contrast').fill('abc');
  await page.getByTestId('supersede-numerator').fill('');
  await page.getByTestId('supersede-denominator').fill('   ');
  await page.getByTestId('supersede-dataset-version').fill('not-a-uuid');
  await page.getByTestId('supersede-submit').click();

  await expect(page.getByTestId('supersede-contrast-error')).toContainText(/at least 5/i);
  await expect(page.getByTestId('supersede-numerator-error')).toBeVisible();
  await expect(page.getByTestId('supersede-denominator-error')).toBeVisible();
  await expect(page.getByTestId('supersede-dataset-version-error')).toBeVisible();
  await expect(page.getByTestId('supersede-dialog')).toBeVisible();
  expect(posts).toBe(0);
});

test('AC5 @SI-034 — E2E-1640-D5: a double-click submits once (button disabled while in flight)', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await openSession(page, 'owner', ctx.t);
  let posts = 0;
  await page.route('**/de-evidence-references/*/supersede', async (route) => {
    posts += 1;
    // Hold the response so the in-flight window is observable (a condition, not a sleep in the spec).
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto(evidenceUrl(ctx.t, v1.evidence_id));
  await page.getByTestId('supersede-action').click();
  await page.getByTestId('supersede-contrast').fill(`double click ${uniq()}`);

  const submit = page.getByTestId('supersede-submit');
  await submit.click();
  await expect(submit).toBeDisabled();
  await submit.click({ force: true, noWaitAfter: true, timeout: 2000 }).catch(() => undefined);

  await expect(page.getByTestId('evidence-version')).toHaveText('v2');
  expect(posts).toBe(1);
  const after = await getEvidence(ctx.api, ctx.t, v1.evidence_id);
  expect(after.superseded_by_evidence_id).toBeTruthy();
});
