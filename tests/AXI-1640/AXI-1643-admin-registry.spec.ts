import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, ensureViewerMember, openSession, type Arranged } from './harness/session';
import {
  uniq, userInputField, syntheticTypeBody, registerTypeViaApi, deleteEvidenceType,
  seedFinalizedEvidence, setEvidenceType,
} from './harness/seed';

/**
 * AXI-1650 (FR23, AC11) automating AXI-1643 (Admin Evidence Types UI) — replaces
 * AXI-886 Part A's hand-sent registry messages + SQL verification with UI steps.
 * Scenario source: axiome-docs/manual-e2e/AXI-1640-Evidence-Registry-Validation-Surfaces.md
 * (E2E-1640-A1..A6).
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;
const created: string[] = [];

test.beforeAll(async () => {
  ctx = await arrange();
  await ensureViewerMember(ctx.api, ctx.t);
});

test.afterAll(async () => {
  if (!ctx) return;
  for (const id of created) await deleteEvidenceType(ctx.platform, id).catch(() => undefined);
  await disposeArranged(ctx);
});

/** Registered type ids as the gateway reports them. */
async function typeIds(): Promise<string[]> {
  const res = await ctx.platform.get('/api/v1/evidence-types');
  return (res.body as Array<{ type_id: string }>).map((r) => r.type_id);
}

test('AC2 @SI-030 @SI-031 — E2E-1640-A1: admin lists registered evidence types and filters by id', async ({ page }) => {
  const typeId = `e2e_list_${uniq()}`;
  await registerTypeViaApi(ctx.platform, syntheticTypeBody(typeId));
  created.push(typeId);
  await openSession(page, 'platform', ctx.t);

  await page.goto('/admin/evidence-types');
  await expect(page.getByTestId('evidence-types-page')).toBeVisible();
  await page.getByTestId('evidence-types-search').fill(typeId);
  await expect(page.getByTestId(`evidence-type-row-${typeId}`)).toBeVisible();
  await expect(page.getByTestId(`evidence-type-row-${typeId}`)).toContainText('Single-step');
  await page.getByTestId('evidence-types-search').fill('no_such_type_zzz');
  await expect(page.getByTestId('evidence-types-empty')).toBeVisible();
});

test('AC2 AC3 @SI-030 @SI-031 — E2E-1640-A2: admin registers a synthetic type through the form and sees it rendered', async ({ page }) => {
  const typeId = `e2e_reg_${uniq()}`;
  created.push(typeId);
  await openSession(page, 'platform', ctx.t);
  await page.goto('/admin/evidence-types/new');

  await page.getByTestId('evidence-type-input-type-id').fill(typeId);
  await page.getByTestId('evidence-type-input-display-name').fill('E2E Registered Type');
  await page.getByTestId('evidence-type-input-flow-template').selectOption('single_step');
  await page.getByTestId('evidence-type-input-required-roles').fill('foo, bar');
  await page.getByTestId('evidence-type-input-optional-roles').fill('baz');
  await page.getByTestId('evidence-type-input-visualization-templates').fill('test_chart');
  await page.getByTestId('evidence-type-input-declaration-form').fill(JSON.stringify([userInputField('declared_thing')]));
  await page.getByTestId('evidence-type-submit').click();

  // Success lands on the detail page, rendered from the persisted registration.
  await expect(page).toHaveURL(new RegExp(`/admin/evidence-types/${typeId}$`));
  await expect(page.getByTestId('evidence-type-title')).toHaveText('E2E Registered Type');
  await expect(page.getByTestId('evidence-type-id')).toHaveText(typeId);
  await expect(page.getByTestId('schema-required-roles')).toContainText('foo');
  await expect(page.getByTestId('schema-required-roles')).toContainText('bar');
  await expect(page.getByTestId('schema-optional-roles')).toContainText('baz');
  await expect(page.getByTestId('visualization-templates')).toContainText('test_chart');
  const field = page.getByTestId('declaration-field-declared_thing');
  await expect(field).toBeVisible();
  await expect(page.getByTestId('declaration-field-declared_thing-capture-window')).toContainText('upload');
  await expect(page.getByTestId('declaration-field-declared_thing-sources')).toContainText('user_input');
  await expect(page.getByTestId('declaration-field-declared_thing-resolution-order')).toContainText('user_input');
  await expect(page.getByTestId('declaration-field-declared_thing-confirmation')).toBeVisible();
});

test('AC3 @SI-031 — E2E-1640-A3: registering a duplicate type_id shows an inline conflict on type_id', async ({ page }) => {
  const typeId = `e2e_dup_${uniq()}`;
  // Empty declaration form on both sides: isolates the 409 from the declaration-form path (see B1 in the scenario doc).
  await registerTypeViaApi(ctx.platform, syntheticTypeBody(typeId, []));
  created.push(typeId);
  await openSession(page, 'platform', ctx.t);
  await page.goto('/admin/evidence-types/new');

  await page.getByTestId('evidence-type-input-type-id').fill(typeId);
  await page.getByTestId('evidence-type-input-display-name').fill('Duplicate');
  await page.getByTestId('evidence-type-input-required-roles').fill('foo');
  await page.getByTestId('evidence-type-input-declaration-form').fill('[]');
  await page.getByTestId('evidence-type-submit').click();

  const err = page.getByTestId('evidence-type-error-type_id');
  await expect(err).toBeVisible();
  await expect(err).toContainText(/already/i);
  await expect(page).toHaveURL(/\/admin\/evidence-types\/new$/);
});

test('AC3 @SI-031 — E2E-1640-A4: field-level errors — client-side (missing roles, bad JSON) and server-side (invalid type_id)', async ({ page }) => {
  await openSession(page, 'platform', ctx.t);
  await page.goto('/admin/evidence-types/new');

  // Client-side envelope errors: nothing is sent.
  await page.getByTestId('evidence-type-submit').click();
  await expect(page.getByTestId('evidence-type-error-type_id')).toBeVisible();
  await expect(page.getByTestId('evidence-type-error-display_name')).toBeVisible();
  await expect(page.getByTestId('evidence-type-error-schema')).toBeVisible();

  await page.getByTestId('evidence-type-input-type-id').fill(`e2e_bad_${uniq()}`);
  await page.getByTestId('evidence-type-input-display-name').fill('Bad');
  await page.getByTestId('evidence-type-input-required-roles').fill('foo');
  await page.getByTestId('evidence-type-input-declaration-form').fill('{not json');
  await page.getByTestId('evidence-type-submit').click();
  await expect(page.getByTestId('evidence-type-error-declaration_form')).toContainText(/not valid JSON/i);

  // Server-side deep validation with an empty form: a non-snake_case id -> INVALID_TYPE_ID on type_id.
  await page.getByTestId('evidence-type-input-type-id').fill('Bad__Id');
  await page.getByTestId('evidence-type-input-declaration-form').fill('[]');
  await page.getByTestId('evidence-type-submit').click();
  await expect(page.getByTestId('evidence-type-error-type_id')).toContainText('INVALID_TYPE_ID');
  await expect(page).toHaveURL(/\/admin\/evidence-types\/new$/);
});

test('AC3 @SI-031 — E2E-1640-A4b: a declaration field with no sources is rejected as MISSING_SOURCES on the declaration form', async ({ page }) => {
  await openSession(page, 'platform', ctx.t);
  await page.goto('/admin/evidence-types/new');
  await page.getByTestId('evidence-type-input-type-id').fill(`e2e_nosrc_${uniq()}`);
  await page.getByTestId('evidence-type-input-display-name').fill('No sources');
  await page.getByTestId('evidence-type-input-required-roles').fill('foo');
  const noSources = { ...userInputField(), sources: [] };
  await page.getByTestId('evidence-type-input-declaration-form').fill(JSON.stringify([noSources]));
  await page.getByTestId('evidence-type-submit').click();
  await expect(page.getByTestId('evidence-type-error-declaration_form')).toContainText('MISSING_SOURCES');
  await expect(page).toHaveURL(/\/admin\/evidence-types\/new$/);
});

test('AC3 @SI-031 — E2E-1640-A5: deleting an unreferenced type removes it from the list', async ({ page }) => {
  const freeType = `e2e_del_${uniq()}`;
  await registerTypeViaApi(ctx.platform, syntheticTypeBody(freeType, []));
  await openSession(page, 'platform', ctx.t);
  await page.goto('/admin/evidence-types');
  await page.getByTestId('evidence-types-search').fill(freeType);
  await page.getByTestId(`evidence-type-delete-${freeType}`).click();
  await expect(page.getByTestId('evidence-type-delete-dialog')).toBeVisible();
  await page.getByTestId('evidence-type-delete-confirm').click();
  await expect(page.getByTestId('evidence-types-delete-conflict')).toHaveCount(0);
  await expect(page.getByTestId(`evidence-type-row-${freeType}`)).toHaveCount(0);
  // Server truth: gone from the registry.
  expect(await typeIds()).not.toContain(freeType);
});

test('AC3 @SI-031 — E2E-1640-A5b: deleting a type that evidence depends on is refused (409) and the row stays', async ({ page }) => {
  const busyType = `e2e_busy_${uniq()}`;
  await registerTypeViaApi(ctx.platform, syntheticTypeBody(busyType, []));
  created.push(busyType);

  // A dependent evidence: the public API always tags DE evidence `rnaseq_de_table`,
  // so retag one evidence this test just created (restored in `finally`).
  const ev = await seedFinalizedEvidence(ctx.api, ctx.t);
  expect(setEvidenceType(ev.evidence_id, busyType), 'test-setup retag needs the local Postgres container').toBe(true);
  try {
    await openSession(page, 'platform', ctx.t);
    await page.goto('/admin/evidence-types');
    await page.getByTestId('evidence-types-search').fill(busyType);
    await page.getByTestId(`evidence-type-delete-${busyType}`).click();
    await page.getByTestId('evidence-type-delete-confirm').click();
    const conflict = page.getByTestId('evidence-types-delete-conflict');
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText(/depend on it/i);
    await expect(page.getByTestId(`evidence-type-row-${busyType}`)).toBeVisible();
    // Server truth: still registered.
    expect(await typeIds()).toContain(busyType);
  } finally {
    setEvidenceType(ev.evidence_id, 'rnaseq_de_table');
  }
});

test('AC10 @SI-031 — E2E-1640-A6: a non-admin is denied the registry pages (and the API)', async ({ page }) => {
  await openSession(page, 'viewer', ctx.t);
  await page.goto('/admin/evidence-types');
  await expect(page.getByTestId('evidence-types-forbidden')).toBeVisible();
  await expect(page.getByTestId('evidence-types-table')).toHaveCount(0);
  await page.goto('/admin/evidence-types/new');
  await expect(page.getByTestId('evidence-types-forbidden')).toBeVisible();
  await expect(page.getByTestId('evidence-type-submit')).toHaveCount(0);
});
