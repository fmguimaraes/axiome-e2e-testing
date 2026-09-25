import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, openSession, type Arranged } from './harness/session';
import { seedFinalizedEvidence, supersedeEvidence, uniq } from './harness/seed';

/**
 * AXI-1668 (audit view honesty): when the gateway reports more events than the
 * page limit, the panel says so via `audit-truncated-notice`.
 * Scenarios E2E-1640-G4 (contract, real API) and G5 (UI, MOCKED envelope).
 *
 * G5 mocks the audit-events response with page.route: seeding more than the
 * default page limit (100) real audit events per evidence is disproportionate
 * for a single notice. The real envelope contract is asserted un-mocked in G4.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;
test.beforeAll(async () => { ctx = await arrange(); });
test.afterAll(async () => { await disposeArranged(ctx); });

const auditUrl = (id: string, projectId: string, qs = '') =>
  `/api/v1/de-evidence-references/${id}/audit-events?project_id=${projectId}&envelope=true${qs}`;

test('AC9 @SI-031 — E2E-1640-G4: the real API flags truncation in the envelope when events exceed the limit', async () => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await supersedeEvidence(ctx.api, ctx.t, v1.evidence_id, `trunc chain ${uniq()}`);

  const full = await ctx.api.get(auditUrl(v1.evidence_id, ctx.t.projectId), ctx.t.headers);
  expect(full.status).toBe(200);
  expect(full.body.truncated).toBe(false);
  expect(full.body.items.length).toBeGreaterThanOrEqual(2);

  const cut = await ctx.api.get(auditUrl(v1.evidence_id, ctx.t.projectId, '&limit=1'), ctx.t.headers);
  expect(cut.status).toBe(200);
  expect(cut.body.truncated).toBe(true);
  expect(cut.body.items).toHaveLength(1);
  expect(cut.body.limit).toBe(1);
});

test('AC9 @SI-031 — E2E-1640-G5: the panel shows audit-truncated-notice on a truncated envelope, and not otherwise (mocked response)', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  const real = await ctx.api.get(auditUrl(v1.evidence_id, ctx.t.projectId), ctx.t.headers);
  let truncated = true;
  await page.route(/\/de-evidence-references\/[^/]+\/audit-events/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: real.body.items, truncated, limit: 100 }) }));

  await openSession(page, 'owner', ctx.t);
  await page.goto('/audit-logs');
  await page.getByTestId('evidence-audit-evidence-id').fill(v1.evidence_id);
  await page.getByTestId('evidence-audit-project-id').fill(ctx.t.projectId);
  await page.getByTestId('evidence-audit-submit').click();
  await expect(page.getByTestId('evidence-audit-table')).toBeVisible();
  await expect(page.getByTestId('audit-truncated-notice')).toBeVisible();

  truncated = false;
  await page.getByTestId('evidence-audit-submit').click();
  await expect(page.getByTestId('evidence-audit-table')).toBeVisible();
  await expect(page.getByTestId('audit-truncated-notice')).toHaveCount(0);
});
