import { expect, test, type Browser, type Page } from '@playwright/test';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { allVisible, catalogApi, type CatalogApi } from '../AXI-2422/harness/catalog-api';

/**
 * AXI-2478 (epic AXI-2455; AXI-2432 advisory A2 — TPL FR35, FR37; SI-035). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2478 (B1, B2).
 *
 * Saving a NEW template is two writes: the header (POST /analysis-templates), then its first version
 * (POST /:id/versions). When the server takes the header and refuses the version, the header now
 * exists, so the compose page locks the header fields (a retry writes only the version under it)
 * and says so. The refusal is real, not intercepted: a slot name over the server's 256-character
 * composition text limit is refused by the version write only (the header carries no slot).
 *
 * Throwaway workspace and Admin. The template is recorded from the header POST's own response, so
 * it is soft-deleted in afterAll even when the version write (or the test) fails.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const KEY = `e2e-axi2478-${RUN}`;
const LABEL = `E2E AXI-2478 ${RUN}`;
const DESCRIPTION = 'Header written, version refused';
const TOO_LONG = 'n'.repeat(300);
/** By id, which the description input has always had (its `compose-description` testid is new in AXI-2478). */
const DESCRIPTION_INPUT = '#compose-description';

let world: PrivateProjectsWorld;
let author: UiActor;
let api: CatalogApi;
let page: Page;
let createdId: string | null = null;

async function composePage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const p = await context.newPage();
  await p.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(p, author, world.workspaceId);
  return p;
}

async function addSlot(name: string): Promise<void> {
  await page.getByTestId('compose-slot-name').fill(name);
  await page.getByTestId('compose-slot-shape').selectOption('any');
  await page.getByTestId('compose-slot-cardinality').selectOption('one');
  await page.getByTestId('compose-add-slot').click();
}

const isHeaderPost = (url: string, method: string) => method === 'POST' && /\/api\/v1\/analysis-templates\/?$/.test(new URL(url).pathname);

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  author = await uiActor('axi2478-author', world.workspaceId);
  await world.addMember(author, 'admin');
  await world.leaveWorkspace();
  await silenceTours(author.accessToken);
  api = catalogApi(author.api);
});

test.afterAll(async () => {
  if (createdId) await api.remove(createdId).catch(() => undefined);
  await page?.context().close().catch(() => undefined);
  await author?.api.dispose().catch(() => undefined);
  await world?.dispose();
});

test.describe('AXI-2478 — header lock after a partial save', { tag: ['@SI-035'] }, () => {
  test('FR35 FR37 AXI-2478.B1 a refused version write after the header was created locks the header fields and says why', async ({ browser }) => {
    // Arrange — a new template whose single slot name the version write will refuse
    page = await composePage(browser);
    await page.goto('/analysis-templates/new');
    await expect(page.getByTestId('compose-operation-picker')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('compose-template-id').fill(KEY);
    await page.getByTestId('compose-label').fill(LABEL);
    await page.locator(DESCRIPTION_INPUT).fill(DESCRIPTION);
    await page.getByTestId('compose-scope').selectOption('workspace');
    await addSlot(TOO_LONG);
    await expect(page.getByTestId('compose-header-locked')).toHaveCount(0);

    // Act — save: the header is created (201), the version is refused (400)
    const headerReply = page.waitForResponse((r) => isHeaderPost(r.url(), r.request().method()));
    await page.getByTestId('compose-save').click();
    const header = await headerReply;
    expect(header.status()).toBe(201);
    createdId = (await header.json()).id;
    await expect(page.getByTestId('template-action-error')).toBeVisible({ timeout: 15_000 });

    // Assert — still composing; the header fields are locked and keep what was saved
    expect(page.url()).toContain('/analysis-templates/new');
    const fields = [['[data-testid="compose-template-id"]', KEY], ['[data-testid="compose-label"]', LABEL], [DESCRIPTION_INPUT, DESCRIPTION], ['[data-testid="compose-scope"]', 'workspace']];
    for (const [selector, value] of fields) {
      await expect(page.locator(selector), selector).toBeDisabled();
      await expect(page.locator(selector), selector).toHaveValue(value);
    }
    await expect(page.getByTestId('compose-header-locked')).toContainText(`"${KEY}" was created`);
    await expect(page.getByTestId('compose-version')).toBeEnabled();
    // The server holds the header and no version
    const stored = await api.get(createdId!);
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body.versions).toHaveLength(0);
  });

  test('FR35 AXI-2478.B2 the retry writes only the version under the saved header — one template per key', async () => {
    test.skip(!createdId, 'B1 did not create the header');
    // Arrange — fix the refused slot
    await page.getByRole('button', { name: 'Remove slot slot1' }).click();
    await addSlot('slot1');
    let headerPosts = 0;
    page.on('request', (r) => { if (isHeaderPost(r.url(), r.method())) headerPosts += 1; });

    // Act
    await page.getByTestId('compose-save').click();

    // Assert — the detail of the template B1 created, with its first draft
    await expect(page.getByTestId('analysis-template-detail')).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toContain(`/analysis-templates/${createdId}`);
    expect(headerPosts).toBe(0);
    const stored = await api.get(createdId!);
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body).toMatchObject({ templateId: KEY, label: LABEL, description: DESCRIPTION });
    expect(stored.body.versions).toHaveLength(1);
    expect(stored.body.versions[0]).toMatchObject({ templateVersion: '1.0', kind: 'composition', status: 'draft' });
    expect(stored.body.versions[0].composition.slots.map((s: any) => s.wording.name)).toEqual(['slot1']);
    expect((await allVisible(api)).filter((e) => e.templateId === KEY)).toHaveLength(1);
  });
});
