import { Page, Route, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';

/**
 * AXI-2548 (epic AXI-2540 — FR77, AC71, EC41; pairs with AXI-2549's watchdog/Retry) —
 * the investigator Datasets page's clear-processing-status surface: elapsed time +
 * known stage while a row processes, a plain-language reason once it fails, and a
 * safe, single-flight Retry that never offers twice on an already-retried row.
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2548.
 *
 * A real ingestion settles in seconds on this stack and the watchdog window is
 * minutes — neither a genuinely "processing" row nor a genuinely timed-out one is
 * practical to produce live. Each scenario below uploads a REAL file (a real
 * dataset + ingestion row, real auth/tenancy), then intercepts the ONE dataset
 * list/detail response the page reads to present that real row as processing,
 * failed, or already-retried — the same trade-off this epic's own harness already
 * makes for the watchdog window (AXI-2549's spec waits it out at the API layer
 * instead; this spec is UI-facing, where that wait is not a good trade, per the
 * manual-e2e doc's own `AXI-2548.3` note).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2548-e2e-pw!';
const CSV_TYPE = 'text/csv';
const READY_MS = 180_000;

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let teamAdmin: Actor;
let projectId: string;
const createdDatasetIds: string[] = [];

function unique(label: string): string {
  return `axi2548-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const { request: apiRequest } = await import('@playwright/test');
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2548', lastName: label },
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
    data: { name: `E2E AXI-2548 ${name} ${Date.now()}`, workspaceId: ws },
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

function uploadInput(page: Page) {
  return page.locator('[data-testid^="upload-input"]').first();
}

/** Uploads a real CSV through the UI and waits for its row to settle to `Ready`
 *  — a real dataset + ingestion row this spec can then present differently via
 *  route interception, never a fabricated/hand-seeded record. */
async function uploadAndSettle(page: Page, label: string): Promise<{ id: string; name: string }> {
  const name = `${unique(label)}.csv`;
  const csv = 'subject_id,value\nS1,1\nS2,2\nS3,3\n';
  await uploadInput(page).setInputFiles({ name, mimeType: CSV_TYPE, buffer: Buffer.from(csv) });
  const row = page.locator(`[data-upload-name="${name}"]`);
  await expect(row).toBeVisible({ timeout: 60_000 });
  const id = (await row.getAttribute('data-testid'))!.replace('upload-row-', '');
  await expect(page.getByTestId(`upload-status-${id}`)).toHaveText('Ready', { timeout: READY_MS });
  createdDatasetIds.push(id);
  return { id, name };
}

/** Rewrites ONE dataset's `latestIngestion` in every `GET .../datasets` list
 *  response the page reads from here on — the page is never told anything the
 *  server didn't, in form; this just substitutes what a real watchdog/retry
 *  outcome WOULD look like for a row that, on this stack, settled in seconds. */
async function stubLatestIngestion(
  page: Page,
  datasetId: string,
  latestIngestion: Record<string, unknown>,
): Promise<void> {
  await page.route(/\/api\/v1\/workspaces\/[^/]+\/datasets(\?|$)/, async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    const list = Array.isArray(body.data) ? body.data : body;
    const target = list.find((d: { id: string }) => d.id === datasetId);
    if (target) target.latestIngestion = { ...target.latestIngestion, ...latestIngestion };
    await route.fulfill({ response, json: body.data ? { ...body, data: list } : list });
  });
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

test.afterEach(async () => {
  // AXI-2548: clean up every API-created dataset this spec uploaded — never
  // left behind in the shared/fixture workspace for a later run to trip over.
  while (createdDatasetIds.length > 0) {
    const id = createdDatasetIds.pop()!;
    await investigator.api
      .delete(apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${id}`))
      .catch(() => undefined);
  }
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2548 Investigator uploads — clear processing status + single-flight Retry @SI-032 @SI-066', () => {
  // AXI-2538's own note applies here too: an upload-then-settle round trip
  // against the shared demo stack's bio-compute ingest + connection-pool-capped
  // Postgres can exceed a 300s budget even with no single step slow, once a
  // post-reload wait (now READY_MS, 180s) is added on top of the upload wait.
  test.describe.configure({ timeout: 420_000 });

  test('AXI-2548.1 — a processing row shows elapsed time and its known stage @SI-032 @SI-066', async ({ page }) => {
    // Arrange — a real, settled row; present it as still `running` with a known start time.
    await signInToUploads(page);
    const { id } = await uploadAndSettle(page, 'processing');
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    await stubLatestIngestion(page, id, { status: 'running', startedAt, createdAt: startedAt, errorCode: null, retriedAt: null });

    // Act
    await page.reload();
    await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: READY_MS });

    // Assert — the Status cell names both the elapsed time and the known stage.
    // A longer timeout here: the row re-renders after `reload()` re-fetches the
    // list through `stubLatestIngestion`'s own extra round trip (it re-fetches
    // the real response before rewriting it), which this stack's shared
    // Postgres/bio-compute resources (AXI-2538's own finding) can make slower
    // than the default 5s under load from this file's own earlier tests.
    const status = page.getByTestId(`upload-status-${id}`);
    await expect(status).toContainText(/\d+(m|s)/, { timeout: 15_000 });
    await expect(status).toContainText(/processing/i, { timeout: 15_000 });
  });

  test('AXI-2548.2 — a failed row shows a plain-language reason and offers Retry exactly once @SI-032 @SI-066 @SI-014', async ({ page }) => {
    // Arrange — a real, settled row; present it as failed on a known, mapped error code.
    await signInToUploads(page);
    const { id } = await uploadAndSettle(page, 'failed');
    await stubLatestIngestion(page, id, { status: 'failed', errorCode: 'INGESTION_TIMEOUT', errorMessage: 'raw internal message', retriedAt: null });
    await page.reload();
    await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: READY_MS });

    // Assert — a plain sentence for the KNOWN code, never the raw message, and Retry is offered.
    const status = page.getByTestId(`upload-status-${id}`);
    await expect(status).not.toContainText('raw internal message');
    await expect(status).not.toContainText('INGESTION_TIMEOUT');
    const retryButton = page.getByTestId(`upload-retry-${id}`);
    await expect(retryButton).toBeVisible({ timeout: 15_000 });

    // Act — retry succeeds; the next list read shows retriedAt now set, still failed
    // (D42: the watchdog-failed row is never cleared/overwritten by a retry attempt
    // that has not itself resolved yet).
    await page.route(/\/api\/v1\/workspaces\/[^/]+\/datasets\/[^/]+\/ingestions\/[^/]+\/retry$/, (route: Route) =>
      route.fulfill({ status: 201, json: { id: 'new-ingestion-id', status: 'queued' } }),
    );
    await stubLatestIngestion(page, id, { status: 'failed', errorCode: 'INGESTION_TIMEOUT', retriedAt: new Date().toISOString() });
    await retryButton.click();

    // Assert — a row that has already been retried is never offered Retry again.
    await expect(page.getByTestId(`upload-retry-${id}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('upload-retry-error')).toHaveCount(0);
  });

  test('AXI-2548.2b — a 409 on Retry (already claimed) is swallowed, never shown as an error @SI-032 @SI-014', async ({ page }) => {
    // Arrange — a real, settled row; present it as failed, Retry offered.
    await signInToUploads(page);
    const { id } = await uploadAndSettle(page, 'retry409');
    await stubLatestIngestion(page, id, { status: 'failed', errorCode: 'INGESTION_TIMEOUT', retriedAt: null });
    await page.reload();
    await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: READY_MS });
    const retryButton = page.getByTestId(`upload-retry-${id}`);
    await expect(retryButton).toBeVisible({ timeout: 15_000 });

    // Act — the endpoint's own atomic single-use claim lost the race (another
    // caller/tab retried first); the server answers 409.
    await page.route(/\/api\/v1\/workspaces\/[^/]+\/datasets\/[^/]+\/ingestions\/[^/]+\/retry$/, (route: Route) =>
      route.fulfill({ status: 409, json: { message: 'This ingestion has already been retried', code: 'INGESTION_ALREADY_RETRIED' } }),
    );
    await stubLatestIngestion(page, id, { status: 'failed', errorCode: 'INGESTION_TIMEOUT', retriedAt: new Date().toISOString() });
    await retryButton.click();

    // Assert — no error banner for the 409 case specifically; the row simply
    // refreshes to the server's own current answer.
    await expect(page.getByTestId('upload-retry-error')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId(`upload-retry-${id}`)).toHaveCount(0, { timeout: 15_000 });
  });
});
