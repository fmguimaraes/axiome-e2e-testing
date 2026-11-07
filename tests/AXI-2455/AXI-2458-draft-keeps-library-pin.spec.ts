import { expect, test, type Page } from '@playwright/test';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { catalogApi, type CatalogApi } from '../AXI-2422/harness/catalog-api';

/**
 * AXI-2458 (epic AXI-2455; AXI-2432 advisory A1 — TPL FR7, FR28, NFR8; SI-035). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2458 (A1).
 *
 * A draft composed against an older node-library version keeps that pin when it is edited and saved
 * in the compose page; it is never re-pinned to the current library. The draft is seeded through
 * the API with a legacy pin (the only way to hold a pin other than the current one on one stack),
 * then edited in the browser. Throwaway workspace and Admin; the template is soft-deleted in afterAll.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const LEGACY_PIN = 'axiome-back@legacy-e2e+sha256:000000000000';
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let world: PrivateProjectsWorld;
let author: UiActor;
let api: CatalogApi;
let created: { id: string; versionId: string } | null = null;

async function signIn(page: Page): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, author, world.workspaceId);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  author = await uiActor('axi2458-author', world.workspaceId);
  await world.addMember(author, 'admin');
  await world.leaveWorkspace();
  await silenceTours(author.accessToken);
  api = catalogApi(author.api);
});

test.afterAll(async () => {
  if (created) await api.remove(created.id);
  await author?.api.dispose().catch(() => undefined);
  await world?.dispose();
});

test.describe('draft keeps its node-library pin', { tag: ['@SI-035'] }, () => {
  test('FR7 FR28 NFR8 AXI-2458.A1 editing and saving a draft keeps its nodeLibraryVersion', async ({ page }) => {
    // Arrange — a workspace template whose draft is pinned to a legacy library version
    const header = await api.create({ templateId: `e2e-axi2458-${RUN}`, label: `E2E AXI-2458 ${RUN}`, scope: 'workspace' });
    expect(header.status, JSON.stringify(header.body)).toBe(201);
    const composition = { nodeLibraryVersion: LEGACY_PIN, slots: [], steps: [], outputs: [] };
    const v = await api.createVersion(header.body.id, { templateVersion: '1.0', composition });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const versionId = v.body.versions[0].id;
    created = { id: header.body.id, versionId };

    // Act — edit the draft in the compose page (add a slot) and save
    await signIn(page);
    await page.goto(`/analysis-templates/${header.body.id}/compose?version=${versionId}`);
    await expect(page.getByTestId('compose-operation-picker')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('compose-slot-name').fill('slot1');
    await page.getByTestId('compose-slot-shape').selectOption('any');
    await page.getByTestId('compose-slot-cardinality').selectOption('one');
    await page.getByTestId('compose-add-slot').click();
    await page.getByTestId('compose-save').click();
    await expect(page.getByTestId('analysis-template-detail')).toBeVisible({ timeout: 30_000 });

    // Assert — the edit is stored and the pin is unchanged
    const detail = await api.get(header.body.id);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const stored = detail.body.versions.find((x: any) => x.id === versionId);
    expect(stored.composition.slots).toHaveLength(1);
    expect(stored.composition.nodeLibraryVersion).toBe(LEGACY_PIN);
  });
});
