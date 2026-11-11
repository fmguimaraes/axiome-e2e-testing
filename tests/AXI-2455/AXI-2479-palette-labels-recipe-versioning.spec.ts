import { expect, test, type Page, type Response } from '@playwright/test';

/**
 * AXI-2479 (epic AXI-2455 — TPL FR12, FR33, FR35; SI-035). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2479 (C1–C3).
 *
 * C1 — the compose palette names each operation by the registry's label (`GET /rule-runs/operations`)
 *      with its id beside it.
 * C2 — the catalog's "new version" icon on the system T1 row (recipe-kind 0.2 + 0.3, 0.3 holding the
 *      composition) is enabled for a platform administrator; clicking it reads the detail and sends a
 *      carry-forward of the newest version holding a composition at the next free minor.
 *      The version WRITE is intercepted and answered with the detail as read: a system version is
 *      immutable and undeletable, so a real write would leave a permanent T1 draft on the shared demo
 *      for every later run (and every SAP / wizard spec that reads T1's versions).
 * C3 — a system template with only recipe-only versions (no composition, no pin) keeps the icon
 *      disabled with its reason. Skipped when no such template is seeded (e.g. once T2 gains a
 *      composition-backed version).
 *
 * Runs in the `chromium` project as the `admin` role, which must be a platform administrator
 * (system rows are written by a platform admin only) — asserted from the app's own `/auth/me`.
 * Every server read is taken from the page's own responses (the session token lives in the
 * browser, not in a cookie `page.request` would carry).
 */

test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface VersionSummary { id: string; templateVersion: string; kind: 'recipe' | 'composition'; nodeLibraryVersion: string | null }
interface CatalogEntry { id: string; templateId: string; scope: string; versions: VersionSummary[] }

const path = (url: string) => new URL(url).pathname;
const isGet = (pattern: RegExp) => (r: Response) => r.request().method() === 'GET' && pattern.test(path(r.url())) && r.ok();

/** Opens the catalog; resolves the system entries the page itself read, after checking the caller is a platform admin. */
async function openCatalog(page: Page): Promise<CatalogEntry[]> {
  const me = page.waitForResponse(isGet(/\/auth\/me$/));
  const list = page.waitForResponse(isGet(/\/analysis-templates\/?$/));
  await page.goto('/analysis-templates');
  expect((await (await me).json()).userType, 'the admin role must be a platform administrator').toBe('admin');
  return ((await (await list).json()).data as CatalogEntry[]).filter((e) => e.scope === 'system');
}

const minorAbove = (versions: { templateVersion: string }[]) => {
  const [major, minor] = versions.map((v) => v.templateVersion.split('.').map(Number))
    .sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
  return `${major}.${minor + 1}`;
};

const newestWithComposition = (versions: { id: string; templateVersion: string; composition: unknown }[]) =>
  versions.filter((v) => v.composition !== null)
    .sort((a, b) => b.templateVersion.localeCompare(a.templateVersion, undefined, { numeric: true }))[0];

test('AXI-2479.C1 @SI-035 TPL FR35 — the compose palette shows each operation as "Label (id)"', async ({ page }) => {
  // Arrange
  const vocabulary = page.waitForResponse(isGet(/\/rule-runs\/operations$/));
  // Act
  await page.goto('/analysis-templates/new');
  const descriptors: { operationId: string; label: string }[] = (await (await vocabulary).json()).operations;
  const picker = page.getByTestId('compose-operation-picker');
  await expect(picker.locator('option').nth(1)).toBeAttached();
  const options = await picker.locator('option').evaluateAll((els) =>
    els.map((el) => ({ value: (el as HTMLOptionElement).value, text: el.textContent ?? '' })).filter((o) => o.value !== ''));
  // Assert — every offered operation the registry labels reads "Label (id)"; at least one is labelled
  const labels = new Map(descriptors.map((d) => [d.operationId, d.label.trim()]));
  const labelled = options.filter((o) => labels.get(o.value));
  expect(labelled.length).toBeGreaterThan(0);
  for (const o of labelled) expect(o.text).toBe(`${labels.get(o.value)} (${o.value})`);
});

test('AXI-2479.C2 @SI-035 TPL FR12 FR33 — the T1 recipe-kind row carries its composition-holding version forward', async ({ page }) => {
  // Arrange
  const t1 = (await openCatalog(page)).find((e) => e.templateId === 'T1');
  expect(t1, 'seeded system template T1').toBeTruthy();
  const icon = page.getByTestId(`analysis-template-version-${t1!.id}`);
  const read = page.waitForResponse(isGet(new RegExp(`/analysis-templates/${t1!.id}$`))).then((r) => r.json());
  let sent: unknown = null;
  await page.route(`**/api/v1/analysis-templates/${t1!.id}/versions`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(await read) });
  });
  // Act
  await expect(icon).toBeEnabled();
  await icon.click();
  const detail = await read;
  // Assert
  await expect(page).toHaveURL(new RegExp(`/analysis-templates/${t1!.id}$`));
  const source = newestWithComposition(detail.versions);
  expect(source, 'T1 has a version holding a composition').toBeTruthy();
  expect(sent).toEqual({ templateVersion: minorAbove(t1!.versions), fromVersionId: source.id });
});

test('AXI-2479.C3 @SI-035 TPL FR33 — a recipe-only system row keeps the version icon disabled with its reason', async ({ page }) => {
  // Arrange
  const recipeOnly = (await openCatalog(page))
    .find((e) => e.versions.length > 0 && e.versions.every((v) => v.kind === 'recipe' && v.nodeLibraryVersion === null));
  test.skip(!recipeOnly, 'no recipe-only system template is seeded on this stack');
  // Act
  const icon = page.getByTestId(`analysis-template-version-${recipeOnly!.id}`);
  // Assert
  await expect(icon).toBeDisabled();
  await expect(icon).toHaveAttribute('title', 'No composition-backed version to carry forward.');
});
