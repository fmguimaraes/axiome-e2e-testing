import { Page, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from './harness/new-analysis';

/**
 * AXI-2538 (epic AXI-2308 — Platform Opening: Human Guided) — the investigator
 * Datasets page aligned with the team layout, and the duplicate-upload guard
 * (server-side, both upload paths). Scenarios:
 * `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2538.
 *
 * Self-provisioned: a fresh fixture workspace + project, one throwaway
 * Investigator. Fresh storage state per test — the Investigator signs in
 * through the UI, exactly like AXI-2325's harness.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2538-e2e-pw!';
const CSV_TYPE = 'text/csv';
/** Upload → ingestion on the shared bio-compute; a cold ingest can take a while. */
const READY_MS = 180_000;

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let teamAdmin: Actor;
let projectId: string;

function unique(label: string): string {
  return `axi2538-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const { request: apiRequest } = await import('@playwright/test');
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2538', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function newProject(a: Actor, ws: string, name: string): Promise<string> {
  const res = await a.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2538 ${name} ${Date.now()}`, workspaceId: ws },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function signInToUploads(page: Page): Promise<void> {
  await page.addInitScript(
    ([org, ws, project]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', project);
    },
    [world.orgId, world.workspaceId, projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
  await gotoSettled(page, '/investigator/uploads');
  await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: 30_000 });
}

/** The visible file-picker input — the empty-state one while no row exists yet, else the header one. */
function uploadInput(page: Page) {
  return page.locator('[data-testid^="upload-input"]').first();
}

/**
 * AXI-2548 hardening: react-dropzone's single `useFilePicker` hook instance
 * backs BOTH the empty-state drop zone's input and the header's input —
 * which input is actually mounted flips the moment the first upload's row
 * appears (`hasRows` goes true, `EmptyDropZone` unmounts, the header input
 * mounts in its place). A SECOND `setInputFiles()` fired back-to-back with
 * the first — before the page has settled from `uploading` back to idle —
 * flaked: `uploadInput(page)` can resolve to the (about to unmount) empty-state
 * node, or the call can race the remount, either way sometimes silently
 * dropping the second file. Waiting for the header's "Upload data" button to
 * be enabled again (i.e. `state.uploading === null`, the SAME idle signal the
 * production code itself uses to re-enable it) before firing the next
 * `setInputFiles()` call removes the race without inventing a second upload
 * code path in the page itself.
 */
async function waitForUploadIdle(page: Page): Promise<void> {
  await expect(page.getByTestId('upload-data-button')).toBeEnabled({ timeout: READY_MS });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  teamAdmin = await world.actor('team-admin');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(teamAdmin, 'admin');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  projectId = await newProject(teamAdmin, world.workspaceId, 'study');
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2538 Investigator Datasets — layout + duplicate guard @SI-066 @SI-032', () => {
  // AXI-2538: the default 120s baseline (playwright.config.ts) governs TESTS
  // only, not hooks — each of these scenarios does an upload-then-settle
  // round trip (sometimes twice) against the shared demo stack's bio-compute
  // ingest + a connection-pool-capped Postgres, which the first live run
  // showed can exceed 120s end to end even though no single step is slow.
  test.describe.configure({ timeout: 300_000 });

  test('§2 — an uploaded CSV appears with rows × columns, no drop zone once a row exists @SI-066 @SI-032', async ({ page }) => {
    // Arrange
    await signInToUploads(page);
    await expect(page.getByTestId('upload-dropzone')).toBeVisible();
    const name = `${unique('first')}.csv`;
    const csv = 'subject_id,value\nS1,1\nS2,2\nS3,3\n';

    // Act
    await uploadInput(page).setInputFiles({ name, mimeType: CSV_TYPE, buffer: Buffer.from(csv) });

    // Assert — the row is the server's own answer, settling to Ready with its size
    const row = page.locator(`[data-upload-name="${name}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    const id = (await row.getAttribute('data-testid'))!.replace('upload-row-', '');
    await expect(page.getByTestId(`upload-status-${id}`)).toHaveText('Ready', { timeout: READY_MS });
    await expect(page.getByTestId(`upload-size-${id}`)).toContainText('×');
    // Once a row exists, no drop zone — only the header's "Upload data" button remains.
    await expect(page.getByTestId('upload-dropzone')).toHaveCount(0);
    await expect(page.getByTestId('upload-data-button')).toBeVisible();

    // Preview drawer opens on the filename and reads the first rows through the query API.
    await page.getByTestId(`upload-preview-open-${id}`).click();
    await expect(page.getByTestId('upload-preview-drawer')).toBeVisible();
    await expect(page.getByTestId('upload-preview-table')).toBeVisible();
    await page.getByTestId('upload-preview-close').click();
    await expect(page.getByTestId('upload-preview-drawer')).toHaveCount(0);
  });

  test('§3 — uploading the SAME file again is refused as a duplicate, no new row @SI-066 @SI-032', async ({ page }) => {
    // Arrange
    await signInToUploads(page);
    const name = `${unique('dup')}.csv`;
    const csv = 'subject_id,value\nS1,10\nS2,20\n';
    await uploadInput(page).setInputFiles({ name, mimeType: CSV_TYPE, buffer: Buffer.from(csv) });
    const firstRow = page.locator(`[data-upload-name="${name}"]`);
    await expect(firstRow).toBeVisible({ timeout: 60_000 });
    const firstId = (await firstRow.getAttribute('data-testid'))!.replace('upload-row-', '');
    await expect(page.getByTestId(`upload-status-${firstId}`)).toHaveText('Ready', { timeout: READY_MS });
    const rowCountBefore = await page.getByTestId('uploads-table').locator('tbody tr').count();

    // Act — the SAME bytes, a different file name (content hash is what the server checks)
    const dupName = `${unique('dup-again')}.csv`;
    await waitForUploadIdle(page); // AXI-2548: let the first upload's picker remount settle first
    await uploadInput(page).setInputFiles({ name: dupName, mimeType: CSV_TYPE, buffer: Buffer.from(csv) });

    // Assert — refused, cites the original, no second row ever appears. The
    // refusal is decided server-side inside finalizeUpload (download + hash
    // the just-PUT object before comparing) — the same settle time as the
    // Ready status above, not a UI-only round trip.
    const refusal = page.getByTestId('upload-duplicate-refusal');
    await expect(refusal).toBeVisible({ timeout: READY_MS });
    await expect(refusal).toContainText('already uploaded');
    await expect(page.getByTestId('upload-duplicate-refusal-link')).toHaveAttribute('href', `#upload-row-${firstId}`);
    await expect(page.locator(`[data-upload-name="${dupName}"]`)).toHaveCount(0);
    const rowCountAfter = await page.getByTestId('uploads-table').locator('tbody tr').count();
    expect(rowCountAfter).toBe(rowCountBefore);
  });

  test('§3 — the SAME filename with DIFFERENT content is accepted as a second, separate row @SI-066 @SI-032', async ({ page }) => {
    // Arrange
    await signInToUploads(page);
    const name = `${unique('samename')}.csv`;
    const first = 'subject_id,value\nS1,1\n';
    const second = 'subject_id,value\nS1,1\nS2,2\nS3,3\nS4,4\n';

    // Act
    await uploadInput(page).setInputFiles({ name, mimeType: CSV_TYPE, buffer: Buffer.from(first) });
    const firstRow = page.locator(`[data-upload-name="${name}"]`).first();
    await expect(firstRow).toBeVisible({ timeout: 60_000 });
    const firstId = (await firstRow.getAttribute('data-testid'))!.replace('upload-row-', '');
    await expect(page.getByTestId(`upload-status-${firstId}`)).toHaveText('Ready', { timeout: READY_MS });

    await waitForUploadIdle(page); // AXI-2548: let the first upload's picker remount settle first
    await uploadInput(page).setInputFiles({ name, mimeType: CSV_TYPE, buffer: Buffer.from(second) });

    // Assert — both rows are present, told apart by date (the server never overwrites)
    await expect(page.getByTestId('upload-duplicate-refusal')).toHaveCount(0, { timeout: 10_000 });
    const rowsWithName = page.locator(`[data-upload-name="${name}"]`);
    await expect(rowsWithName).toHaveCount(2, { timeout: READY_MS });
  });

  test('§1 — the investigator Datasets page matches the team page header + table layout @SI-066', async ({ page }) => {
    // Arrange / Act
    await signInToUploads(page);

    // Assert — same shared components, none of the team-only filters/columns the spec withholds
    await expect(page.getByTestId('upload-data-button')).toBeVisible();
    await expect(page.getByRole('button', { name: /^back$/i })).toHaveCount(0);
    await expect(page.locator('select')).toHaveCount(0); // no lock/availability/origin filters
    await expect(page.getByTestId('uploads-table').locator('thead th')).toHaveCount(5);
    // AXI-2555 (owner spec §2, 2026-11-15): the "Questions this data can answer" block
    // (AXI-2342) is removed from this page — it moves to the Plan tab there.
    await expect(page.getByTestId('suggested-questions')).toHaveCount(0);
  });
});
