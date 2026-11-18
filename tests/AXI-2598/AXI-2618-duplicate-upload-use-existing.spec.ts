import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';

/**
 * AXI-2618 (epic AXI-2598 — [D2] bug; D12 owner ruling 2026-11-17; FR61/AC33):
 * uploading the SAME content into a SECOND study of the SAME workspace is still
 * refused (AXI-2538's workspace-scoped duplicate-content rule, unchanged), but the
 * refusal now (a) carries a proper 409 labelled by its own reason phrase instead
 * of the generic `"InternalServerError"`, and (b) both Investigator upload
 * surfaces — the Uploads page (AXI-2325/AXI-2538) and the Study page's inline
 * upload (AXI-2602) — offer a "Use the existing file" action that links the
 * cited dataset to the CURRENT project through the existing `projectsApi.linkDataset`
 * route, server-side tenancy/permission unchanged (deny-by-default).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md` § 6a (6a.1, 6a.2).
 *
 * BACKEND-DEPENDENT, HARD assertion (bounce #1, Opus review 2026-11-17): both scenarios assert
 * the finalize 409's `error` field is `"Conflict"` — the actual fix this story makes, read off
 * the PATCH `.../datasets/:id/finalize` response (`captureFinalizeRefusal`), never the POST
 * initiate call, which cannot yet know the content hash. This is a REAL assertion, not a soft
 * or logged one: against a gateway serving pre-merge `main` it FAILS (the stale label is still
 * "InternalServerError"), which is expected and correct — run this spec again once the gateway
 * under test serves this story's merged backend branch, where it passes. The duplicate-content
 * refusal itself (AXI-2538) and the `projectsApi.linkDataset` route are already on `main`, so
 * every OTHER assertion (the refusal firing, "use the existing file", the link succeeding) is
 * provable today regardless of the backend branch's merge state.
 *
 * Run: BASE_URL=<Vite serving this branch> API_BASE_URL=<gateway>
 *   npx playwright test tests/AXI-2598/AXI-2618-duplicate-upload-use-existing.spec.ts --project=chromium --no-deps --trace=off
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2618-e2e-pw!';
const POPULATION = 'Adults with a measured arm and score, 18-75 years';
const READY_MS = 180_000;
const CSV_TYPE = 'text/csv';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;

function unique(label: string): string {
  return `axi2618-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function person(label: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2618', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': world.workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function newProject(label: string): Promise<string> {
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2618 ${label} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const grant = await access.grant(projectOwner, id, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  return id;
}

async function signInInvestigator(page: Page, projectId: string): Promise<void> {
  await page.addInitScript(
    ([org, ws, p]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', p);
    },
    [world.orgId, world.workspaceId, projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

/** The visible file-picker input on the Uploads page — empty-state or header one. */
function uploadInput(page: Page) {
  return page.locator('[data-testid^="upload-input"]').first();
}

/** Captures the RAW duplicate-content 409's body. The refusal is decided inside
 *  `finalizeUpload` (`DatasetsService.findDuplicateByContentHash`), so it is a PATCH to
 *  `.../datasets/:id/finalize` (front `datasets.ts#finalizeUpload`) — NEVER the `POST .../datasets`
 *  initiate call, which only allocates the pending placeholder and cannot yet know the content
 *  hash. A listener matched on the wrong verb/path here is a silent no-op: `refusalBody` stays
 *  `null` and every assertion gated on it is dead regardless of whether the label fix is live —
 *  bounce #1 (Opus review, 2026-11-17) caught exactly this on test 1; `register` is called before
 *  BOTH tests' duplicate upload so the same mistake cannot recur per-test. */
function captureFinalizeRefusal(page: Page): { body: () => Record<string, unknown> | null } {
  let body: Record<string, unknown> | null = null;
  page.on('response', async (res) => {
    if (res.request().method() === 'PATCH' && res.url().endsWith('/finalize') && res.status() === 409) {
      body = await res.json().catch(() => null);
    }
  });
  return { body: () => body };
}

/** Switch the SAME already-authenticated investigator session to a different project —
 *  `/login` auto-redirects an authenticated session straight back to `/investigator`, so a
 *  second `signInInvestigator` call mid-test hangs. `axiome-active-project` (localStorage) is
 *  read fresh only on a full document load (the Zustand store's own init), so a real
 *  `page.goto` (never an in-SPA client nav) after writing it is required. AXI-2401's "last
 *  study" hint (`axiome-investigator-last-project`, SESSION storage) is what `InvestigatorShell`
 *  actually re-lands on and must be cleared too, or it re-selects the OLD project over the
 *  fresh localStorage value on every reload. */
async function switchProject(page: Page, projectId: string, path = '/investigator/uploads'): Promise<void> {
  await page.evaluate((p) => {
    localStorage.setItem('axiome-active-project', p);
    sessionStorage.setItem('axiome-investigator-last-project', p);
  }, projectId);
  await gotoSettled(page, path);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = (await person('investigator')) as Person;
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await projectOwner?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2618 Duplicate upload — real 409 label + "use the existing file" @SI-066 @SI-032 @SI-001', () => {
  test.describe.configure({ timeout: 300_000 });

  test('6a.1 — the Uploads page offers "use the existing file" for content already uploaded into another study of this workspace', async ({
    page,
  }) => {
    // Arrange — two separate projects (studies) in the SAME workspace.
    const projectA = await newProject('A-source');
    const projectB = await newProject('B-target');

    // Act 1 — upload once into Project A's Uploads page.
    await signInInvestigator(page, projectA);
    await gotoSettled(page, '/investigator/uploads');
    await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: 30_000 });
    const name = `${unique('first')}.csv`;
    const csv = 'subject_id,value\nS1,1\nS2,2\nS3,3\n';
    await uploadInput(page).setInputFiles({ name, mimeType: CSV_TYPE, buffer: Buffer.from(csv) });
    const firstRow = page.locator(`[data-upload-name="${name}"]`);
    await expect(firstRow).toBeVisible({ timeout: 60_000 });
    const firstId = (await firstRow.getAttribute('data-testid'))!.replace('upload-row-', '');
    await expect(page.getByTestId(`upload-status-${firstId}`)).toHaveText('Ready', { timeout: READY_MS });

    // Act 2 — the SAME bytes, uploaded into Project B's Uploads page (cross-study, same workspace).
    await switchProject(page, projectB);
    await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: 30_000 });
    const dupName = `${unique('dup')}.csv`;

    // Capture the raw finalize 409 to check the AXI-2618 label fix directly, independently of
    // the UI (see `captureFinalizeRefusal` — PATCH `.../finalize`, never the POST initiate call).
    const refusal409 = captureFinalizeRefusal(page);

    await uploadInput(page).setInputFiles({ name: dupName, mimeType: CSV_TYPE, buffer: Buffer.from(csv) });

    // Assert — refused as a cross-study duplicate (AXI-2538, unchanged), no row ever appears,
    // and "Use the existing file" is offered (AXI-2618/D12) since the cited dataset has NO row
    // in Project B's list (`hasRow` is false here — the "View it" anchor is correctly withheld).
    const refusal = page.getByTestId('upload-duplicate-refusal');
    await expect(refusal).toBeVisible({ timeout: READY_MS });
    await expect(refusal).toContainText('already uploaded');
    await expect(page.getByTestId('upload-duplicate-refusal-link')).toHaveCount(0);
    const useExisting = page.getByTestId('upload-duplicate-use-existing');
    await expect(useExisting).toBeVisible();
    await expect(page.locator(`[data-upload-name="${dupName}"]`)).toHaveCount(0);

    // AXI-2618/FR61 — HARD assertion (bounce #1, Opus review 2026-11-17: no soft/logged
    // variant — this is the one assertion the whole story exists to make true). First confirm
    // the listener actually caught the finalize 409 at all (a `null` body here means the capture
    // itself is broken, which must fail loudly rather than vacuously pass the label check below),
    // then assert the real fix: the gateway's OWN resolved reason phrase, never the stale
    // "InternalServerError" literal. Expected to FAIL against a gateway serving pre-merge `main`;
    // it is run post-merge once the gateway under test serves this story's backend branch.
    expect(refusal409.body()).not.toBeNull();
    expect((refusal409.body() as Record<string, unknown>).error).toBe('Conflict');

    // Act 3 — click "Use the existing file."
    await useExisting.click();

    // Assert — the refusal clears and the existing dataset is linked into Project B's list
    // without a second upload (the existing `projectsApi.linkDataset` route).
    await expect(refusal).toHaveCount(0, { timeout: READY_MS });
    await expect(page.getByTestId(`upload-row-${firstId}`)).toBeVisible({ timeout: READY_MS });
  });

  test('6a.2 — the Study page inline upload offers the same "use the existing file" action', async ({ page }) => {
    // Arrange — Project C already holds the dataset (via Project A's content reused here through
    // the API directly, independent of test 1's UI state), Project D has a finalised v2 declared
    // plan in state 3 ("waiting on data") per AXI-2602.
    const projectC = await newProject('C-source');
    const projectD = await newProject('D-target');

    // AXI-2618/D12: "use the existing file" links the dataset through
    // `projectsApi.linkDataset`, gated by `OwnUploadLinkGuard` — an Investigator may link
    // only a dataset HE uploaded himself. The seed must therefore be the INVESTIGATOR's own
    // upload (never `projectOwner`'s), matching the real scenario this bug describes.
    const token = String(Date.now());
    const csv = `subject_id,arm,score\nS${token}1,A,3.0\nS${token}2,B,4.7\n`;
    const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
    const init = await investigator.api.post(datasets, {
      data: { organizationId: world.orgId, originalFilename: `axi2618-${token}.csv`, contentType: CSV_TYPE },
    });
    expect(init.status(), await init.text()).toBeLessThan(300);
    const { dataset: created, presignedUrl } = await init.json();
    const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': CSV_TYPE }, body: csv });
    expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
    const finalize = await investigator.api.patch(`${datasets}/${created.id}/finalize`);
    expect(finalize.status(), await finalize.text()).toBeLessThan(300);
    const link = await investigator.api.post(apiUrl(`/api/v1/projects/${projectC}/datasets`), { data: { datasetId: created.id } });
    expect(link.status(), await link.text()).toBeLessThan(300);
    await expect
      .poll(
        async () => {
          const res = await investigator.api.get(`${datasets}/${created.id}`);
          return res.ok() ? (await res.json()).latestIngestion?.status ?? 'none' : 'none';
        },
        { timeout: READY_MS, intervals: [2_000, 5_000] },
      )
      .toBe('ready');

    // Build + finalise a minimal v2 declared plan for Project D so the Study page reads state 3.
    await signInInvestigator(page, projectD);
    await gotoSettled(page, `/investigator/projects/${projectD}/study/protocol`);
    await page.getByTestId('protocol-title').fill('AXI-2618 study');
    await page.getByTestId('protocol-objective').fill('Does arm change the score?');
    await page.getByTestId('protocol-study-population').fill(POPULATION);
    await page.getByTestId('protocol-save').click();
    await expect(page.getByTestId('protocol-unsaved')).toHaveCount(0, { timeout: 15_000 });

    await gotoSettled(page, `/investigator/projects/${projectD}/sap`);
    await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });

    // AXI-2657 (owner rulings 2026-11-18, superseding AXI-2564's "Create plan" form and
    // AXI-2589's post-AXI-2602 note this block carried about the Plan tab's own "Add question"):
    // the protocol leads straight to the questions — the first question starts the plan, and the
    // timing choice (so the data specification) follows it rather than preceding it.
    await page.getByTestId('sap-plan-add-primary-question').click();
    await expect(page.getByTestId('sap-add-question-modal')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('sap-add-question-text').fill('Does arm change the score?');
    await page.getByTestId('sap-add-question-role-primary').click();
    await page.getByTestId('sap-add-question-submit').click();
    await expect(page.getByTestId('sap-add-question-modal')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('sap-plan-timing-declared').check();
    await expect(page.getByTestId('sap-spec-editor')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('sap-spec-add-field').click();
    await page.getByTestId('sap-spec-field-0-name').fill('arm');
    await page.getByTestId('sap-spec-field-0-label').fill('Treatment arm');
    await page.getByTestId('sap-spec-field-0-role').selectOption('grouping_two_levels');
    await page.getByTestId('sap-spec-field-0-levels').fill('A, B');
    await page.getByTestId('sap-spec-add-field').click();
    await page.getByTestId('sap-spec-field-1-name').fill('score');
    await page.getByTestId('sap-spec-field-1-label').fill('Score');
    await page.getByTestId('sap-spec-save').click();
    await expect(page.getByTestId('sap-spec-field-1-name')).toHaveValue('score');

    await page.locator('[data-testid^="sap-plan-questions-row-"]').first().click();
    await expect(page.getByTestId('sap-spec-question-form')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('sap-spec-q-template').selectOption('T1');
    await page.getByTestId('sap-spec-q-slot-groupingColumn').selectOption({ label: 'arm — Treatment arm' });
    await page.getByTestId('sap-spec-q-slot-outcome').selectOption({ label: 'score — Score' });
    for (const key of ['population', 'variable', 'treatmentComparison', 'intercurrentEvents', 'populationSummary']) {
      await page.getByTestId(`sap-spec-q-estimand-${key}`).fill(`AXI-2618 ${key}`);
    }
    await page.getByTestId('sap-spec-q-alpha').fill('0.05');
    await page.getByTestId('sap-spec-q-save').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectD}/sap`));

    await expect.poll(async () => page.getByTestId('sap-finalise-open').isEnabled().catch(() => false), { timeout: 30_000 }).toBe(true);
    await page.getByTestId('sap-finalise-open').click();
    await expect(page.getByTestId('sap-finalise-dialog')).toBeVisible();
    await page.getByTestId('sap-finalise-confirm').click();
    await expect(page.getByTestId('sap-finalise-open')).toHaveCount(0, { timeout: 15_000 });

    // Act — open the Study page (state 3; `InvestigatorHome` is the bare `/investigator` index
    // route, with NO :projectId param — it lands on whichever project `useInvestigatorScope`
    // resolves, which defaults away from D the moment session has no "last project" hint for
    // it (the investigator can still reach Project A/C from earlier in this run). `switchProject`
    // sets that hint before navigating, the same fix 6a.1's cross-project switch needed) and
    // upload the SAME bytes inline.
    await switchProject(page, projectD, '/investigator');
    const refusal409 = captureFinalizeRefusal(page);
    const studyInput = page.getByTestId('study-upload-input');
    await studyInput.setInputFiles({ name: `${unique('study-dup')}.csv`, mimeType: CSV_TYPE, buffer: Buffer.from(csv) });

    // Assert — the Study page's own duplicate banner + "use the existing file" action render
    // inline (not only on the Uploads page). This `await` is what guarantees the upload chain
    // (init POST -> S3 PUT -> PATCH finalize) has actually completed — asserting on
    // `refusal409.body()` any earlier (bounce #2, Opus review 2026-11-17) races the network and
    // `body` is still `null`, failing `not.toBeNull()` on every run regardless of the fix.
    const studyDuplicate = page.getByTestId('study-upload-duplicate');
    await expect(studyDuplicate).toBeVisible({ timeout: READY_MS });

    // AXI-2618/FR61 — same HARD assertion as 6a.1, proving the label fix applies to the Study
    // page's inline upload too (it goes through the SAME `finalizeUpload`, never a second path).
    // Placed AFTER the awaited UI assertion above, never straight after `setInputFiles`.
    expect(refusal409.body()).not.toBeNull();
    expect((refusal409.body() as Record<string, unknown>).error).toBe('Conflict');

    const studyUseExisting = page.getByTestId('study-upload-use-existing');
    await expect(studyUseExisting).toBeVisible();
    await studyUseExisting.click();

    // Assert — the Study page proceeds past "waiting on data" without a second upload.
    await expect(studyDuplicate).toHaveCount(0, { timeout: READY_MS });
  });
});
