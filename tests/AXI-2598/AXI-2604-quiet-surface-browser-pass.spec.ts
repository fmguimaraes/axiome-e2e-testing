import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';

/**
 * AXI-2604 (epic AXI-2598 — Investigator Handover): the quiet surface's browser half (FR28,
 * FR29, FR30) — the landing rule, the onboarding gate, and "no flash of a previous state" —
 * exercised through the real UI, the browser counterpart to AXI-2601/AXI-2612's API-only
 * `rehearsal.ts` walk.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md` § 8 (8.1-8.3). § 8.4
 * (FR38 funnel events observed over the wire) and the NFR2/AC21 timing threshold are manual —
 * see the doc for why (both owed after a real run completes; AC21's threshold is owner-gated,
 * OQ-6).
 *
 * E2E CONTRACT — real setup throughout (same `PrivateProjectsWorld` shape as AXI-2602/AXI-2603):
 * a real org/workspace/project, a real Investigator-role member, the demo gateway, `main`. No
 * SAP plan is created here — the landing rule (FR28/EC12), the onboarding gate (FR29) and the
 * no-flash rule (FR30) all hold at state 1 (no plan yet) just as much as at any later state, and
 * skipping plan authoring keeps this suite fast and focused on what AXI-2604 actually added.
 *
 * Never a trace/video/screenshot (NFR6/NFR4) — a trace would hold the investigator's bearer
 * token; `storageState` is opted out the same way AXI-2602/AXI-2603 do.
 */

test.use({ storageState: { cookies: [], origins: [] }, trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2604-e2e-pw!';

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;
let projectId: string;

// Copied verbatim from `AXI-2602-study-page.spec.ts` (AXI-2602, merged to main; AXI-2622 fixed
// the Run-dialog click this file does not need). Not exported there, so it is duplicated here —
// a lead FYI during this story flagged that exact file as off-limits to edit (to avoid
// conflicting with the AXI-2622 developer fixing it in parallel); it has since merged. Kept as a
// deliberate, commented duplication rather than a shared-module extraction, which is out of this
// story's ownership boundary (touching AXI-2602's spec file).
async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2604-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2604', lastName: label } });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function newProject(label: string): Promise<string> {
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2604 ${label} ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const grant = await access.grant(projectOwner, id, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  return id;
}

/**
 * Signs the investigator in through the REAL login form with NO pre-seeded `localStorage`
 * org/workspace/project and no `axiome-investigator-last-*` sessionStorage — unlike
 * AXI-2602/AXI-2603's `signInInvestigator`, which pre-seeds those exactly to bypass the landing
 * rule under test here. He has exactly one workspace and one project (EC12), so the landing
 * rule (`useInvestigatorScope`'s count rule, FR28) must resolve both on its own.
 */
async function signInFresh(page: Page): Promise<void> {
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  projectId = await newProject('quiet-path');
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await projectOwner?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2604 Quiet investigator path: landing, onboarding gate, no flash @SI-066 @SI-030 @SI-038 @SI-042', () => {
  test('AXI-2604.1 AC3/AC14 FR28/EC12 — one workspace, one project: lands directly on the Study page, never a picker', async ({ page }) => {
    // Act
    await signInFresh(page);

    // Assert: the landing rule resolved both levels on its own (no pre-seeded storage) and the
    // Study page rendered — never the "choose your study" selector a second workspace/project
    // would show (EC12's "or the picker" branch does not apply: he has exactly one of each).
    await expect(page.getByTestId('investigator-surface')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('investigator-choose-scope')).toHaveCount(0);
    await expect(page.getByTestId('investigator-no-study')).toHaveCount(0);
    await expect(page.getByTestId('investigator-home')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('study-status-block')).toBeVisible({ timeout: 30_000 });
  });

  test('AXI-2604.2 AC14 FR29 — no onboarding tour, help beacon or first-run overlay appears anywhere on the path', async ({ page }) => {
    // Act
    await signInFresh(page);
    await expect(page.getByTestId('study-status-block')).toBeVisible({ timeout: 30_000 });

    // Assert: structurally impossible, not just absent today — `OnboardingHostGate` is mounted
    // only in the team route tree (`App.tsx`), never under `/investigator/*`, so none of
    // react-joyride's DOM (overlay, spotlight, portal) or the help beacon can be present.
    await expect(page.locator('.react-joyride__overlay, .react-joyride__spotlight, #react-joyride-portal')).toHaveCount(0);
    await expect(page.getByTestId('debug-mode-badge')).toHaveCount(0); // sanity: team-shell chrome absent too
  });

  test('AXI-2604.3 AC14 FR30 — no step shows a previous state before the current one settles', async ({ page }) => {
    // Act: sample `data-study-state` tightly for a couple of seconds right after landing.
    await signInFresh(page);
    const block = page.getByTestId('study-status-block');
    await expect(block).toBeVisible({ timeout: 30_000 });
    const seen = new Set<string | null>();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      seen.add(await block.getAttribute('data-study-state'));
      await page.waitForTimeout(100);
    }

    // Assert: exactly one state value was ever observed once the block existed — no flicker
    // through an earlier/wrong state before settling (FR30).
    expect([...seen]).toEqual([[...seen][0]]);
  });
});
