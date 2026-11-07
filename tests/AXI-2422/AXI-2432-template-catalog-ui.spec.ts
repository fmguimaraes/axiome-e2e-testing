import { expect, test, type Browser, type Page } from '@playwright/test';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { catalogApi, type CatalogApi } from './harness/catalog-api';

/**
 * AXI-2432 (epic AXI-2422 — Analysis Template Library, story G — FR33–FR37, AC9, AC11; SI-035,
 * SI-030; G4/G5 also SI-010, SI-069). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2432 (G1–G7).
 *
 * The catalog UI over the AXI-2430 API: `/analysis-templates` (table, inline icon actions),
 * `/analysis-templates/:id` (composition, validator report, version history, derivedFrom,
 * breadcrumb name), `/analysis-templates/new` (compose with the live validator, palette from
 * `GET /analysis-templates/compositions/node-library`), and the server-advised write controls.
 *
 * Self-provisioned: a fresh workspace the platform admin leaves; two workspace Admins (author,
 * approver — both hold `template:write`, AXI-2429) and a Viewer, all throwaway self-registered
 * users signed in through the browser. Only WORKSPACE templates are written (never a system row);
 * every template the run created is soft-deleted in `afterAll`. Needs a gateway serving the
 * AXI-2432 back branch for G4/G5 (the node-library route) and this branch's front.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let world: PrivateProjectsWorld;
let author: UiActor;
let approver: UiActor;
let viewer: UiActor;
let asAuthor: CatalogApi;
let asApprover: CatalogApi;
let t1: { id: string; label: string; versions: { id: string; templateVersion: string }[] };
let seeded: { id: string; label: string };
let composed: { id: string; label: string } | null = null;
const created: string[] = [];

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const key = (label: string) => `e2e-axi2432-${label}-${RUN}`;

async function signIn(page: Page, actor: UiActor): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, actor, world.workspaceId);
}

/** A page in its own browser context (its own localStorage session), on the project's baseURL. */
async function pageFor(browser: Browser, actor: UiActor): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, actor);
  return page;
}

async function openCatalog(page: Page): Promise<void> {
  await page.goto('/analysis-templates');
  // A fresh context boots the shell (session, organization, workspace) before the catalog's first read.
  await expect(page.getByTestId('analysis-templates-table')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  author = await uiActor('axi2432-author', world.workspaceId);
  approver = await uiActor('axi2432-approver', world.workspaceId);
  viewer = await uiActor('axi2432-viewer', world.workspaceId);
  await world.addMember(author, 'admin');
  await world.addMember(approver, 'admin');
  await world.addMember(viewer, 'viewer');
  await world.leaveWorkspace();
  for (const actor of [author, approver, viewer]) await silenceTours(actor.accessToken);

  asAuthor = catalogApi(author.api);
  asApprover = catalogApi(approver.api);
  const list = await asAuthor.list('limit=100');
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  t1 = list.body.data.find((e: any) => e.templateId === 'T1');
  expect(t1, 'seeded system template T1').toBeTruthy();
  const res = await asAuthor.create({ templateId: key('seeded'), label: `E2E AXI-2432 seeded ${RUN}`, scope: 'workspace', derivedFromId: t1.id });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  seeded = res.body;
  created.push(seeded.id);
});

test.afterAll(async () => {
  for (const id of created) await asAuthor?.remove(id).catch(() => undefined);
  for (const actor of [author, approver, viewer]) await actor?.api.dispose().catch(() => undefined);
  await world?.dispose();
});

test.describe('AXI-2432 — Analysis Template catalog UI', { tag: ['@SI-035', '@SI-030'] }, () => {
  test('AC11 FR33 FR36 AXI-2432.G1 the nav entry opens the catalog table with scope, status and verdict columns', async ({ page }) => {
    // Arrange
    await signIn(page, viewer);
    await page.goto('/');
    // Act
    await page.locator('nav[data-tour="app-shell.nav-sidebar"] a[href="/analysis-templates"]').first().click();
    // Assert
    await expect(page).toHaveURL(/\/analysis-templates$/);
    const table = page.getByTestId('analysis-templates-table');
    await expect(table).toBeVisible();
    for (const header of ['Scope', 'Status', 'Validator']) await expect(table.locator('thead')).toContainText(header);
    await expect(page.getByTestId(`analysis-template-scope-${t1.id}`)).toHaveText('System');
    await expect(page.getByTestId(`analysis-template-verdict-${t1.id}`)).toHaveText('PASS');
    await expect(page.getByTestId(`analysis-template-status-${t1.id}`)).toContainText('Published');
    for (const action of ['view', 'edit', 'version', 'archive']) await expect(page.getByTestId(`analysis-template-${action}-${t1.id}`)).toBeVisible();
    await expect(page.locator('[data-testid="analysis-templates-table"] tbody tr[data-template-id^="T"]')).toHaveCount(5);
    await expect(page.getByRole('button', { name: /^back$/i })).toHaveCount(0);
  });

  test('FR37 AC11 AXI-2432.G2 write actions follow the caller permission (Viewer disabled; author enabled on a workspace row only)', async ({ browser }) => {
    // Arrange
    const viewerPage = await pageFor(browser, viewer);
    const authorPage = await pageFor(browser, author);
    // Act
    await openCatalog(viewerPage);
    await openCatalog(authorPage);
    // Assert — the Viewer holds no template:write
    await expect(viewerPage.getByTestId('analysis-template-new')).toBeDisabled();
    for (const action of ['edit', 'version', 'archive']) {
      await expect(viewerPage.getByTestId(`analysis-template-${action}-${seeded.id}`)).toBeDisabled();
      await expect(viewerPage.getByTestId(`analysis-template-${action}-${t1.id}`)).toBeDisabled();
    }
    await expect(viewerPage.getByTestId(`analysis-template-view-${seeded.id}`)).toBeEnabled();
    await expect(viewerPage.getByTestId(`analysis-template-edit-${seeded.id}`)).toHaveAttribute('title', /template:write/);
    // Assert — the author: their workspace row is writable, the system row is not
    await expect(authorPage.getByTestId('analysis-template-new')).toBeEnabled();
    await expect(authorPage.getByTestId(`analysis-template-edit-${seeded.id}`)).toBeEnabled();
    await expect(authorPage.getByTestId(`analysis-template-edit-${t1.id}`)).toBeDisabled();
    await expect(authorPage.getByTestId(`analysis-template-version-${t1.id}`)).toBeDisabled();
    await expect(authorPage.getByTestId(`analysis-template-edit-${t1.id}`)).toHaveAttribute('title', /platform administrator/);
    await viewerPage.context().close();
    await authorPage.context().close();
  });

  test('FR34 FR36 AC11 AXI-2432.G3 detail shows steps, slots, parameters, outputs, the validator report, history, derivedFrom and the breadcrumb name', async ({ page }) => {
    // Arrange
    await signIn(page, viewer);
    await openCatalog(page);
    const v03 = t1.versions.find((v) => v.templateVersion === '0.3')!;
    // Act
    await page.getByTestId(`analysis-template-view-${t1.id}`).click();
    await page.getByTestId(`template-version-row-${v03.id}`).click();
    // Assert
    await expect(page).toHaveURL(new RegExp(`/analysis-templates/${t1.id}$`));
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(t1.label);
    await expect(page.getByTestId('template-versions-table').locator('tbody tr')).toHaveCount(t1.versions.length);
    await expect(page.getByTestId('template-selected-version')).toHaveAttribute('data-version', '0.3');
    for (const part of ['template-steps', 'template-slots', 'template-parameters', 'template-outputs']) await expect(page.getByTestId(part)).toBeVisible();
    const report = page.getByTestId('template-validator-report');
    await expect(report).toHaveAttribute('data-verdict', 'PASS');
    await expect(report.locator('[data-testid^="template-validator-report-check-"]')).toHaveCount(5);
    await expect(page.getByRole('button', { name: /^back$/i })).toHaveCount(0);

    // Act — the seeded workspace template was derived from T1
    await page.goto(`/analysis-templates/${seeded.id}`);
    // Assert
    const derived = page.getByTestId('template-derived-from');
    await expect(derived).toContainText(t1.label);
    await expect(derived.getByRole('link')).toHaveAttribute('href', `/analysis-templates/${t1.id}`);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(seeded.label);
  });

  test.describe('compose (needs the AXI-2432 node-library route)', { tag: ['@SI-010', '@SI-069'] }, () => {
    test('FR35 AC11 AXI-2432.G4 compose: pick an operation, bind roles to slots, set a parameter, declare an output — live PASS, saved as draft 1.0', async ({ page }) => {
      // Arrange
      const label = `E2E AXI-2432 composed ${RUN}`;
      await signIn(page, author);
      await openCatalog(page);
      await page.getByTestId('analysis-template-new').click();
      await expect(page.getByTestId('compose-operation-picker')).toBeVisible();
      // Act — header
      await page.getByTestId('compose-template-id').fill(key('composed'));
      await page.getByTestId('compose-label').fill(label);
      await page.getByTestId('compose-scope').selectOption('workspace');
      // Act — slots
      for (const [name, shape, cardinality] of [['Group', 'categorical', 'one'], ['Measurements', 'numeric', 'many']]) {
        await page.getByTestId('compose-slot-name').fill(name);
        await page.getByTestId('compose-slot-shape').selectOption(shape);
        await page.getByTestId('compose-slot-cardinality').selectOption(cardinality);
        await page.getByTestId('compose-add-slot').click();
      }
      // Act — one step, its roles, its parameters
      await page.getByTestId('compose-operation-picker').selectOption('stats.mann_whitney_u');
      await page.getByTestId('compose-add-step').click();
      await expect(page.getByTestId('compose-step-s1')).toHaveAttribute('data-operation', 'stats.mann_whitney_u');
      await page.getByTestId('compose-role-s1-groupColumn-source').selectOption('slot:slot1');
      await page.getByTestId('compose-role-s1-valueColumns-source').selectOption(['slot:slot2']);
      await page.getByTestId('compose-param-s1-groupFrom-mode').selectOption('user_settable');
      await page.getByTestId('compose-param-s1-groupTo-mode').selectOption('user_settable');
      await page.getByTestId('compose-param-s1-alternative-mode').selectOption('fixed');
      await page.getByTestId('compose-param-s1-alternative-value').selectOption('two_sided');
      // Act — one declared output
      await page.getByTestId('compose-output-name').fill('p_value');
      await page.getByTestId('compose-output-source').selectOption('s1:pValue');
      await page.getByTestId('compose-output-cardinality').selectOption('one');
      await page.getByTestId('compose-add-output').click();
      // Assert — the live validator
      const live = page.getByTestId('compose-validator-report');
      await expect(live).toHaveAttribute('data-verdict', 'PASS', { timeout: 15_000 });
      await expect(live.locator('[data-testid^="compose-validator-report-check-"][data-verdict="PASS"]')).toHaveCount(5);
      // Act — save
      await page.getByTestId('compose-save').click();
      // Assert — the detail page with the new draft
      await expect(page.getByTestId('analysis-template-detail')).toBeVisible();
      const id = page.url().split('/analysis-templates/')[1];
      created.push(id);
      composed = { id, label };
      const detail = await asAuthor.get(id);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.versions).toHaveLength(1);
      expect(detail.body.versions[0]).toMatchObject({ templateVersion: '1.0', kind: 'composition', status: 'draft' });
      expect(detail.body.versions[0].composition.steps[0]).toMatchObject({ stepId: 's1', operationId: 'stats.mann_whitney_u' });
      await expect(page.getByTestId(`template-version-status-${detail.body.versions[0].id}`)).toHaveText('Draft');
    });

    test('FR35 AXI-2432.G5 the live validator reports a BLOCK on an unbound required role and names the finding; an unconvertible parameter input disables Save', async ({ page }) => {
      // Arrange
      await signIn(page, author);
      await page.goto('/analysis-templates/new');
      await expect(page.getByTestId('compose-operation-picker')).toBeVisible();
      await page.getByTestId('compose-template-id').fill(key('blocked'));
      await page.getByTestId('compose-label').fill(`E2E AXI-2432 blocked ${RUN}`);
      await page.getByTestId('compose-scope').selectOption('workspace');
      // Act — a step whose required roles stay unbound
      await page.getByTestId('compose-operation-picker').selectOption('stats.mann_whitney_u');
      await page.getByTestId('compose-add-step').click();
      // Assert
      const live = page.getByTestId('compose-validator-report');
      await expect(live).toHaveAttribute('data-verdict', 'BLOCK', { timeout: 15_000 });
      await expect(live.getByTestId('compose-validator-report-check-roles_satisfied')).toHaveAttribute('data-verdict', 'BLOCK');
      await expect(page.getByTestId('compose-step-findings-s1')).toBeVisible();
      await expect(page.getByTestId('compose-save')).toBeEnabled();

      // Act — a parameter input that does not convert (a non-numeric bound)
      await page.getByTestId('compose-param-s1-groupFrom-mode').selectOption('user_settable');
      await page.getByTestId('compose-param-s1-groupFrom-min').fill('0,5');
      // Assert — the row names the error and Save is disabled (the draft never keeps a looser setting)
      await expect(page.getByTestId('compose-param-s1-groupFrom-error')).toContainText('minimum must be a number');
      await expect(page.getByTestId('compose-save')).toBeDisabled();
      // Act — fix it
      await page.getByTestId('compose-param-s1-groupFrom-min').fill('');
      // Assert
      await expect(page.getByTestId('compose-param-s1-groupFrom-error')).toHaveCount(0);
      await expect(page.getByTestId('compose-save')).toBeEnabled();
    });
  });

  test('FR37 AC9 AXI-2432.G6 publish is disabled for the draft author; the approver publishes with a justification', async ({ browser }) => {
    test.skip(!composed, 'G4 did not create the composed draft');
    // Arrange
    const detail = await asAuthor.get(composed!.id);
    const draft = detail.body.versions[0];
    const authorPage = await pageFor(browser, author);
    const approverPage = await pageFor(browser, approver);
    // Act
    await authorPage.goto(`/analysis-templates/${composed!.id}`);
    await approverPage.goto(`/analysis-templates/${composed!.id}`);
    // Assert — the author may not publish their own draft
    await expect(authorPage.getByTestId(`template-version-publish-${draft.id}`)).toBeDisabled();
    await expect(authorPage.getByTestId(`template-version-publish-${draft.id}`)).toHaveAttribute('title', /You authored this draft/);
    // Act — the approver publishes
    await approverPage.getByTestId(`template-version-publish-${draft.id}`).click();
    await expect(approverPage.getByTestId('template-publish-dialog')).toBeVisible();
    await expect(approverPage.getByTestId('template-publish-confirm')).toBeDisabled();
    await approverPage.getByTestId('template-publish-justification').fill('AXI-2432 G6 second-person review');
    await approverPage.getByTestId('template-publish-confirm').click();
    // Assert
    await expect(approverPage.getByTestId(`template-version-status-${draft.id}`)).toHaveText('Published');
    await expect(approverPage.getByTestId(`template-version-verdict-${draft.id}`)).toHaveText('PASS');
    await expect(approverPage.getByTestId('template-action-error')).toHaveCount(0);
    const after = await asApprover.get(composed!.id);
    expect(after.body.versions[0]).toMatchObject({ status: 'published', validatorVerdict: 'PASS', publishedBy: approver.userId });
    await authorPage.context().close();
    await approverPage.context().close();
  });

  test('FR33 AXI-2432.G7 the catalog version icon carries the published version forward; the archive icon archives it', async ({ page }) => {
    test.skip(!composed, 'G4 did not create the composed template');
    // Arrange
    const published = (await asApprover.get(composed!.id)).body.versions.find((v: any) => v.status === 'published');
    expect(published, 'G6 published version').toBeTruthy();
    await signIn(page, approver);
    await openCatalog(page);
    // Act — new version from the catalog row
    await page.getByTestId(`analysis-template-version-${composed!.id}`).click();
    // Assert
    await expect(page).toHaveURL(new RegExp(`/analysis-templates/${composed!.id}$`));
    await expect(page.getByTestId('template-versions-table').locator('tr[data-version="1.1"]')).toBeVisible();
    const carried = (await asApprover.get(composed!.id)).body.versions.find((v: any) => v.templateVersion === '1.1');
    expect(carried).toMatchObject({ status: 'draft', kind: 'composition' });
    expect(carried.composition).toEqual(published.composition);

    // Act — archive the published version from the catalog row
    await openCatalog(page);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByTestId(`analysis-template-archive-${composed!.id}`).click();
    // Assert
    await expect.poll(async () => (await asApprover.get(composed!.id)).body.versions.find((v: any) => v.id === published.id)?.status).toBe('archived');
    await expect(page.getByTestId(`analysis-template-archive-${composed!.id}`)).toBeDisabled();
  });
});
