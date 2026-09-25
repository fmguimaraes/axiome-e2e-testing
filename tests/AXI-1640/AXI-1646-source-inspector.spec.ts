import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, openSession, type Arranged } from './harness/session';
import {
  uniq, syntheticTypeBody, registerTypeViaApi, deleteEvidenceType, createPanelViaApi, createGlossaryViaApi,
  deletePanelsByName,
} from './harness/seed';

/**
 * AXI-1650 (FR23, AC11) automating AXI-1646 (Source-candidate inspector, route
 * /evidence-candidate-inspector) — replaces AXI-886 Part E-888's hand-sent
 * `resolve_field_candidates` messages. Scenarios E2E-1640-F1..F4.
 * Arrangement: a synthetic type whose `marker_panel` field has TWO real candidates
 * (workspace_inventory <- an antibody panel; workspace_glossary <- a glossary category).
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;
let typeId: string;
let panelName: string;
const PAGE = '/evidence-candidate-inspector';

test.beforeAll(async () => {
  ctx = await arrange();
  const u = uniq();
  typeId = `e2e_insp_${u}`;
  panelName = `E2E insp panel ${u}`;
  const category = `e2e_cat_${u}`;
  await createPanelViaApi(ctx.api, ctx.t, panelName);
  await createGlossaryViaApi(ctx.api, ctx.t, category);
  await registerTypeViaApi(ctx.platform, syntheticTypeBody(typeId, [
    {
      field: 'marker_panel', kind: 'enum', required: true, capture_window: 'either',
      sources: [
        { scope: 'workspace_inventory', inventory_id: 'antibody_panels' },
        { scope: 'workspace_glossary', glossary_category: category },
        { scope: 'user_input' },
      ],
      resolution_order: ['workspace_inventory', 'workspace_glossary', 'user_input'],
      requires_user_confirmation: true,
    },
    {
      field: 'free_note', kind: 'text', required: false, capture_window: 'upload',
      sources: [{ scope: 'user_input' }], resolution_order: ['user_input'],
      requires_user_confirmation: false,
    },
  ]));
});
test.afterAll(async () => {
  if (!ctx) return;
  await deleteEvidenceType(ctx.platform, typeId).catch(() => undefined);
  await deletePanelsByName(ctx.api, ctx.t, panelName).catch(() => undefined);
  await disposeArranged(ctx);
});

async function inspectUpload(page: import('@playwright/test').Page) {
  await openSession(page, 'owner', ctx.t);
  await page.goto(PAGE);
  await expect(page.getByTestId('source-candidate-inspector')).toBeVisible();
  await page.getByTestId('inspector-type-select').selectOption(typeId);
  await page.getByTestId('inspector-window-select').selectOption('upload');
  await page.getByTestId('inspector-run').click();
  await expect(page.getByTestId('inspector-summary')).toBeVisible();
}

const summaryRow = (page: import('@playwright/test').Page, field: string) =>
  page.locator(`[data-testid="inspector-summary-row"][data-field="${field}"]`);
const fieldSection = (page: import('@playwright/test').Page, field: string) =>
  page.locator(`[data-testid="declaration-form-field"][data-field="${field}"]`);

test('AC6 @SI-034 — E2E-1640-F1: every candidate renders with a source chip, and a field with none asks for user input', async ({ page }) => {
  await inspectUpload(page);

  const row = summaryRow(page, 'marker_panel');
  await expect(row).toContainText('2'); // two candidates
  const chips = fieldSection(page, 'marker_panel').getByTestId('field-candidates').getByTestId('source-badge-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveAttribute('data-scope', 'workspace_inventory'); // resolution_order first
  await expect(chips.nth(1)).toHaveAttribute('data-scope', 'workspace_glossary');
  // The highest-priority candidate is chosen by default and needs confirmation.
  await expect(row).toContainText('awaiting confirmation');

  // A user_input-only field has no candidates.
  await expect(summaryRow(page, 'free_note')).toContainText('needs user input');
  await expect(fieldSection(page, 'free_note').getByTestId('field-candidates')).toHaveCount(0);
});

test('AC6 @SI-034 — E2E-1640-F2: re-picking another candidate changes the chosen source', async ({ page }) => {
  await inspectUpload(page);
  const row = summaryRow(page, 'marker_panel');
  const before = (await row.locator('td').nth(2).textContent()) ?? '';
  expect(before).not.toBe('none');

  await fieldSection(page, 'marker_panel').getByTestId('field-candidates').getByRole('button').nth(1).click();
  const after = (await row.locator('td').nth(2).textContent()) ?? '';
  expect(after).not.toBe(before);
  expect(after).toMatch(/glossary/i);
});

test('AC6 @SI-034 — E2E-1640-F3: a confirmation is invalidated by a re-pick and must be given again', async ({ page }) => {
  await inspectUpload(page);
  const row = summaryRow(page, 'marker_panel');
  const tick = fieldSection(page, 'marker_panel').getByTestId('confirmation-tick').getByRole('checkbox');

  await tick.check();
  await expect(row).toContainText('confirmed');
  await expect(row).not.toContainText('awaiting confirmation');

  // Re-pick a different candidate: the confirmation no longer applies.
  await fieldSection(page, 'marker_panel').getByTestId('field-candidates').getByRole('button').nth(1).click();
  await expect(row).toContainText('awaiting confirmation');
  await expect(tick).not.toBeChecked();

  // Confirming again works.
  await tick.check();
  await expect(row).toContainText('confirmed');
});

test('AC6 @SI-034 — E2E-1640-F4: the link window without a project is blocked client-side; with a project it resolves', async ({ page }) => {
  await openSession(page, 'owner', ctx.t);
  let resolves = 0;
  await page.route('**/evidence-types/resolve-field-candidates', async (route) => {
    resolves += 1;
    await route.continue();
  });
  await page.goto(PAGE);
  await page.getByTestId('inspector-type-select').selectOption(typeId);
  await page.getByTestId('inspector-window-select').selectOption('link');
  await expect(page.getByTestId('inspector-project-select')).toBeVisible();

  await page.getByTestId('inspector-run').click();
  await expect(page.getByTestId('inspector-error')).toContainText(/project is required/i);
  await expect(page.getByTestId('inspector-summary')).toHaveCount(0);
  expect(resolves).toBe(0);

  await page.getByTestId('inspector-project-select').selectOption({ label: 'AXI-1650 Evidence Registry Project' });
  await page.getByTestId('inspector-run').click();
  await expect(page.getByTestId('inspector-summary')).toBeVisible();
  expect(resolves).toBe(1);
  // Link window shows the fields eligible for it (`either`), not the upload-only one.
  await expect(summaryRow(page, 'marker_panel')).toBeVisible();
  await expect(summaryRow(page, 'free_note')).toHaveCount(0);
});
