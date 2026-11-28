import { expect, test, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL, apiUrl } from '../../config/env';

/**
 * AXI-2809 (epic AXI-2802 — Semantic Profile Management, area A7; FR46, FR47, AC40, AC41).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md` § AXI-2809
 * (AXI-2809.1–AXI-2809.5).
 *
 * E2E CONTRACT — a real browser against a WORKTREE front-end (own Vite dev server, never the
 * shared :5173 demo front-end), signing itself in with injected tokens like
 * `AXI-2680-save-as-workflow.spec.ts`. The API is the DEMO gateway (`API_BASE_URL`, default
 * :3000). AXI-2809.1 runs against main's :3000, which still accepts the legacy
 * `semanticProfileId` on create (AXI-2813 ships on the story stack, not main) — it pins the
 * CURRENT front-end wire shape, which AXI-2813 (A4b) changed in the same epic: a 0/1 profile
 * selection now sends `semanticProfileIds` too, never the legacy single field, on create.
 *
 * Run: `BASE_URL=http://localhost:5174 npx playwright test tests/AXI-2802/AXI-2809-profile-pickers.spec.ts --project=axi-2809-profile-pickers`
 *
 * AXI-2813 (owner ruling 9, FR45) INVARIANT: create ALWAYS sends `semanticProfileIds`, never
 * `semanticProfileId` — AXI-2809.1 pins that at the network level (supersedes the pre-A4b
 * "legacy single field for 0/1" invariant this spec originally pinned).
 */

const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL ?? 'admin@cro-one.com';
const ADMIN_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'admin';
const WS = process.env.AXI2809_WORKSPACE_ID ?? '8946e06a-4fe6-45ee-8d9a-58f7142e803a'; // Mag4
const COMPOSING_A = 'immune_mediated';
const COMPOSING_B = 'immune_mediated_microbiota';
const CONFLICTING_A = 'immunology';
const CONFLICTING_B = 'oncology';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface Session { api: APIRequestContext; accessToken: string; refreshToken: string; userId: string }

async function login(email: string, password: string): Promise<Session> {
  const anon = await apiRequest.newContext();
  const res = await anon.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy();
  const { accessToken, refreshToken } = await res.json();
  await anon.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WS } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { api, accessToken, refreshToken, userId: me.id };
}

async function signInBrowser(page: Page, session: Session, orgId: string): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [session.accessToken, session.refreshToken, orgId, WS] as const,
  );
}

let admin: Session;
let orgId: string;
const createdProjectIds: string[] = [];

test.beforeAll(async () => {
  admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const ws = await (await admin.api.get(apiUrl(`/api/v1/workspaces/${WS}`))).json();
  orgId = ws.ownerOrganizationId;
  expect(orgId, 'workspace owner organization').toBeTruthy();
});

test.afterAll(async () => {
  for (const id of createdProjectIds) {
    await admin.api.delete(apiUrl(`/api/v1/projects/${id}`), { data: { performedBy: admin.userId } }).catch(() => undefined);
  }
  await admin?.api.dispose();
});

test.describe('AXI-2809 Multi-select profile pickers and displays @SI-030 @SI-031 @SI-032 @SI-033', () => {
  test('AXI-2809.1 — a single-profile project sends semanticProfileIds, never the legacy field (AXI-2813)', async ({ page }) => {
    await signInBrowser(page, admin, orgId);
    await page.goto(`${BASE_URL}/projects/new`);
    await expect(page.getByTestId('semantic-profile-picker-select')).toBeVisible({ timeout: 30_000 });

    await page.locator('input[placeholder="Enter project name"]').fill(`E2E AXI-2809 single ${Date.now()}`);
    await page.getByTestId('semantic-profile-picker-select').selectOption(COMPOSING_A);
    await expect(page.getByTestId('semantic-profile-picker-add-another')).toBeVisible();

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith('/api/v1/projects') && r.method() === 'POST'),
      page.getByRole('button', { name: /Create Project/i }).click(),
    ]);
    const body = req.postDataJSON();
    // AXI-2813 (owner ruling 9, FR45): create ALWAYS sends the list, never `semanticProfileId`.
    expect(body.semanticProfileId).toBeUndefined();
    expect(body.semanticProfileIds).toEqual([COMPOSING_A]);

    await page.waitForURL(/\/projects\/[0-9a-f-]+$/, { timeout: 30_000 });
    const id = page.url().split('/').pop()!;
    createdProjectIds.push(id);
    const project = await (await admin.api.get(apiUrl(`/api/v1/projects/${id}`))).json();
    expect(project.semanticProfileIds).toEqual([COMPOSING_A]);
  });

  test('AXI-2809.2 (AC41) — composing two profiles sends semanticProfileIds and shows the composite', async ({ page }) => {
    await signInBrowser(page, admin, orgId);
    await page.goto(`${BASE_URL}/projects/new`);
    await page.locator('input[placeholder="Enter project name"]').fill(`E2E AXI-2809 composed ${Date.now()}`);
    await page.getByTestId('semantic-profile-picker-select').selectOption(COMPOSING_A);
    await page.getByTestId('semantic-profile-picker-add-another').click();
    await expect(page.getByTestId('semantic-profiles-picker-list')).toBeVisible();
    await page.getByTestId(`semantic-profile-picker-checkbox-${COMPOSING_B}`).check();

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith('/api/v1/projects') && r.method() === 'POST'),
      page.getByRole('button', { name: /Create Project/i }).click(),
    ]);
    const body = req.postDataJSON();
    expect(body.semanticProfileId).toBeUndefined();
    expect(new Set(body.semanticProfileIds)).toEqual(new Set([COMPOSING_A, COMPOSING_B]));

    await page.waitForURL(/\/projects\/[0-9a-f-]+$/, { timeout: 30_000 });
    const id = page.url().split('/').pop()!;
    createdProjectIds.push(id);
    const project = await (await admin.api.get(apiUrl(`/api/v1/projects/${id}`))).json();
    expect(new Set(project.semanticProfileIds)).toEqual(new Set([COMPOSING_A, COMPOSING_B]));

    await page.getByRole('tab', { name: /Semantic Profile/i }).click();
    await expect(page.getByTestId('semantic-profile-tab-members')).toBeVisible({ timeout: 30_000 });
  });

  test('AXI-2809.3 (AC40) — a refused combination lists every issue before save', async ({ page }) => {
    await signInBrowser(page, admin, orgId);
    await page.goto(`${BASE_URL}/projects/new`);
    await page.locator('input[placeholder="Enter project name"]').fill(`E2E AXI-2809 refused ${Date.now()}`);
    await page.getByTestId('semantic-profile-picker-select').selectOption(CONFLICTING_A);
    await page.getByTestId('semantic-profile-picker-add-another').click();
    await page.getByTestId(`semantic-profile-picker-checkbox-${CONFLICTING_B}`).check();

    await page.getByRole('button', { name: /Create Project/i }).click();
    await expect(page.getByTestId('semantic-profile-picker-errors')).toBeVisible({ timeout: 30_000 });
    // still on the create page — no navigation to a new project happened.
    expect(page.url()).toContain('/projects/new');
  });

  // AXI-2809.4 (AC41, SI-033) — Project Settings → General: a single-profile project is
  // grown to a composed selection; the PATCH carries the list field and the "will recompute"
  // warning is shown before Save. Exercises the PATCH /profile path (distinct from create).
  test('AXI-2809.4 — Settings grows a single profile to a composed selection via PATCH', async ({ page }) => {
    // Seed a single-profile project through the API (restored in afterAll).
    const created = await admin.api.post(apiUrl('/api/v1/projects'), {
      data: { name: `E2E AXI-2809 settings ${Date.now()}`, workspaceId: WS, createdBy: admin.userId, semanticProfileIds: [COMPOSING_A] },
    });
    expect(created.ok(), `seed project: ${created.status()}`).toBeTruthy();
    const id = (await created.json()).id as string;
    createdProjectIds.push(id);

    await signInBrowser(page, admin, orgId);
    await page.goto(`${BASE_URL}/projects/${id}/settings`);
    const select = page.getByTestId('semantic-profile-picker-select');
    await expect(select).toBeVisible({ timeout: 30_000 });
    await expect(select).toHaveValue(COMPOSING_A);
    // Nothing changed yet — no recompute warning.
    await expect(page.getByTestId('semantic-profile-picker-warning')).toHaveCount(0);

    await page.getByTestId('semantic-profile-picker-add-another').click();
    await page.getByTestId(`semantic-profile-picker-checkbox-${COMPOSING_B}`).check();
    // Changing the selection shows the recompute warning before Save.
    await expect(page.getByTestId('semantic-profile-picker-warning')).toBeVisible();

    const [req] = await Promise.all([
      page.waitForRequest((r) => /\/api\/v1\/projects\/[0-9a-f-]+\/profile$/.test(r.url()) && r.method() === 'PATCH'),
      page.getByTestId('project-settings-general-save').click(),
    ]);
    const body = req.postDataJSON();
    expect(new Set(body.profileIds)).toEqual(new Set([COMPOSING_A, COMPOSING_B]));
    expect(body.profileId).toBeUndefined();

    await expect.poll(async () => {
      const p = await (await admin.api.get(apiUrl(`/api/v1/projects/${id}`))).json();
      return new Set(p.semanticProfileIds);
    }, { timeout: 30_000 }).toEqual(new Set([COMPOSING_A, COMPOSING_B]));
  });

  // AXI-2809.5 (AC41, SI-032) — the Investigator "+ New study" dialog offers the same
  // multi-select. The dialog lives behind the investigator surface (SurfaceGate
  // expected="investigator") and its "+ New study" footer is gated on project:create in an
  // investigator workspace. The only login this environment provides is the team-surface
  // admin, so the test opens the investigator surface and, when that affordance is not
  // reachable for this account, skips with a precise reason rather than fabricate a pass.
  // The compose path itself is the SHARED SemanticProfilesPicker + createStudyPayload already
  // pinned at the network level by AXI-2809.2 and by unit UT-INVESTIGATOR-2809-001/002.
  test('AXI-2809.5 — Investigator New study offers the same multi-select', async ({ page }) => {
    await signInBrowser(page, admin, orgId);
    await page.goto(`${BASE_URL}/investigator/home`);
    await page.waitForLoadState('networkidle');
    const onInvestigator = page.url().includes('/investigator');
    const newStudy = page.getByText('New study', { exact: true });
    const reachable = onInvestigator && (await newStudy.count()) > 0;
    test.skip(!reachable, 'No Investigator-surface login in this environment (admin@cro-one.com resolves to the team surface; the "+ New study" footer is gated on project:create inside an investigator workspace). Compose path is covered by AXI-2809.2 and UT-INVESTIGATOR-2809-001/002.');

    await newStudy.first().click();
    await expect(page.getByTestId('new-study-semantic-profile')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('new-study-name').fill(`E2E AXI-2809 study ${Date.now()}`);
    await page.getByTestId('semantic-profile-picker-select').selectOption(COMPOSING_A);
    await page.getByTestId('semantic-profile-picker-add-another').click();
    await page.getByTestId(`semantic-profile-picker-checkbox-${COMPOSING_B}`).check();
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith('/api/v1/projects') && r.method() === 'POST'),
      page.getByTestId('new-study-create').click(),
    ]);
    const body = req.postDataJSON();
    expect(new Set(body.semanticProfileIds)).toEqual(new Set([COMPOSING_A, COMPOSING_B]));
    if (body.id) createdProjectIds.push(body.id);
  });
});
